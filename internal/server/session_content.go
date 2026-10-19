package server

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"

	"pi-web/internal/sessions"
)

func (s *Server) handleSessionBlock(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.cache.Resolve(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	index, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil || index < 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid block index")
		return
	}
	block, err := sessions.BlockContent(resolved.Session.Entries, r.URL.Query().Get("entry"), index)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 0, block)
}

func (s *Server) handleSessionImage(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.cache.Resolve(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	index, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil || index < 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid block index")
		return
	}
	data, mime, err := sessions.ImageContent(resolved.Session.Entries, r.URL.Query().Get("entry"), index)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, err.Error())
		return
	}
	body, err := base64.StdEncoding.DecodeString(data)
	if err != nil || !strings.HasPrefix(mime, "image/") || mime == "image/svg+xml" {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid image")
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	_, _ = w.Write(body)
}
