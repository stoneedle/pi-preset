package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pi-web/internal/auth"
	"pi-web/internal/sessions"
	"pi-web/internal/ui"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	middleware := auth.New("")
	middleware.AllowHost("example.com")
	s, err := New(Deps{AgentDir: dir, SessionsDir: dir, Auth: middleware, Cache: sessions.NewCache(), RenderAppShell: ui.RenderAppShell})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Shutdown)
	return s
}

func TestOnlyMobileRoutesRemainAndShellContainsNoSessionData(t *testing.T) {
	s := newTestServer(t)
	writeConversation(t, s.sessionsDir, []map[string]any{{"role": "user", "content": "private-conversation-body"}})
	mux := http.NewServeMux()
	s.Register(mux)
	for _, path := range []string{"/", "/session?id=mobile.jsonl"} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Accept-Encoding", "gzip")
		Compress(mux).ServeHTTP(w, req)
		if w.Code != 200 || w.Header().Get("Content-Encoding") != "gzip" {
			t.Fatalf("shell response %d %v", w.Code, w.Header())
		}
		reader, err := gzip.NewReader(w.Body)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(reader)
		reader.Close()
		if strings.Contains(string(body), "private-conversation-body") || strings.Contains(string(body), "pi-session-bootstrap") || len(body) > 20000 {
			t.Fatalf("heavy shell: %d bytes", len(body))
		}
	}
	for _, path := range []string{"/settings", "/schedules", "/api/fork-session", "/api/clone-session", "/api/annotations", "/api/scratchpad", "/api/chat/queue", "/api/worker-status", "/api/projects", "/api/git/diff", "/metrics"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 {
			t.Errorf("removed route %s returned %d", path, w.Code)
		}
	}
}

func TestMobileAPIsStillRequireAuthentication(t *testing.T) {
	s := newTestServer(t)
	s.auth = auth.New("private-token")
	mux := http.NewServeMux()
	s.Register(mux)
	for _, path := range []string{"/api/session?id=mobile.jsonl", "/api/status?id=mobile.jsonl", "/api/session/block?id=mobile.jsonl&entry=x&index=0"} {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Accept", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s = %d", path, w.Code)
		}
	}
}

func TestShutdownIsIdempotent(t *testing.T) { s := newTestServer(t); s.Shutdown(); s.Shutdown() }
