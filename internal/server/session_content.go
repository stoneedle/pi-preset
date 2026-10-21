package server

import (
	"encoding/base64"
	"errors"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"pi-web/internal/sessions"
)

func (s *Server) handleSessionBlock(w http.ResponseWriter, r *http.Request) {
	content, err := s.cache.OpenContent(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	index, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil || index < 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid block index")
		return
	}
	block, err := content.Block(r.URL.Query().Get("entry"), index, s.activeLeaf(content.SessionSummary))
	if errors.Is(err, sessions.ErrBlockNotFound) {
		writeJSONError(w, http.StatusNotFound, err.Error())
		return
	}
	if resolveOrWriteError(w, err) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 0, block)
}

func (s *Server) handleSessionImage(w http.ResponseWriter, r *http.Request) {
	content, err := s.cache.OpenContent(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	index, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil || index < 0 {
		writeJSONError(w, http.StatusBadRequest, "invalid block index")
		return
	}
	data, mediaType, err := content.Image(r.URL.Query().Get("entry"), index, s.activeLeaf(content.SessionSummary))
	if errors.Is(err, sessions.ErrImageNotFound) {
		writeJSONError(w, http.StatusNotFound, err.Error())
		return
	}
	if resolveOrWriteError(w, err) {
		return
	}
	body, err := base64.StdEncoding.DecodeString(data)
	if err != nil || !strings.HasPrefix(mediaType, "image/") || mediaType == "image/svg+xml" {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid image")
		return
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if r.URL.Query().Get("download") == "1" {
		extension := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif"}[mediaType]
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": "image" + extension}))
		w.Header().Set("Cache-Control", "no-store")
	}
	_, _ = w.Write(body)
}
