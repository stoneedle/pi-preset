package server

import (
	"errors"
	"net/http"

	"pi-web/internal/chat"
)

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	req, err := chat.ParseRequest(r, chat.DefaultMaxImageBytes, chat.DefaultMaxRequestBytes)
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, chat.ErrImageTooLarge) || errors.As(err, new(*http.MaxBytesError)) {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSONError(w, status, err.Error())
		return
	}
	reply, err := s.executors.Control(r.Context(), resolved, map[string]any{"action": "send", "chat": req})
	if err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, reply)
}

func (s *Server) handleCancelChat(w http.ResponseWriter, r *http.Request) {
	s.handleControl(w, r, map[string]any{"action": "abort"})
}

func (s *Server) handleControl(w http.ResponseWriter, r *http.Request, action map[string]any) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	reply, err := s.executors.Control(r.Context(), resolved, action)
	if err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, 0, reply)
}

func (s *Server) handleSessionStatus(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	header, err := s.cache.ResolveHeader(s.sessionsDir, id)
	if resolveOrWriteError(w, err) {
		return
	}
	if snapshot := s.runtimeState(id); snapshot.Availability == "connected" && snapshot.SessionID == header.Session.SessionUUID {
		writeJSON(w, 0, snapshot)
		return
	}
	resolved, err := s.cache.ResolveMetadata(s.sessionsDir, id)
	if resolveOrWriteError(w, err) {
		return
	}
	writeJSON(w, 0, s.sessionSnapshot(resolved.Session.SessionSummary))
}

func (s *Server) handleCommands(w http.ResponseWriter, r *http.Request) {
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	reply, err := s.executors.Control(r.Context(), resolved, map[string]any{"action": "commands"})
	if err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, 0, reply)
}

func (s *Server) handleSetModel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Provider string `json:"provider"`
		ModelID  string `json:"modelId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Provider == "" || body.ModelID == "" {
		writeJSONError(w, http.StatusBadRequest, "provider and modelId required")
		return
	}
	s.handleControl(w, r, map[string]any{"action": "model", "provider": body.Provider, "modelId": body.ModelID})
}

func (s *Server) handleSetSpeed(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Mode != "off" && body.Mode != "fast" && body.Mode != "ultrafast" {
		writeJSONError(w, 400, "invalid speed")
		return
	}
	s.handleControl(w, r, map[string]any{"action": "speed", "mode": body.Mode})
}

func (s *Server) handleSetThinkingLevel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Level string `json:"level"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	valid := map[string]bool{"off": true, "minimal": true, "low": true, "medium": true, "high": true, "xhigh": true}
	if !valid[body.Level] {
		writeJSONError(w, http.StatusBadRequest, "invalid thinking level")
		return
	}
	s.handleControl(w, r, map[string]any{"action": "thinking", "level": body.Level})
}
