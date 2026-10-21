package server

import (
	"context"
	"errors"
	"net/http"

	"pi-web/internal/chat"
	"pi-web/internal/sessions"
	"pi-web/internal/workers"
)

type ChatSender interface {
	Send(ctx context.Context, sessionID, sessionPath string, chat chat.Request) error
	SetModel(ctx context.Context, sessionID, sessionPath, provider, modelID string) error
	SetThinkingLevel(ctx context.Context, sessionID, sessionPath, level string) error
	Abort(ctx context.Context, sessionID string) error
	GetState(ctx context.Context, sessionID string) (workers.WorkerStatus, error)
	GetCommands(ctx context.Context, sessionID string) ([]workers.SlashCommand, bool, error)
	Status(sessionID string) workers.WorkerStatus
	EnsureWorker(ctx context.Context, sessionID, sessionPath string) error
	HasWorker(sessionID string) bool
}

func (s *Server) controlSession(ctx context.Context, resolved sessions.ResolvedSession, action map[string]any) (map[string]any, error) {
	owner, err := s.remoteOwner(resolved.Session)
	if err != nil {
		return nil, err
	}
	if owner != nil {
		action["sessionId"] = resolved.Session.SessionUUID
		return owner.call(ctx, action)
	}
	if s.chatSender == nil || !s.chatSender.HasWorker(resolved.Session.ID) {
		return nil, errors.New("no connected Pi instance; explicitly continue this session first")
	}
	id, path := resolved.Session.ID, resolved.Path
	switch action["action"] {
	case "send":
		req := action["chat"].(chat.Request)
		err = s.chatSender.Send(ctx, id, path, req)
	case "abort":
		err = s.chatSender.Abort(ctx, id)
	case "model":
		err = s.chatSender.SetModel(ctx, id, path, action["provider"].(string), action["modelId"].(string))
	case "thinking":
		err = s.chatSender.SetThinkingLevel(ctx, id, path, action["level"].(string))
	case "speed":
		return nil, errors.New("当前 Pi 未提供速度控制桥接")
	case "models":
		return map[string]any{"models": []any{}}, nil
	case "commands":
		commands, _, commandErr := s.chatSender.GetCommands(ctx, id)
		skills := make([]workers.SlashCommand, 0)
		for _, command := range commands {
			if command.Source == "skill" {
				skills = append(skills, command)
			}
		}
		return map[string]any{"commands": skills}, commandErr
	}
	return map[string]any{"status": "accepted"}, err
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	if !resolved.Session.ChatAvailable {
		owner, ownerErr := s.remoteOwner(resolved.Session)
		if ownerErr != nil || owner == nil {
			writeJSONError(w, http.StatusConflict, resolved.Session.ChatDisabledReason)
			return
		}
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
	reply, err := s.controlSession(r.Context(), resolved, map[string]any{"action": "send", "chat": req})
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
	reply, err := s.controlSession(r.Context(), resolved, action)
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
	reply, err := s.controlSession(r.Context(), resolved, map[string]any{"action": "commands"})
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
