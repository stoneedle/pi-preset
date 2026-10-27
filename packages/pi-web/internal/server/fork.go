package server

import (
	"context"
	"net/http"
	"time"

	"pi-web/internal/rpc"
)

func (s *Server) handleForkSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		EntryID string `json:"entryId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()
	reply, err := s.executors.Fork(ctx, resolved, func(leaf *string) (map[string]any, error) {
		content, err := s.cache.OpenContent(s.sessionsDir, resolved.Session.ID)
		if err != nil {
			return nil, err
		}
		entryID, err := content.ForkPoint(body.EntryID, leaf)
		if err != nil {
			return nil, err
		}
		return rpc.ForkSessionFile(ctx, resolved.Path, resolved.Session.SessionUUID, entryID, content.Name)
	})
	if err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	s.broadcast(globalSessID, "new-session")
	writeJSON(w, http.StatusCreated, reply)
}
