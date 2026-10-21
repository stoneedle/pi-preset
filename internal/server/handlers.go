package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

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
	completed := make(map[string]int64)
	if s.db != nil {
		rows, err := s.db.Query("SELECT session_id, MAX(completed_at) FROM session_results WHERE completed=1 GROUP BY session_id")
		if err != nil {
			writeJSONError(w, 500, err.Error())
			return
		}
		for rows.Next() {
			var id string
			var at int64
			if err := rows.Scan(&id, &at); err != nil {
				rows.Close()
				writeJSONError(w, 500, err.Error())
				return
			}
			completed[id] = at
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			writeJSONError(w, 500, err.Error())
			return
		}
		rows.Close()
	}
	sortTime := func(summary sessions.SessionSummary) int64 {
		at, _ := time.Parse(time.RFC3339Nano, summary.CreatedAt)
		return max(at.UnixMilli(), completed[summary.SessionUUID])
	}
	sort.SliceStable(summaries, func(i, j int) bool {
		if sortTime(summaries[i]) != sortTime(summaries[j]) {
			return sortTime(summaries[i]) > sortTime(summaries[j])
		}
		return summaries[i].ID > summaries[j].ID
	})
	acknowledged := make(map[string]bool)
	if s.db != nil {
		keys := make([]map[string]string, 0, len(summaries))
		for _, summary := range summaries {
			if summary.LastReplyID != "" {
				keys = append(keys, map[string]string{"sessionId": summary.SessionUUID, "replyId": summary.LastReplyID})
			}
		}
		encoded, _ := json.Marshal(keys)
		rows, err := s.db.Query(`SELECT r.session_id,r.result_id FROM json_each(?) AS item JOIN session_results r ON r.session_id=json_extract(item.value,'$.sessionId') AND r.result_id=json_extract(item.value,'$.replyId') WHERE r.acknowledged=1`, string(encoded))
		if err != nil {
			writeJSONError(w, 500, err.Error())
			return
		}
		for rows.Next() {
			var sessionID, resultID string
			if err := rows.Scan(&sessionID, &resultID); err != nil {
				rows.Close()
				writeJSONError(w, 500, err.Error())
				return
			}
			acknowledged[sessionID+"\x00"+resultID] = true
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			writeJSONError(w, 500, err.Error())
			return
		}
		rows.Close()
	}
	projects := make(map[string]map[string]any)
	for _, summary := range summaries {
		project := projects[summary.Project]
		if project == nil {
			project = map[string]any{"path": summary.Project, "count": 0, "lastActivity": "", "unread": false}
			projects[summary.Project] = project
		}
		project["count"] = project["count"].(int) + 1
		unread := s.db != nil && summary.LastReplyID != "" && !acknowledged[summary.SessionUUID+"\x00"+summary.LastReplyID]
		live := s.runtimeState(summary.ID)
		if live.Availability == "connected" && live.SessionID == summary.SessionUUID {
			unread = live.Unread != nil && *live.Unread
		}
		if unread {
			project["unread"] = true
		}
		if summary.LastActivity > project["lastActivity"].(string) {
			project["lastActivity"] = summary.LastActivity
		}
	}
	projectList := make([]map[string]any, 0, len(projects))
	for _, project := range projects {
		projectList = append(projectList, project)
	}
	if path := r.URL.Query().Get("project"); path != "" {
		filtered := summaries[:0]
		for _, summary := range summaries {
			if summary.Project == path {
				filtered = append(filtered, summary)
			}
		}
		summaries = filtered
	}
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
		snapshot := s.sessionSnapshot(summary)
		items = append(items, map[string]any{
			"id": summary.ID, "name": summary.Name, "project": summary.Project,
			"lastActivity": summary.LastActivity, "sortTime": sortTime(summary),
			"state": snapshot.State, "replyId": snapshot.ReplyID, "unread": snapshot.Unread,
			"runtime": snapshot,
		})
	}
	writeJSON(w, 0, map[string]any{"sessions": items, "total": total, "projects": projectList})
}

func (s *Server) handleApiSession(w http.ResponseWriter, r *http.Request) {
	content, err := s.cache.OpenContent(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	q := r.URL.Query()
	window, err := content.Window(q.Get("before"), q.Get("after"), s.activeLeaf(content.SessionSummary))
	if resolveOrWriteError(w, err) {
		return
	}
	writeJSON(w, 0, map[string]any{
		"id": content.ID, "name": content.Name,
		"cwd": content.CWD, "window": window,
		"chatAvailable":      content.ChatAvailable,
		"chatDisabledReason": content.ChatDisabledReason,
	})
}

func (s *Server) activeLeaf(summary sessions.SessionSummary) *string {
	runtime := s.runtimeState(summary.ID)
	if runtime.Availability == "connected" && runtime.SessionID == summary.SessionUUID {
		if runtime.LeafID != nil {
			return runtime.LeafID
		}
		empty := ""
		return &empty
	}
	return nil
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
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, id)
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
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
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

func isBrokenPipe(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "broken pipe") || strings.Contains(err.Error(), "connection reset by peer"))
}
