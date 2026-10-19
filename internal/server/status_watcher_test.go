package server

import (
	"strings"
	"testing"
	"time"
)

func TestSessionStatusWatcherReadsPerProcessHeartbeats(t *testing.T) {
	s := newTestServer(t)
	client := s.addClient(globalSessID)
	defer s.removeClient(client)
	writeHeartbeat(t, s, "session.jsonl", "123", "needs-you", time.Now())
	deadline := time.After(3 * time.Second)
	for {
		select {
		case msg := <-client.ch:
			if strings.Contains(msg, `"state":"needs-you"`) {
				return
			}
		case <-deadline:
			t.Fatal("no native heartbeat state reached the browser")
		}
	}
}
