package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type syncRecorder struct {
	*httptest.ResponseRecorder
	mu     sync.Mutex
	output strings.Builder
}

func (w *syncRecorder) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.output.Write(data)
}
func (w *syncRecorder) body() string { w.mu.Lock(); defer w.mu.Unlock(); return w.output.String() }

func TestSessionAndIndexReceiveTruthfulStateSnapshot(t *testing.T) {
	for _, topic := range []string{"__all__", "session.jsonl"} {
		t.Run(topic, func(t *testing.T) {
			s := &Server{lastStates: map[string]string{"session.jsonl": "background"}}
			r := httptest.NewRequest("GET", "/events?id="+topic, nil)
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			w := &syncRecorder{ResponseRecorder: httptest.NewRecorder()}
			done := make(chan struct{})
			go func() { s.handleEvents(w, r.WithContext(ctx)); close(done) }()
			deadline := time.Now().Add(time.Second)
			for !strings.Contains(w.body(), "status-snapshot") && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			cancel()
			<-done
			if !strings.Contains(w.body(), `"session.jsonl":"background"`) {
				t.Fatalf("snapshot: %s", w.body())
			}
		})
	}
}
