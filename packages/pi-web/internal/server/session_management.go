package server

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"pi-web/internal/rpc"
	"pi-web/internal/sessions"
)

type managedSession struct {
	sessions.SessionSummary
	Archived        bool
	ProjectArchived bool
	createdAt       int64
}

type managedProject struct {
	Path         string `json:"path"`
	Archived     bool   `json:"archived"`
	Count        int    `json:"count"`
	LastActivity string `json:"lastActivity"`
	Unread       bool   `json:"unread"`
	Revision     string `json:"revision"`
}

// Management changes never rewrite conversation history or native execution state.
func (s *Server) managedSessions() ([]managedSession, error) {
	summaries, err := s.loadSummaries()
	if err != nil {
		return nil, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	archived := make(map[string]bool)
	rows, err := tx.Query("SELECT session_id,archived FROM session_management")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var value bool
		if err := rows.Scan(&id, &value); err != nil {
			rows.Close()
			return nil, err
		}
		archived[id] = value
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	projects := make(map[string]bool)
	rows, err = tx.Query("SELECT project,archived FROM project_management")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var path string
		var value bool
		if err := rows.Scan(&path, &value); err != nil {
			rows.Close()
			return nil, err
		}
		projects[path] = value
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, summary := range summaries {
		// A new native session revives its project; activity in archived sessions does not.
		if projects[summary.Project] && !archived[summary.SessionUUID] {
			if _, err := tx.Exec("UPDATE project_management SET archived=0 WHERE project=?", summary.Project); err != nil {
				return nil, err
			}
			projects[summary.Project] = false
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	items := make([]managedSession, 0, len(summaries))
	for _, summary := range summaries {
		created, _ := time.Parse(time.RFC3339Nano, summary.CreatedAt)
		items = append(items, managedSession{SessionSummary: summary, Archived: archived[summary.SessionUUID], ProjectArchived: projects[summary.Project], createdAt: created.UnixMilli()})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].createdAt != items[j].createdAt {
			return items[i].createdAt > items[j].createdAt
		}
		return items[i].ID > items[j].ID
	})
	return items, nil
}

func (s *Server) handleApiSessions(w http.ResponseWriter, r *http.Request) {
	items, err := s.managedSessions()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	acknowledged := make(map[string]bool)
	keys := make([]map[string]string, 0, len(items))
	for _, item := range items {
		if item.LastReplyID != "" {
			keys = append(keys, map[string]string{"sessionId": item.SessionUUID, "replyId": item.LastReplyID})
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
	err = rows.Err()
	rows.Close()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	projects := make(map[string]*managedProject)
	versions := make(map[string][]string)
	selected := make([]managedSession, 0, len(items))
	archived := r.URL.Query().Get("archived") == "true"
	activeOnly := r.URL.Query().Get("active") == "true" && !archived
	path := r.URL.Query().Get("project")
	for _, item := range items {
		if (!archived && item.ProjectArchived) || (archived && !item.Archived) {
			continue
		}
		if query != "" && (!strings.Contains(strings.ToLower(item.Name+" "+item.Project+" "+item.ID), query) || (item.Archived != archived && !strings.Contains(strings.ToLower(item.Project), query))) {
			continue
		}
		unread := item.LastReplyID != "" && !acknowledged[item.SessionUUID+"\x00"+item.LastReplyID]
		live := s.runtimeState(item.ID)
		connected := live.Availability == "connected" && live.SessionID == item.SessionUUID
		if connected {
			unread = live.Unread != nil && *live.Unread
		}
		inProgress := connected && (live.State == "running" || live.State == "background" || live.State == "needs-you")
		if activeOnly && (item.Archived || (!unread && !inProgress)) {
			continue
		}
		project := projects[item.Project]
		if project == nil {
			project = &managedProject{Path: item.Project, Archived: item.ProjectArchived}
			projects[item.Project] = project
		}
		if item.LastActivity > project.LastActivity {
			project.LastActivity = item.LastActivity
		}
		if item.Archived != archived {
			continue
		}
		project.Count++
		versions[item.Project] = append(versions[item.Project], item.ID+"\x00"+item.Name)
		project.Unread = project.Unread || unread
		if path == "" || item.Project == path {
			selected = append(selected, item)
		}
	}
	projectList := make([]*managedProject, 0, len(projects))
	for path, project := range projects {
		project.Revision = fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprint(project.Archived)+strings.Join(versions[path], "\x00"))))[:16]
		projectList = append(projectList, project)
	}
	total := len(selected)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 {
		limit = 30
	}
	limit = min(limit, 100)
	if r.URL.Query().Get("summary") == "true" {
		limit = 0
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	offset = max(0, min(offset, total))
	listItem := func(item managedSession) map[string]any {
		snapshot := s.sessionSnapshot(item.SessionSummary)
		return map[string]any{
			"id": item.ID, "name": item.Name, "project": item.Project,
			"lastActivity": item.LastActivity, "createdAt": item.CreatedAt, "archived": item.Archived,
			"state": snapshot.State, "replyId": snapshot.ReplyID, "unread": snapshot.Unread, "runtime": snapshot,
		}
	}
	page := make([]map[string]any, 0, limit)
	for _, item := range selected[offset:min(total, offset+limit)] {
		page = append(page, listItem(item))
	}
	var currentSession map[string]any
	if current := r.URL.Query().Get("current"); current != "" {
		for _, item := range selected {
			if item.ID == current {
				currentSession = listItem(item)
				break
			}
		}
	}
	writeJSON(w, 0, map[string]any{"sessions": page, "total": total, "projects": projectList, "currentSession": currentSession})
}

func (s *Server) handleRenameSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	name := strings.Join(strings.Fields(body.Name), " ")
	if name == "" || len(name) > 4096 {
		writeJSONError(w, 400, "会话名称不能为空或超过 4096 字节")
		return
	}
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	saved, err := s.executors.Rename(r.Context(), resolved, name, rpc.RenameSessionFile)
	if err != nil {
		writeJSONError(w, 409, err.Error())
		return
	}
	s.broadcast(globalSessID, "reload")
	s.broadcast(resolved.Session.ID, "reload")
	writeJSON(w, 0, map[string]any{"name": saved})
}

