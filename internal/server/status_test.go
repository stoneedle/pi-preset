package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeHeartbeat(t *testing.T, s *Server, id, pid, state string, updated time.Time) {
	t.Helper()
	if err := os.MkdirAll(s.sessionStatusDir(), 0755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(sessionStatusFile{ID: id, State: state, UpdatedAt: updated.Format(time.RFC3339Nano)})
	if err := os.WriteFile(filepath.Join(s.sessionStatusDir(), id+"."+pid+".json"), data, 0644); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeStateUsesRealHeartbeatNotConversationWrites(t *testing.T) {
	for _, state := range []string{"running", "background", "needs-you", "idle"} {
		t.Run(state, func(t *testing.T) {
			now := time.Now()
			s := &Server{agentDir: t.TempDir(), now: func() time.Time { return now }}
			writeHeartbeat(t, s, "session.jsonl", "123", state, now)
			if got := s.sessionState("session.jsonl"); got != state {
				t.Fatalf("state=%s want %s", got, state)
			}
		})
	}
	s := &Server{agentDir: t.TempDir(), now: time.Now, fileMod: map[string]time.Time{"session.jsonl": time.Now()}}
	if got := s.sessionState("session.jsonl"); got != "unknown" {
		t.Fatalf("file write guessed activity: %s", got)
	}
	writeHeartbeat(t, s, "session.jsonl", "123", "running", time.Now().Add(-time.Minute))
	if got := s.sessionState("session.jsonl"); got != "unknown" {
		t.Fatalf("stale state became %s", got)
	}
	writeHeartbeat(t, s, "session.jsonl", "123", "running", time.Now())
	writeHeartbeat(t, s, "session.jsonl", "456", "idle", time.Now())
	if got := s.sessionState("session.jsonl"); got != "unknown" {
		t.Fatalf("ambiguous owners became %s", got)
	}
}

func TestHeartbeatExpiryBroadcastsUnknownNotCompletion(t *testing.T) {
	now := time.Now()
	s := &Server{agentDir: t.TempDir(), now: func() time.Time { return now }}
	writeHeartbeat(t, s, "session.jsonl", "123", "running", now)
	client := s.addClient(globalSessID)
	defer s.removeClient(client)
	s.sweepStatusOnce()
	first := <-client.ch
	if !strings.Contains(first, `"state":"running"`) {
		t.Fatalf("unexpected start: %s", first)
	}
	now = now.Add(time.Minute)
	s.sweepStatusOnce()
	select {
	case message := <-client.ch:
		if !strings.Contains(message, `"state":"unknown"`) {
			t.Fatalf("expiry faked completion: %s", message)
		}
	case <-time.After(time.Second):
		t.Fatal("missing stale-state event")
	}
}
