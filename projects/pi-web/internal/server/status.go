package server

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pi-web/internal/sessions"
	"pi-web/internal/workers"
)

type runtimeSnapshot struct {
	ID            string          `json:"id"`
	Name          string          `json:"name,omitempty"`
	SessionID     string          `json:"sessionId"`
	InstanceID    string          `json:"instanceId,omitempty"`
	Revision      int64           `json:"revision"`
	State         string          `json:"state"`
	Availability  string          `json:"availability"`
	MainRunning   bool            `json:"mainRunning"`
	Children      *int            `json:"children"`
	ReplyID       string          `json:"replyId"`
	LeafID        *string         `json:"leafId"`
	Unread        *bool           `json:"unread"`
	Completed     bool            `json:"completed"`
	Outcome       string          `json:"outcome,omitempty"`
	AttentionID   string          `json:"attentionId,omitempty"`
	AttentionKind string          `json:"attentionKind,omitempty"`
	CanControl    bool            `json:"canControl"`
	CanQueue      bool            `json:"canQueue"`
	CWD           string          `json:"cwd,omitempty"`
	ChatAvailable bool            `json:"chatAvailable"`
	Model         string          `json:"model,omitempty"`
	ModelName     string          `json:"modelName,omitempty"`
	Provider      string          `json:"provider,omitempty"`
	Thinking      string          `json:"thinking,omitempty"`
	Context       json.RawMessage `json:"context,omitempty"`
	Usage         json.RawMessage `json:"usage,omitempty"`
	CacheHit      *float64        `json:"cacheHit"`
	Fast          any             `json:"fast"`
	Diagnostic    string          `json:"diagnostic,omitempty"`
}

type ownerObservation struct {
	owner  workers.Registration
	cancel context.CancelFunc
}

func (s *Server) runtimeState(id string) runtimeSnapshot {
	s.lastKnownMu.Lock()
	defer s.lastKnownMu.Unlock()
	if snapshot, ok := s.runtimeStates[id]; ok {
		return snapshot
	}
	return runtimeSnapshot{ID: id, State: "unknown", Availability: "disconnected"}
}

func (s *Server) sessionState(id string) string { return s.runtimeState(id).State }

func (s *Server) publishRuntime(id string, owner workers.Registration, snapshot runtimeSnapshot) {
	s.lastKnownMu.Lock()
	observation, ok := s.observations[id]
	if !ok || observation.owner != owner {
		s.lastKnownMu.Unlock()
		return
	}
	s.executors.Observe(id, owner)
	if s.runtimeStates == nil {
		s.runtimeStates = make(map[string]runtimeSnapshot)
	}
	previous, _ := json.Marshal(s.runtimeStates[id])
	next, _ := json.Marshal(snapshot)
	if string(previous) == string(next) {
		s.lastKnownMu.Unlock()
		return
	}
	s.runtimeStates[id] = snapshot
	s.lastKnownMu.Unlock()
	msg := "event: status-delta\ndata: " + string(next)
	s.broadcast(globalSessID, msg)
	s.broadcast(id, msg)
	if s.push != nil {
		if err := s.push.observe(snapshot); err != nil {
			log.Printf("push event could not be persisted: %v", err)
		}
	}
}

// Discovery records only locate an owner. Their timestamps never determine activity.
func (s *Server) discoverOwners(ctx context.Context) {
	files, _ := os.ReadDir(filepath.Join(s.agentDir, "pi-web", "owners"))
	found := make(map[string]workers.Registration)
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl.json") {
			continue
		}
		id := strings.TrimSuffix(file.Name(), ".json")
		owner, err := workers.ReadRegistration(filepath.Join(s.agentDir, "pi-web", "owners", file.Name()))
		if err != nil {
			continue
		}
		found[id] = owner
	}
	s.lastKnownMu.Lock()
	for id, observation := range s.observations {
		if found[id] != observation.owner {
			observation.cancel()
			delete(s.observations, id)
			snapshot := s.runtimeStates[id]
			snapshot.ID, snapshot.State, snapshot.Availability, snapshot.CanControl = id, "unknown", "disconnected", false
			s.runtimeStates[id] = snapshot
			s.executors.Observe(id, observation.owner)
			data, _ := json.Marshal(snapshot)
			s.broadcast(globalSessID, "event: status-delta\ndata: "+string(data))
			s.broadcast(id, "event: status-delta\ndata: "+string(data))
		}
	}
	for id, owner := range found {
		if _, ok := s.observations[id]; ok {
			continue
		}
		ownerCtx, cancel := context.WithCancel(ctx)
		s.observations[id] = ownerObservation{owner, cancel}
		s.wg.Add(1)
		go func(id string, owner workers.Registration) { defer s.wg.Done(); s.observeOwner(ownerCtx, id, owner) }(id, owner)
	}
	s.lastKnownMu.Unlock()
}

func (s *Server) runOwnerDiscovery() {
	defer s.wg.Done()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.discoverOwners(ctx)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.discoverOwners(ctx)
		case <-s.stopCh:
			return
		}
	}
}

