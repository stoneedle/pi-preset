package server

import "net/http"

func (s *Server) handleSessionDetails(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id := r.URL.Query().Get("id")
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, id)
	if resolveOrWriteError(w, err) {
		return
	}
	content, err := s.cache.OpenContent(s.sessionsDir, id)
	if resolveOrWriteError(w, err) {
		return
	}
	compaction, err := content.LatestCompaction(s.activeLeaf(content.SessionSummary))
	if resolveOrWriteError(w, err) {
		return
	}
	writeJSON(w, 0, map[string]any{
		"sessionId": content.SessionUUID, "sessionFile": resolved.Path,
		"cwd": content.CWD, "createdAt": content.CreatedAt,
		"compaction": compaction,
	})
}
