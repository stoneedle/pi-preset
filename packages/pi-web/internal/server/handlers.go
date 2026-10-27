package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"pi-web/internal/sessions"
)

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	s.handleAppShell(w, r)
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) { s.handleAppShell(w, r) }

func (s *Server) handleApiSession(w http.ResponseWriter, r *http.Request) {
	content, err := s.cache.OpenContent(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	q := r.URL.Query()
	var window sessions.Window
	leaf := s.activeLeaf(content.SessionSummary)
	if q.Get("around") != "" || q.Get("forward") != "" {
		window, err = content.Locate(q.Get("around"), q.Get("forward"), q.Get("after"), q["fallback"], leaf)
	} else {
		window, err = content.Window(q.Get("before"), q.Get("after"), leaf)
	}
	if resolveOrWriteError(w, err) {
		return
	}
	writeJSON(w, 0, map[string]any{
		"id": content.ID, "name": content.Name,
		"cwd": content.CWD, "window": window,
		"chatAvailable":      content.ChatAvailable,
		"chatDisabledReason": content.ChatDisabledReason,
	})
}

func (s *Server) activeLeaf(summary sessions.SessionSummary) *string {
	runtime := s.runtimeState(summary.ID)
	if runtime.Availability == "connected" && runtime.SessionID == summary.SessionUUID {
		if runtime.LeafID != nil {
			return runtime.LeafID
		}
		empty := ""
		return &empty
	}
	return nil
}

func (s *Server) handleNewSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	id, err := sessions.CreateSessionFile(s.sessionsDir, body.Path)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, id)
	if resolveOrWriteError(w, err) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()
	if err := s.executors.Ensure(ctx, resolved); err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, 0, map[string]any{"id": id})
}

func (s *Server) handleRecentLocations(w http.ResponseWriter, r *http.Request) {
	locations, err := sessions.ListRecentLocations(s.sessionsDir)
	if err != nil {
		locations = []string{}
	}
	writeJSON(w, 0, map[string]any{"locations": locations})
}

func (s *Server) handleAvailableModels(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	reply, err := s.executors.Control(r.Context(), resolved, map[string]any{"action": "models"})
	if err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, 0, reply)
}

func isBrokenPipe(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "broken pipe") || strings.Contains(err.Error(), "connection reset by peer"))
}
