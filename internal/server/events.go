package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	sessID := r.URL.Query().Get("id")
	if sessID == "" {
		http.Error(w, "missing id", 400)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	client := s.addClient(sessID)
	defer s.removeClient(client)

	fmt.Fprintf(w, ":ok\n\n")
	flusher.Flush()

	s.writeStatusSnapshot(w)
	flusher.Flush()

	for {
		select {
		case msg, open := <-client.ch:
			if !open {
				return
			}
			if key := eventKey(msg); key != "" {
				client.mu.Lock()
				delete(client.queued, key)
				client.mu.Unlock()
			}
			if strings.HasPrefix(msg, "event: ") {
				// Already-formatted named SSE event; pass through with the
				// terminating blank line.
				fmt.Fprint(w, msg+"\n\n")
			} else {
				fmt.Fprintf(w, "data: %s\n\n", msg)
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) writeStatusSnapshot(w http.ResponseWriter) {
	s.lastKnownMu.Lock()
	states := make(map[string]string, len(s.lastStates))
	for id, state := range s.lastStates {
		states[id] = state
	}
	s.lastKnownMu.Unlock()
	data, _ := json.Marshal(states)
	fmt.Fprintf(w, "event: status-snapshot\ndata: %s\n\n", data)
}
