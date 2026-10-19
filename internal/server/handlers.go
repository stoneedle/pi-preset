package server

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"pi-web/internal/agentdir"
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

func (s *Server) handleApiSessions(w http.ResponseWriter, r *http.Request) {
	summaries, err := s.loadSummaries()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q"))); query != "" {
		filtered := summaries[:0]
		for _, summary := range summaries {
			if strings.Contains(strings.ToLower(summary.Name+" "+summary.Project+" "+summary.ID), query) {
				filtered = append(filtered, summary)
			}
		}
		summaries = filtered
	}
	sessions.SortSummariesByActivity(summaries)
	total := len(summaries)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 {
		limit = 30
	}
	limit = min(limit, 100)
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	offset = max(0, min(offset, total))
	items := make([]map[string]any, 0, limit)
	for _, summary := range summaries[offset:min(total, offset+limit)] {
		items = append(items, map[string]any{
			"id": summary.ID, "name": summary.Name, "project": summary.Project,
			"state": s.sessionState(summary.ID), "replyId": summary.LastReplyID,
		})
	}
	writeJSON(w, 0, map[string]any{"sessions": items, "total": total})
}

func (s *Server) handleApiSession(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.cache.Resolve(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	q := r.URL.Query()
	window := sessions.MessageWindow(resolved.Session.Entries, q.Get("before"), q.Get("after"))
	writeJSON(w, 0, map[string]any{
		"id": resolved.Session.ID, "name": resolved.Session.Name,
		"cwd": resolved.Session.Header["cwd"], "window": window,
		"chatAvailable":      resolved.Session.ChatAvailable,
		"chatDisabledReason": resolved.Session.ChatDisabledReason,
	})
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
	resolved, err := s.cache.Resolve(s.sessionsDir, id)
	if resolveOrWriteError(w, err) {
		return
	}
	if s.chatSender == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "Pi is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()
	if err := s.chatSender.EnsureWorker(ctx, id, resolved.Path); err != nil {
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
	resolved, err := s.cache.Resolve(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	reply, err := s.controlSession(r.Context(), resolved, map[string]any{"action": "models"})
	if err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, 0, reply)
}

func (s *Server) handleCustomThemes(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(agentdir.WebDir(s.agentDir), "custom-themes.css")
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	if _, err := os.Stat(path); err == nil {
		http.ServeFile(w, r, path)
	}
}

func isBrokenPipe(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "broken pipe") || strings.Contains(err.Error(), "connection reset by peer"))
}
