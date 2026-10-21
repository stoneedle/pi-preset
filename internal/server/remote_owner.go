package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/shirou/gopsutil/v4/process"
	"pi-web/internal/sessions"
)

type remoteOwner struct {
	PID       int32  `json:"pid"`
	Port      int    `json:"port"`
	Token     string `json:"token"`
	SessionID string `json:"sessionId"`
}

func (s *Server) remoteOwner(session sessions.Session) (*remoteOwner, error) {
	file := filepath.Join(s.agentDir, "pi-web", "owners", session.ID+".json")
	data, err := readRuntimeFile(file)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var owner remoteOwner
	if json.Unmarshal(data, &owner) != nil || !owner.valid() || owner.SessionID != session.SessionUUID {
		return nil, errors.New("invalid session owner")
	}
	return &owner, nil
}

func (owner remoteOwner) valid() bool {
	return owner.Port > 0 && owner.Port <= 65535 && owner.PID > 0 && owner.Token != "" && owner.SessionID != ""
}

func (owner *remoteOwner) call(ctx context.Context, payload any) (map[string]any, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/remote", owner.Port), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+owner.Token)
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("session owner unavailable: %w", err)
	}
	defer resp.Body.Close()
	var reply map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&reply); err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("session owner: %v", reply["error"])
	}
	return reply, nil
}

func (s *Server) handleContinueSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	if !resolved.Session.ChatAvailable || s.chatSender == nil {
		writeJSONError(w, http.StatusConflict, "session cannot be continued")
		return
	}
	if s.chatSender.HasWorker(resolved.Session.ID) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		_, stateErr := s.chatSender.GetState(ctx, resolved.Session.ID)
		cancel()
		if stateErr == nil && s.chatSender.HasWorker(resolved.Session.ID) {
			writeJSON(w, 0, map[string]any{"ok": true})
			return
		}
		if s.chatSender.HasWorker(resolved.Session.ID) {
			writeJSONError(w, http.StatusBadGateway, "Pi has not confirmed that it is ready; retry after reconnecting")
			return
		}
	}
	owner, err := s.remoteOwner(resolved.Session)
	if err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	if owner != nil {
		alive, err := process.PidExistsWithContext(r.Context(), owner.PID)
		if err != nil || alive {
			writeJSONError(w, http.StatusConflict, "session already has an owner; reconnect to that instance")
			return
		}
	}
	if err := s.chatSender.EnsureWorker(r.Context(), resolved.Session.ID, resolved.Path); err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, 0, map[string]any{"ok": true})
}
