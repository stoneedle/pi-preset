package server

import (
	"context"
	"errors"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"pi-web/internal/sessions"
)

func resolveOrWriteError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, sessions.ErrInvalidSessionID):
		writeJSONError(w, http.StatusBadRequest, "invalid session id")
	case errors.Is(err, sessions.ErrSessionNotFound):
		writeJSONError(w, http.StatusNotFound, "session not found")
	default:
		writeJSONError(w, http.StatusInternalServerError, err.Error())
	}
	return true
}

func (s *Server) handleGitInfo(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.cache.Resolve(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	cwd, _ := resolved.Session.Header["cwd"].(string)
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "git", "-C", cwd, "branch", "--show-current").Output()
	branch := ""
	if err == nil {
		branch = strings.TrimSpace(string(output))
	}
	writeJSON(w, 0, map[string]any{"branch": branch})
}