func (s *Server) handleArchiveSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var body struct {
		Archived *bool `json:"archived"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if body.Archived == nil {
		writeJSONError(w, 400, "archived required")
		return
	}
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	tx, err := s.db.Begin()
	if err == nil {
		defer tx.Rollback()
		_, err = tx.Exec(`INSERT INTO session_management(session_id,archived) VALUES(?,?)
			ON CONFLICT(session_id) DO UPDATE SET archived=excluded.archived`, resolved.Session.SessionUUID, *body.Archived)
		if err == nil && !*body.Archived {
			_, err = tx.Exec("UPDATE project_management SET archived=0 WHERE project=?", resolved.Session.Project)
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	s.broadcast(globalSessID, "reload")
	writeJSON(w, 0, map[string]any{"archived": *body.Archived})
}

func (s *Server) handleArchiveDisconnected(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var body struct {
		Project *string `json:"project"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	items, err := s.managedSessions()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	defer tx.Rollback()
	ids := make([]string, 0)
	for _, item := range items {
		if item.Archived || item.ProjectArchived || (body.Project != nil && item.Project != *body.Project) {
			continue
		}
		// Recheck the server's current Pi connection, never the browser's SSE transport.
		live := s.runtimeState(item.ID)
		if live.Availability != "disconnected" {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO session_management(session_id,archived) VALUES(?,1)
			ON CONFLICT(session_id) DO UPDATE SET archived=1`, item.SessionUUID); err != nil {
			writeJSONError(w, 500, err.Error())
			return
		}
		ids = append(ids, item.ID)
	}
	if err := tx.Commit(); err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	// This archives sessions only; even an emptied project remains visible.
	if len(ids) > 0 {
		s.broadcast(globalSessID, "reload")
	}
	writeJSON(w, 0, map[string]any{"ids": ids, "count": len(ids)})
}

func (s *Server) handleArchiveProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var body struct {
		Project string `json:"project"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	items, err := s.loadSummaries()
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	ids := make([]string, 0)
	for _, item := range items {
		if item.Project == body.Project {
			ids = append(ids, item.SessionUUID)
		}
	}
	if len(ids) == 0 {
		writeJSONError(w, 404, "未找到该文件夹的会话")
		return
	}
	tx, err := s.db.Begin()
	if err == nil {
		defer tx.Rollback()
		for _, id := range ids {
			if _, err = tx.Exec(`INSERT INTO session_management(session_id,archived) VALUES(?,1)
				ON CONFLICT(session_id) DO UPDATE SET archived=1`, id); err != nil {
				break
			}
		}
		if err == nil {
			_, err = tx.Exec(`INSERT INTO project_management(project,archived) VALUES(?,1)
				ON CONFLICT(project) DO UPDATE SET archived=1`, body.Project)
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		writeJSONError(w, 500, err.Error())
		return
	}
	s.broadcast(globalSessID, "reload")
	writeJSON(w, 0, map[string]any{"archived": true, "count": len(ids)})
}
