package server

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"pi-web/internal/workers"
)

func TestRuntimeSubscriptionSeparatesActivityFromConnection(t *testing.T) {
	s := newTestServer(t)
	writeSessionFile(t, s.sessionsDir, "--runtime--", "session.jsonl")
	var mu sync.Mutex
	snapshot := runtimeSnapshot{ID: "session.jsonl", SessionID: "sid", InstanceID: "instance", State: "running", MainRunning: true}
	listeners := make(map[chan runtimeSnapshot]bool)
	ownerHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			w.WriteHeader(401)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/snapshot") {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		updates := make(chan runtimeSnapshot, 8)
		mu.Lock()
		listeners[updates] = true
		initial := snapshot
		mu.Unlock()
		defer func() { mu.Lock(); delete(listeners, updates); mu.Unlock() }()
		write := func(value runtimeSnapshot) {
			data, _ := json.Marshal(value)
			fmt.Fprintf(w, "data: %s\n\n", data)
			w.(http.Flusher).Flush()
		}
		write(initial)
		for {
			select {
			case value := <-updates:
				write(value)
			case <-r.Context().Done():
				return
			}
		}
	}))
	defer ownerHTTP.Close()
	defer ownerHTTP.CloseClientConnections()
	_, port, _ := net.SplitHostPort(ownerHTTP.Listener.Addr().String())
	n, _ := strconv.Atoi(port)
	directory := filepath.Join(s.agentDir, "pi-web", "owners")
	os.MkdirAll(directory, 0700)
	data, _ := json.Marshal(workers.Registration{PID: int32(os.Getpid()), Port: n, Token: "secret", SessionID: "sid"})
	os.WriteFile(filepath.Join(directory, "session.jsonl.json"), data, 0600)
	waitState := func(expected string) {
		t.Helper()
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			if s.sessionState("session.jsonl") == expected {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("state=%s want=%s", s.sessionState("session.jsonl"), expected)
	}
	waitState("running")
	for _, state := range []string{"background", "needs-you", "idle"} {
		mu.Lock()
		snapshot.State = state
		snapshot.Revision++
		snapshot.MainRunning = false
		zero := 0
		snapshot.Children = &zero
		for listener := range listeners {
			listener <- snapshot
		}
		mu.Unlock()
		waitState(state)
	}
	if s.runtimeState("session.jsonl").Availability != "connected" {
		t.Fatal("native idle snapshot was not connected")
	}
	ownerHTTP.CloseClientConnections()
	waitState("unknown")
	if s.runtimeState("session.jsonl").Availability != "disconnected" {
		t.Fatal("disconnect remained connected")
	}
	if _, err := os.Stat(filepath.Join(s.agentDir, "session-status")); !os.IsNotExist(err) {
		t.Fatal("old activity directory was created")
	}
}

func TestDurableAcknowledgementIsResultScopedAndPassive(t *testing.T) {
	s := newTestServer(t)
	writeConversation(t, s.sessionsDir, []map[string]any{
		{"role": "user", "content": "question"},
		{"role": "assistant", "stopReason": "stop", "content": "first"},
		{"role": "assistant", "stopReason": "stop", "content": "second"},
	})
	content, err := s.cache.OpenContent(s.sessionsDir, "mobile.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	window, err := content.Window("", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	replies := []string{}
	for _, message := range window.Messages {
		if message.Role == "assistant" {
			replies = append(replies, message.ID)
		}
	}
	for _, id := range []string{replies[0], replies[0]} {
		r := httptest.NewRequest("POST", "/api/session/acknowledge?id=mobile.jsonl", strings.NewReader(`{"replyId":"`+id+`"}`))
		w := httptest.NewRecorder()
		s.handleAcknowledgement(w, r)
		if w.Code != 200 {
			t.Fatalf("ack=%d %s", w.Code, w.Body.String())
		}
	}
	current := s.sessionSnapshot(content.SessionSummary)
	if current.Unread == nil || !*current.Unread {
		t.Fatal("old acknowledgement cleared a later result")
	}
	var count int
	s.db.QueryRow(`SELECT COUNT(*) FROM session_results WHERE acknowledged=1`).Scan(&count)
	if count != 1 {
		t.Fatalf("duplicate confirmation created %d rows", count)
	}
	if current.CanControl || current.Availability != "disconnected" || current.State != "unknown" {
		t.Fatal("reading history created execution evidence")
	}
}
