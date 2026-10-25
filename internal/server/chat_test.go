package server

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"

	"pi-web/internal/chat"
	"pi-web/internal/workers"
)

type testWorker struct{ sent atomic.Int32 }

func (w *testWorker) Prompt(context.Context, chat.Request) error   { w.sent.Add(1); return nil }
func (*testWorker) SetModel(context.Context, string, string) error { return nil }
func (*testWorker) SetThinkingLevel(context.Context, string) error { return nil }
func (*testWorker) Abort(context.Context) error                    { return nil }
func (*testWorker) GetState(context.Context) (workers.WorkerStatus, error) {
	return workers.WorkerStatus{State: workers.WorkerStateIdle, Model: "test"}, nil
}
func (*testWorker) GetCommands(context.Context) ([]workers.SlashCommand, error) { return nil, nil }
func (*testWorker) Status() workers.WorkerStatus {
	return workers.WorkerStatus{State: workers.WorkerStateIdle, Model: "test"}
}
func (*testWorker) Close() error { return nil }

func chatRequest() *http.Request {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	writer.WriteField("message", "hello from phone")
	writer.Close()
	r := httptest.NewRequest("POST", "/api/chat?id=mobile.jsonl", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	return r
}

func TestOpeningIsPassiveAndSendingStartsAndReusesOneExecutor(t *testing.T) {
	s := newTestServer(t)
	writeConversation(t, s.sessionsDir, []map[string]any{{"role": "user", "content": "history"}})
	var created atomic.Int32
	worker := &testWorker{}
	_ = s.executors.Close()
	s.executors = workers.NewManager(func(string, string) (workers.ChatWorker, error) { created.Add(1); return worker, nil }, s.agentDir)
	for _, handler := range []http.HandlerFunc{s.handleApiSession, s.handleSessionStatus} {
		w := httptest.NewRecorder()
		handler(w, httptest.NewRequest("GET", "/api/session?id=mobile.jsonl", nil))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	if created.Load() != 0 {
		t.Fatal("reading started an executor")
	}
	for send := int32(1); send <= 2; send++ {
		w := httptest.NewRecorder()
		s.handleChat(w, chatRequest())
		if w.Code != http.StatusAccepted || created.Load() != 1 || worker.sent.Load() != send {
			t.Fatalf("send %d did not start/reuse one worker: %d %s", send, w.Code, w.Body.String())
		}
	}
}

func TestAllControlsGoToTheRegisteredPiInstance(t *testing.T) {
	s := newTestServer(t)
	writeConversation(t, s.sessionsDir, []map[string]any{{"role": "user", "content": "history"}})
	var created atomic.Int32
	_ = s.executors.Close()
	s.executors = workers.NewManager(func(string, string) (workers.ChatWorker, error) { created.Add(1); return &testWorker{}, nil }, s.agentDir)
	var actions []string
	ownerHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer owner-secret" {
			t.Error("missing owner authentication")
		}
		var input map[string]any
		json.NewDecoder(r.Body).Decode(&input)
		if input["sessionId"] != "sid" {
			t.Error("wrong native session")
		}
		actions = append(actions, input["action"].(string))
		if input["action"] == "send" {
			req := input["chat"].(map[string]any)
			if _, exists := req["delivery"]; exists {
				t.Error("message still exposes a selectable delivery mode")
			}
		}
		writeJSON(w, 0, map[string]any{"status": "accepted"})
	}))
	defer ownerHTTP.Close()
	_, port, _ := net.SplitHostPort(ownerHTTP.Listener.Addr().String())
	n, _ := strconv.Atoi(port)
	dir := filepath.Join(s.agentDir, "pi-web", "owners")
	os.MkdirAll(dir, 0700)
	data, _ := json.Marshal(workers.Registration{PID: int32(os.Getpid()), Port: n, Token: "owner-secret", SessionID: "sid"})
	os.WriteFile(filepath.Join(dir, "mobile.jsonl.json"), data, 0600)
	for _, item := range []struct {
		handler http.HandlerFunc
		request *http.Request
	}{
		{s.handleChat, chatRequest()},
		{s.handleCancelChat, httptest.NewRequest("POST", "/api/chat/cancel?id=mobile.jsonl", nil)},
		{s.handleSetModel, httptest.NewRequest("POST", "/api/set-model?id=mobile.jsonl", bytes.NewBufferString(`{"provider":"test","modelId":"m"}`))},
		{s.handleSetThinkingLevel, httptest.NewRequest("POST", "/api/set-thinking-level?id=mobile.jsonl", bytes.NewBufferString(`{"level":"high"}`))},
		{s.handleCommands, httptest.NewRequest("GET", "/api/commands?id=mobile.jsonl", nil)},
	} {
		w := httptest.NewRecorder()
		item.handler(w, item.request)
		if w.Code < 200 || w.Code >= 300 {
			t.Fatalf("owner control: %d %s", w.Code, w.Body.String())
		}
	}
	if created.Load() != 0 || len(actions) != 5 {
		t.Fatalf("not same-instance control: created=%d actions=%v", created.Load(), actions)
	}
	ownerHTTP.Close()
	w := httptest.NewRecorder()
	s.handleChat(w, chatRequest())
	if w.Code != http.StatusConflict || created.Load() != 0 || len(actions) != 5 {
		t.Fatal("an unreachable live owner created a competing executor or replayed the message")
	}
	if err := os.Remove(filepath.Join(dir, "mobile.jsonl.json")); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	s.handleChat(w, chatRequest())
	if w.Code < 400 || created.Load() != 0 {
		t.Fatal("a missing registration for a known live process created a duplicate")
	}
	data, _ = json.Marshal(workers.Registration{PID: 2147483647, Port: n, Token: "owner-secret", SessionID: "sid"})
	os.WriteFile(filepath.Join(dir, "mobile.jsonl.json"), data, 0600)
	w = httptest.NewRecorder()
	s.handleChat(w, chatRequest())
	if w.Code != http.StatusAccepted || created.Load() != 1 {
		t.Fatalf("a dead owner prevented recovery on send: %d %s", w.Code, w.Body.String())
	}
}
