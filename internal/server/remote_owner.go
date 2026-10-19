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
	"strconv"
	"strings"
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
	if json.Unmarshal(data, &owner) != nil || owner.Port < 1 || owner.Port > 65535 || owner.PID <= 0 || owner.Token == "" || owner.SessionID != session.SessionUUID {
		return nil, errors.New("invalid session owner")
	}
	return &owner, nil
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

// Process existence only prevents a second executor; it never determines activity.
func (s *Server) sessionProcessExists(ctx context.Context, id string) (bool, error) {
	files, err := filepath.Glob(filepath.Join(s.sessionStatusDir(), id+".*.json"))
	if err != nil {
		return false, err
	}
	for _, file := range files {
		suffix := strings.TrimPrefix(filepath.Base(file), id+".")
		pid, err := strconv.ParseInt(strings.TrimSuffix(suffix, ".json"), 10, 32)
		if err != nil || pid <= 0 {
			return false, errors.New("invalid session process registration")
		}
		alive, err := process.PidExistsWithContext(ctx, int32(pid))
		if err != nil || alive {
			return alive, err
		}
	}
	return false, nil
}

func (s *Server) handleContinueSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := s.cache.Resolve(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	if !resolved.Session.ChatAvailable || s.chatSender == nil {
		writeJSONError(w, http.StatusConflict, "session cannot be continued")
		return
	}
	if s.chatSender.HasWorker(resolved.Session.ID) {
		writeJSON(w, 0, map[string]any{"ok": true})
		return
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
	if alive, err := s.sessionProcessExists(r.Context(), resolved.Session.ID); err != nil || alive {
		writeJSONError(w, http.StatusConflict, "Pi is still open for this session; reload its pi-web extension instead of creating a second instance")
		return
	}
	if err := s.chatSender.EnsureWorker(r.Context(), resolved.Session.ID, resolved.Path); err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, 0, map[string]any{"ok": true})
}
