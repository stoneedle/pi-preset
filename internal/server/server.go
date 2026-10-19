package server

import (
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"pi-web/internal/agentdir"
	"pi-web/internal/auth"
	"pi-web/internal/render"
	"pi-web/internal/sessions"

	_ "modernc.org/sqlite"
)

const globalSessID = "__all__"

type Deps struct {
	AgentDir       string
	SessionsDir    string
	Auth           *auth.Middleware
	ChatSender     ChatSender
	Cache          *sessions.Cache
	RenderAppShell func(w io.Writer) error
	Now            func() time.Time
}

type Server struct {
	agentDir       string
	sessionsDir    string
	clients        []*sseClient
	clientsMu      sync.RWMutex
	fileMod        map[string]time.Time
	fileModMu      sync.RWMutex
	chatSender     ChatSender
	cache          *sessions.Cache
	auth           *auth.Middleware
	now            func() time.Time
	renderAppShell func(w io.Writer) error
	lastStates     map[string]string
	lastKnownMu    sync.Mutex
	stopCh         chan struct{}
	stopOnce       sync.Once
	wg             sync.WaitGroup
	db             *sql.DB
}

func New(deps Deps) (*Server, error) {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.AgentDir == "" {
		deps.AgentDir = agentdir.Path()
	}
	if deps.Cache == nil {
		deps.Cache = sessions.NewCache()
	}
	if deps.Auth == nil {
		deps.Auth = auth.New("")
	}
	if err := os.MkdirAll(deps.AgentDir, 0o700); err != nil {
		return nil, err
	}
	db, err := initDB(deps.AgentDir)
	if err != nil {
		return nil, err
	}
	s := &Server{
		agentDir: deps.AgentDir, sessionsDir: deps.SessionsDir, auth: deps.Auth,
		chatSender: deps.ChatSender, cache: deps.Cache, now: deps.Now,
		renderAppShell: deps.RenderAppShell,
		fileMod:        make(map[string]time.Time), lastStates: make(map[string]string),
		stopCh: make(chan struct{}), db: db,
	}
	s.watchFiles()
	if err := s.startSessionStatusWatcher(); err != nil {
		fmt.Fprintf(os.Stderr, "session-status watcher: %v\n", err)
	}
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.runStatusSweeper(s.stopCh, time.Second) }()
	return s, nil
}

func initDB(agentDir string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", filepath.Join(agentDir, "pi-web.sqlite"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, statement := range []string{
		`PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			return nil, err
		}
	}
	return db, nil
}

func (s *Server) Shutdown() {
	s.stopOnce.Do(func() {
		if s.stopCh != nil {
			close(s.stopCh)
		}
		s.wg.Wait()
		if s.db != nil {
			s.db.Close()
		}
	})
}

func (s *Server) Register(mux *http.ServeMux) {
	for path, handler := range map[string]http.HandlerFunc{
		"/": s.handleIndex, "/session": s.handleSession,
		"/api/session": s.handleApiSession, "/api/session/block": s.handleSessionBlock,
		"/api/session/image": s.handleSessionImage, "/api/sessions": s.handleApiSessions,
		"/api/chat": s.handleChat, "/api/chat/cancel": s.handleCancelChat,
		"/api/session/continue": s.handleContinueSession, "/api/status": s.handleSessionStatus,
		"/api/set-model": s.handleSetModel, "/api/set-thinking-level": s.handleSetThinkingLevel,
		"/api/models": s.handleAvailableModels, "/api/commands": s.handleCommands,
		"/api/new-session": s.handleNewSession, "/api/recent-locations": s.handleRecentLocations,
		"/api/git/info": s.handleGitInfo, "/events": s.handleEvents,
	} {
		mux.HandleFunc(path, s.auth.Wrap(handler))
	}
	mux.HandleFunc("/custom-themes.css", s.handleCustomThemes)
}

func (s *Server) loadSummaries() ([]sessions.SessionSummary, error) {
	return s.cache.LoadAll(s.sessionsDir)
}

type sseClient struct {
	ch     chan string
	sessID string
	mu     sync.Mutex
	queued map[string]bool
}

func (s *Server) addClient(id string) *sseClient {
	c := &sseClient{ch: make(chan string, 16), sessID: id, queued: make(map[string]bool)}
	s.clientsMu.Lock()
	s.clients = append(s.clients, c)
	s.clientsMu.Unlock()
	return c
}

func eventKey(msg string) string {
	if msg == "reload" || msg == "new-session" {
		return msg
	}
	return ""
}

func (s *Server) removeClient(target *sseClient) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	filtered := s.clients[:0]
	for _, c := range s.clients {
		if c != target {
			filtered = append(filtered, c)
		}
	}
	s.clients = filtered
	close(target.ch)
}

func (s *Server) broadcast(id, message string) {
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()
	for _, c := range s.clients {
		if c.sessID != id {
			continue
		}
		c.mu.Lock()
		key := eventKey(message)
		if key != "" && c.queued[key] {
			c.mu.Unlock()
			continue
		}
		select {
		case c.ch <- message:
			if key != "" {
				c.queued[key] = true
			}
		default:
		}
		c.mu.Unlock()
	}
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	render.WriteJSONError(w, status, message)
}
func writeJSON(w http.ResponseWriter, status int, payload any) { render.WriteJSON(w, status, payload) }
