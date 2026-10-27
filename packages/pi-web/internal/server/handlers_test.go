package server

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionListIsBoundedAndSearchesUnloadedHistory(t *testing.T) {
	s := newTestServer(t)
	for i := 0; i < 65; i++ {
		writeSessionFile(t, s.sessionsDir, "project", fmt.Sprintf("session-%03d.jsonl", i))
	}
	for _, test := range []struct {
		query        string
		count, total int
	}{
		{"", 30, 65}, {"&limit=500", 65, 65}, {"&offset=60", 5, 65}, {"&q=session-064", 1, 1},
	} {
		r := httptest.NewRecorder()
		s.handleApiSessions(r, httptest.NewRequest("GET", "/api/sessions?x=1"+test.query, nil))
		var response struct {
			Sessions []map[string]any `json:"sessions"`
			Total    int              `json:"total"`
		}
		if err := json.Unmarshal(r.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if len(response.Sessions) != test.count || response.Total != test.total {
			t.Fatalf("%s: %d/%d", test.query, len(response.Sessions), response.Total)
		}
		if strings.Contains(r.Body.String(), `"Entries"`) || strings.Contains(r.Body.String(), `"entries"`) {
			t.Fatal("list contains conversation body")
		}
	}
}
