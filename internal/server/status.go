package server

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"time"

	"pi-web/internal/workers"
)

const sessionStatusTTL = 10 * time.Second

type sessionStatusFile struct {
	ID        string `json:"id"`
	State     string `json:"state"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *Server) sessionState(id string) string {
	if id == "" || filepath.Base(id) != id || strings.ContainsAny(id, "*?[]\\/") {
		return "unknown"
	}
	files, err := filepath.Glob(filepath.Join(s.sessionStatusDir(), id+".*.json"))
	if err != nil {
		return "unknown"
	}
	now := time.Now()
	if s.now != nil {
		now = s.now()
	}
	state, owners := "", 0
	for _, file := range files {
		data, err := readRuntimeFile(file)
		if err != nil {
			continue
		}
		var status sessionStatusFile
		if json.Unmarshal(data, &status) != nil || status.ID != id {
			continue
		}
		updated, err := time.Parse(time.RFC3339Nano, status.UpdatedAt)
		if err != nil || now.Sub(updated) > sessionStatusTTL || updated.Sub(now) > sessionStatusTTL {
			continue
		}
		switch status.State {
		case "running", "background", "needs-you", "idle":
			state = status.State
			owners++
		}
	}
	if owners > 1 {
		return "unknown"
	}
	if owners == 1 {
		return state
	}
	if len(files) > 0 {
		return "unknown"
	}
	if s.chatSender != nil {
		status := s.chatSender.Status(id)
		if status.State == workers.WorkerStateRunning || status.State == workers.WorkerStateError {
			return string(status.State)
		}
	}
	return "unknown"
}

func (s *Server) RuntimeIdle(id string) bool { return s.sessionState(id) == "idle" }

func (s *Server) recomputeAndBroadcastStatus(id string) {
	if id == "" {
		return
	}
	state := s.sessionState(id)
	s.lastKnownMu.Lock()
	if s.lastStates == nil {
		s.lastStates = make(map[string]string)
	}
	previous := s.lastStates[id]
	if previous == state {
		s.lastKnownMu.Unlock()
		return
	}
	s.lastStates[id] = state
	s.lastKnownMu.Unlock()
	data, _ := json.Marshal(map[string]any{"id": id, "state": state})
	msg := "event: status-delta\ndata: " + string(data)
	s.broadcast(globalSessID, msg)
	s.broadcast(id, msg)
}
