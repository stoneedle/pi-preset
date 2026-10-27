package server

import (
	"database/sql"
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
	"pi-web/internal/workers"

	_ "modernc.org/sqlite"
)

const globalSessID = "__all__"

type Deps struct {
	AgentDir       string
	SessionsDir    string
	Auth           *auth.Middleware
	WorkerFactory  workers.Factory
	Cache          *sessions.Cache
	RenderAppShell func(w io.Writer, appName string) error
	Now            func() time.Time
	PushClient     *http.Client
}

type Server struct {
	agentDir       string
	sessionsDir    string
	clients        []*sseClient
	clientsMu      sync.RWMutex
	fileMod        map[string]time.Time
	fileModMu      sync.RWMutex
	executors      *workers.Manager
	cache          *sessions.Cache
	auth           *auth.Middleware
	now            func() time.Time
	renderAppShell func(w io.Writer, appName string) error
	runtimeStates  map[string]runtimeSnapshot
	observations   map[string]ownerObservation
	lastKnownMu    sync.Mutex
	previewsMu     sync.Mutex
	previews       map[string]*previewGrant
	stopCh         chan struct{}
	stopOnce       sync.Once
	wg             sync.WaitGroup
	db             *sql.DB
	appNameMu      sync.Mutex
	push           *pushModule
	diagnostics    *diagnosticLog
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
		cache: deps.Cache, now: deps.Now,
		renderAppShell: deps.RenderAppShell,
		diagnostics:    &diagnosticLog{dir: filepath.Join(deps.AgentDir, "pi-web", "diagnostics")},
		fileMod:        make(map[string]time.Time), runtimeStates: make(map[string]runtimeSnapshot), observations: make(map[string]ownerObservation),
		stopCh: make(chan struct{}), db: db, previews: make(map[string]*previewGrant),
	}
	s.auth.SetAppNameProvider(s.AppName)
	s.push, err = newPushModule(db, deps.Now, deps.PushClient)
	if err != nil {
		db.Close()
		return nil, err
	}
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.push.run(s.stopCh, s.pushEventActive) }()
	s.executors = workers.NewManager(deps.WorkerFactory, deps.AgentDir)
	s.watchFiles()
	s.wg.Add(1)
	go s.runOwnerDiscovery()
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
		`CREATE TABLE IF NOT EXISTS session_management (session_id TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS project_management (project TEXT PRIMARY KEY, archived INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME)`,
		`CREATE TABLE IF NOT EXISTS session_results (session_id TEXT NOT NULL, result_id TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, completion_pending INTEGER NOT NULL DEFAULT 0, completion_children TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(session_id,result_id))`,
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			return nil, err
		}
	}
	// Remove retired manual positions while retaining archive preferences.
	var hasOrder int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info('session_management') WHERE name='order_index'`).Scan(&hasOrder); err != nil {
		db.Close()
		return nil, err
	}
	if hasOrder != 0 {
		if _, err := db.Exec(`ALTER TABLE session_management DROP COLUMN order_index`); err != nil {
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
		s.previewsMu.Lock()
		for key := range s.previews {
			s.revokePreview(key)
		}
		s.previewsMu.Unlock()
		s.wg.Wait()
		if s.executors != nil {
			_ = s.executors.Close()
		}
		if s.db != nil {
			s.db.Close()
		}
	})
}

func (s *Server) Register(mux *http.ServeMux) {
	for path, handler := range map[string]http.HandlerFunc{
		"/": s.handleIndex, "/session": s.handleSession,
		"/api/session": s.handleApiSession, "/api/session/block": s.handleSessionBlock,
		"/api/session/context": s.handleSessionContext,
		"/api/session/queue":   s.handleSessionQueue,
		"/api/session/fork":    s.handleForkSession,
		"/api/session/image":   s.handleSessionImage, "/api/sessions": s.handleApiSessions,
		"/api/session/name": s.handleRenameSession, "/api/session/archive": s.handleArchiveSession,
		"/api/project/archive":               s.handleArchiveProject,
		"/api/sessions/archive-disconnected": s.handleArchiveDisconnected,
		"/api/session/file":                  s.handleAttachment, "/api/session/preview": s.handleCreatePreview,
		"/api/chat": s.handleChat, "/api/chat/cancel": s.handleCancelChat,
		"/api/status":              s.handleSessionStatus,
		"/api/session/acknowledge": s.handleAcknowledgement,
		"/api/set-model":           s.handleSetModel, "/api/set-thinking-level": s.handleSetThinkingLevel,
		"/api/models": s.handleAvailableModels, "/api/commands": s.handleCommands,
		"/api/new-session": s.handleNewSession, "/api/recent-locations": s.handleRecentLocations,
		"/api/directories": s.handleDirectories, "/api/project-options": s.handleProjectOptions,
		"/api/set-speed": s.handleSetSpeed,
		"/api/git/info":  s.handleGitInfo, "/events": s.handleEvents,
		"/api/push/config": s.handlePushConfig, "/api/push/subscription": s.handlePushSubscription,
		"/api/push/status": s.handlePushStatus, "/api/push/test": s.handlePushTest,
		"/api/push/eligibility": s.handlePushEligibility,
		"/api/diagnostics":      s.handleDiagnostics,
		"/api/app-name":         s.handleAppName,
	} {
		mux.HandleFunc(path, s.auth.Wrap(handler))
	}
	mux.HandleFunc("/preview/", s.handlePreview)
}

func (s *Server) loadSummaries() ([]sessions.SessionSummary, error) {
	return s.cache.LoadAll(s.sessionsDir)
}

type sseClient struct {
	done     chan struct{}
	doneOnce sync.Once
	ch       chan string
	sessID   string
	mu       sync.Mutex
	queued   map[string]bool
}

func (s *Server) addClient(id string) *sseClient {
	c := &sseClient{ch: make(chan string, 16), done: make(chan struct{}), sessID: id, queued: make(map[string]bool)}
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
			// A reconnect supplies the authoritative current snapshot instead of silently losing the last change.
			c.doneOnce.Do(func() { close(c.done) })
		}
		c.mu.Unlock()
	}
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	render.WriteJSONError(w, status, message)
}
func writeJSON(w http.ResponseWriter, status int, payload any) { render.WriteJSON(w, status, payload) }
