package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pi-web/internal/sessions"
)

func writeConversation(t *testing.T, root string, messages []map[string]any) string {
	t.Helper()
	dir := filepath.Join(root, "project")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "mobile.jsonl")
	var lines strings.Builder
	header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": "sid", "cwd": root})
	lines.Write(header)
	lines.WriteByte('\n')
	var parent any
	for i, message := range messages {
		id := fmt.Sprintf("entry-%04d", i)
		line, err := json.Marshal(map[string]any{"type": "message", "id": id, "parentId": parent, "message": message})
		if err != nil {
			t.Fatal(err)
		}
		lines.Write(line)
		lines.WriteByte('\n')
		parent = id
	}
	if err := os.WriteFile(file, []byte(lines.String()), 0644); err != nil {
		t.Fatal(err)
	}
	return file
}

func sessionRequest(t *testing.T, s *Server, suffix string) (sessions.Window, string) {
	t.Helper()
	w := httptest.NewRecorder()
	s.handleApiSession(w, httptest.NewRequest(http.MethodGet, "/api/session?id=mobile.jsonl"+suffix, nil))
	if w.Code != 200 {
		t.Fatalf("session: %d %s", w.Code, w.Body.String())
	}
	var response struct {
		Window sessions.Window `json:"window"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response.Window, w.Body.String()
}

func TestMobileWindowNeverTransfersFoldedBodies(t *testing.T) {
	root := t.TempDir()
	large := strings.Repeat("folded-private-payload", 100000)
	writeConversation(t, root, []map[string]any{
		{"role": "user", "content": []any{map[string]any{"type": "text", "text": "hello"}, map[string]any{"type": "image", "data": large, "mimeType": "image/png"}}},
		{"role": "assistant", "content": []any{map[string]any{"type": "thinking", "thinking": large}, map[string]any{"type": "toolCall", "id": "call1", "name": "bash", "arguments": map[string]any{"command": "ls", "hidden": large}}}},
		{"role": "toolResult", "toolCallId": "call1", "content": []any{map[string]any{"type": "text", "text": large}}},
		{"role": "assistant", "stopReason": "stop", "content": []any{map[string]any{"type": "text", "text": "complete answer"}}},
	})
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}
	window, raw := sessionRequest(t, s, "")
	if strings.Contains(raw, "folded-private-payload") || len(raw) > 4096 {
		t.Fatalf("initial response leaked folded bodies: %d bytes", len(raw))
	}
	if len(window.Messages) != 3 || !strings.Contains(raw, "complete answer") {
		t.Fatalf("ordinary messages missing: %s", raw)
	}
	for _, block := range []struct {
		entry    string
		index    int
		expected string
	}{
		{"entry-0001", 0, large}, {"entry-0001", 1, large},
	} {
		w := httptest.NewRecorder()
		s.handleSessionBlock(w, httptest.NewRequest("GET", fmt.Sprintf("/api/session/block?id=mobile.jsonl&entry=%s&index=%d", block.entry, block.index), nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), block.expected) {
			t.Fatalf("expanded body incomplete: %d", w.Code)
		}
	}
}

func TestMobileWindowKeepsLongOrdinaryReplyWhole(t *testing.T) {
	root := t.TempDir()
	answer := strings.Repeat("正文不能为了速度而截断。", 12000)
	writeConversation(t, root, []map[string]any{{"role": "assistant", "stopReason": "stop", "content": []any{map[string]any{"type": "text", "text": answer}}}})
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}
	window, _ := sessionRequest(t, s, "")
	if len(window.Messages) != 1 || window.Messages[0].Blocks[0].Text != answer {
		t.Fatal("ordinary reply was truncated")
	}
}

func TestMobileHistoryAndIncrementalToolCompletion(t *testing.T) {
	root := t.TempDir()
	messages := make([]map[string]any, 100)
	for i := range messages {
		messages[i] = map[string]any{"role": "user", "content": fmt.Sprintf("message %d", i)}
	}
	file := writeConversation(t, root, messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}
	window, _ := sessionRequest(t, s, "")
	if len(window.Messages) != 30 || window.Before == "" {
		t.Fatalf("unbounded window: %+v", window)
	}
	all := append([]sessions.ViewMessage{}, window.Messages...)
	for window.Before != "" {
		window, _ = sessionRequest(t, s, "&before="+window.Before)
		all = append(window.Messages, all...)
	}
	if len(all) != 100 {
		t.Fatalf("history has %d messages", len(all))
	}
	for i, message := range all {
		if message.ID != fmt.Sprintf("entry-%04d", i) {
			t.Fatalf("history order at %d: %s", i, message.ID)
		}
	}
	initial, _ := sessionRequest(t, s, "")
	f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(`{"type":"message","id":"call-entry","parentId":"entry-0099","message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-1","name":"read","arguments":{"path":"file.txt"}}]}}` + "\n")
	f.Close()
	incremental, _ := sessionRequest(t, s, "&after="+initial.Cursor)
	if len(incremental.Messages) != 1 || incremental.Messages[0].Blocks[0].State != "pending" {
		t.Fatalf("delta includes history: %+v", incremental)
	}
	f, err = os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(`{"type":"message","id":"result-entry","parentId":"call-entry","message":{"role":"toolResult","toolCallId":"tool-1","content":[{"type":"text","text":"not sent until expanded"}]}}` + "\n")
	f.Close()
	changed, raw := sessionRequest(t, s, "&after="+incremental.Cursor)
	if len(changed.Messages) != 1 || changed.Messages[0].ID != "call-entry" || changed.Messages[0].Blocks[0].State != "done" || strings.Contains(raw, "not sent until expanded") {
		t.Fatalf("tool completion delta: %s", raw)
	}
	unchanged, _ := sessionRequest(t, s, "&after="+changed.Cursor)
	if len(unchanged.Messages) != 0 {
		t.Fatal("unchanged reload retransmitted messages")
	}
}