func (s *Server) observeOwner(ctx context.Context, id string, owner workers.Registration) {
	for ctx.Err() == nil {
		err := s.readOwnerStream(ctx, id, owner)
		if ctx.Err() != nil {
			return
		}
		snapshot := s.runtimeState(id)
		snapshot.ID, snapshot.State, snapshot.Availability, snapshot.CanControl = id, "unknown", "disconnected", false
		if err != nil {
			snapshot.Diagnostic = err.Error()
		}
		s.publishRuntime(id, owner, snapshot)
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return
		}
	}
}

func (s *Server) readOwnerStream(ctx context.Context, id string, owner workers.Registration) error {
	header, err := s.cache.ResolveHeader(s.sessionsDir, id)
	if err != nil || header.Session.SessionUUID != owner.SessionID {
		return fmt.Errorf("runtime owner does not match native session header")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// A missed transport keepalive invalidates availability only, never execution or completion.
	deadline := time.AfterFunc(45*time.Second, cancel)
	defer deadline.Stop()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/snapshot?sessionId=%s", owner.Port, owner.SessionID), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+owner.Token)
	client := &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 3 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("runtime subscription returned HTTP %d", response.StatusCode)
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 64<<10)
	for scanner.Scan() {
		deadline.Reset(45 * time.Second)
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var snapshot runtimeSnapshot
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &snapshot); err != nil {
			return err
		}
		if snapshot.ID != id || snapshot.SessionID != owner.SessionID || snapshot.InstanceID == "" {
			return fmt.Errorf("runtime subscription identity mismatch")
		}
		switch snapshot.State {
		case "running", "background", "needs-you", "idle", "unknown":
		default:
			return fmt.Errorf("invalid runtime activity")
		}
		snapshot.Availability, snapshot.CanControl = "connected", true
		s.publishRuntime(id, owner, snapshot)
	}
	if scanner.Err() != nil {
		return scanner.Err()
	}
	return fmt.Errorf("runtime connection closed")
}

func (s *Server) sessionSnapshot(summary sessions.SessionSummary) runtimeSnapshot {
	snapshot := s.runtimeState(summary.ID)
	if snapshot.Availability == "connected" && snapshot.SessionID == summary.SessionUUID {
		return snapshot
	}
	if snapshot.SessionID != summary.SessionUUID {
		snapshot = runtimeSnapshot{State: "unknown", Availability: "disconnected"}
	}
	snapshot.ID, snapshot.SessionID, snapshot.ReplyID = summary.ID, summary.SessionUUID, summary.LastReplyID
	snapshot.CWD, snapshot.ChatAvailable = summary.Project, summary.ChatAvailable
	snapshot.Unread = nil
	snapshot.Completed = false
	if summary.LastReplyID != "" && s.db != nil {
		acknowledged, completed := 0, 0
		err := s.db.QueryRow(`SELECT acknowledged,completed FROM session_results WHERE session_id=? AND result_id=?`, summary.SessionUUID, summary.LastReplyID).Scan(&acknowledged, &completed)
		if err == nil || err == sql.ErrNoRows {
			unread := acknowledged == 0
			snapshot.Unread = &unread
			snapshot.Completed = completed != 0
		}
	}
	return snapshot
}

func (s *Server) handleAcknowledgement(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var body struct {
		ReplyID string `json:"replyId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	observed := s.runtimeState(resolved.Session.ID)
	if observed.Availability != "connected" || observed.SessionID != resolved.Session.SessionUUID {
		resolved, err = s.cache.ResolveMetadata(s.sessionsDir, resolved.Session.ID)
		if resolveOrWriteError(w, err) {
			return
		}
	}
	current := s.sessionSnapshot(resolved.Session.SessionSummary)
	if body.ReplyID == "" || body.ReplyID != current.ReplyID {
		// Delayed confirmations can record only their exact native result, never a newer result.
		content, err := s.cache.OpenContent(s.sessionsDir, resolved.Session.ID)
		if resolveOrWriteError(w, err) {
			return
		}
		if !content.HasResult(body.ReplyID) {
			writeJSONError(w, 409, "unknown result identity")
			return
		}
	}
	_, err = s.db.Exec(`INSERT INTO session_results(session_id,result_id,acknowledged) VALUES(?,?,1) ON CONFLICT(session_id,result_id) DO UPDATE SET acknowledged=1`, resolved.Session.SessionUUID, body.ReplyID)
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	_, _ = s.executors.Control(ctx, resolved, map[string]any{"action": "acknowledge", "replyId": body.ReplyID})
	current = s.sessionSnapshot(resolved.Session.SessionSummary)
	if current.ReplyID == body.ReplyID {
		unread := false
		current.Unread = &unread
	}
	data, _ := json.Marshal(current)
	s.broadcast(globalSessID, "event: status-delta\ndata: "+string(data))
	s.broadcast(current.ID, "event: status-delta\ndata: "+string(data))
	writeJSON(w, 0, current)
}
