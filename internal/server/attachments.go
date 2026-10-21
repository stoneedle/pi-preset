package server

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
)

const previewLifetime = 30 * time.Minute
const maxPreviews = 256

type previewGrant struct {
	root    *os.Root
	entry   string
	expires time.Time
	timer   *time.Timer
}

func (s *Server) attachmentPath(w http.ResponseWriter, r *http.Request, path string) string {
	resolved, err := s.cache.ResolveHeader(s.sessionsDir, r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(path), "file:") {
		u, err := url.Parse(path)
		if err != nil || (u.Host != "" && !strings.EqualFold(u.Host, "localhost")) || u.User != nil {
			writeJSONError(w, http.StatusBadRequest, "only local file URLs are supported")
			return ""
		}
		path = u.Path
		if os.PathSeparator == '\\' && len(path) > 2 && path[0] == '/' && path[2] == ':' {
			path = path[1:]
		}
	}
	if path == "" || len(path) > 32768 || strings.ContainsAny(path, "\x00\r\n") || strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, "//") {
		writeJSONError(w, http.StatusBadRequest, "invalid local file path")
		return ""
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			writeJSONError(w, http.StatusUnprocessableEntity, "home directory is unavailable")
			return ""
		}
		path = filepath.Join(home, path[2:])
	}
	if !filepath.IsAbs(path) {
		if !filepath.IsAbs(resolved.Session.Project) {
			writeJSONError(w, http.StatusUnprocessableEntity, "session working directory is unavailable")
			return ""
		}
		path = filepath.Join(resolved.Session.Project, path)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "file is unavailable")
		return ""
	}
	return path
}

func (s *Server) handleAttachment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	path := s.attachmentPath(w, r, r.URL.Query().Get("path"))
	if path == "" {
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "file is unavailable")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeJSONError(w, http.StatusNotFound, "not a regular file")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": info.Name()}))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func previewable(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".htm", ".md", ".markdown", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif":
		return true
	}
	return false
}

var previewMediaTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8",
	".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".json": "application/json", ".map": "application/json", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".svg": "image/svg+xml", ".avif": "image/avif", ".ico": "image/x-icon",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
	".mp3": "audio/mpeg", ".mp4": "video/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav", ".webm": "video/webm",
}

func (s *Server) handleCreatePreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "POST, DELETE")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		Path string `json:"path"`
		Key  string `json:"key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&input); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid preview request")
		return
	}
	if r.Method == http.MethodDelete {
		s.previewsMu.Lock()
		s.revokePreview(input.Key)
		s.previewsMu.Unlock()
		writeJSON(w, 0, map[string]bool{"revoked": true})
		return
	}
	path := s.attachmentPath(w, r, input.Path)
	if path == "" {
		return
	}
	if !previewable(path) {
		writeJSONError(w, http.StatusUnsupportedMediaType, "this file can be downloaded but not previewed")
		return
	}
	directory := filepath.Dir(path)
	agentRoot, err := filepath.EvalSymlinks(s.agentDir)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "private directory is unavailable")
		return
	}
	private, err := filepath.Rel(agentRoot, directory)
	if err != nil {
		private = ".."
	}
	first := strings.ToLower(strings.Split(filepath.ToSlash(private), "/")[0])
	privateWithinRoot, relativeErr := filepath.Rel(directory, agentRoot)
	containsPrivate := relativeErr == nil && privateWithinRoot != ".." && !strings.HasPrefix(privateWithinRoot, ".."+string(os.PathSeparator))
	home, _ := os.UserHomeDir()
	if containsPrivate || first == "pi-web" || first == "sessions" || first == "extension-data" || directory == filepath.Dir(directory) || directory == home {
		writeJSONError(w, http.StatusForbidden, "preview requires a document folder, not a private Pi, home or filesystem root; download this file instead")
		return
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		writeJSONError(w, http.StatusNotFound, "preview folder is unavailable")
		return
	}
	file, err := root.Open(filepath.Base(path))
	if err != nil {
		root.Close()
		writeJSONError(w, http.StatusNotFound, "file is unavailable")
		return
	}
	info, err := file.Stat()
	file.Close()
	if err != nil || !info.Mode().IsRegular() {
		root.Close()
		writeJSONError(w, http.StatusNotFound, "not a regular file")
		return
	}
	s.previewsMu.Lock()
	select {
	case <-s.stopCh:
		s.previewsMu.Unlock()
		root.Close()
		writeJSONError(w, http.StatusServiceUnavailable, "server is shutting down")
		return
	default:
	}
	if len(s.previews) >= maxPreviews {
		oldest := ""
		for key, grant := range s.previews {
			if oldest == "" || grant.expires.Before(s.previews[oldest].expires) {
				oldest = key
			}
		}
		s.revokePreview(oldest)
	}
	key := rand.Text()
	grant := &previewGrant{root: root, entry: filepath.Base(path), expires: time.Now().Add(previewLifetime)}
	s.previews[key] = grant
	grant.timer = time.AfterFunc(previewLifetime, func() {
		s.previewsMu.Lock()
		defer s.previewsMu.Unlock()
		s.revokePreview(key)
	})
	s.previewsMu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 0, map[string]string{"key": key, "name": info.Name(), "url": "/preview/" + key + "/" + url.PathEscape(info.Name())})
}

// Called with previewsMu held. Open resource handles outlive the root safely.
func (s *Server) revokePreview(key string) {
	if grant := s.previews[key]; grant != nil {
		grant.timer.Stop()
		grant.root.Close()
		delete(s.previews, key)
	}
}

func (s *Server) handlePreview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	key, path, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, "/preview/"), "/")
	s.previewsMu.Lock()
	grant := s.previews[key]
	if !ok || grant == nil || !time.Now().Before(grant.expires) {
		if grant != nil {
			s.revokePreview(key)
		}
		s.previewsMu.Unlock()
		http.Error(w, "Preview unavailable or expired. Close it and open a new preview.", http.StatusNotFound)
		return
	}
	contentType := previewMediaTypes[strings.ToLower(filepath.Ext(path))]
	allowed := contentType != "" && !strings.Contains(path, "\\")
	for _, segment := range strings.Split(path, "/") {
		if strings.HasPrefix(segment, ".") && path != grant.entry {
			allowed = false
		}
	}
	if !allowed {
		s.previewsMu.Unlock()
		http.Error(w, "resource is outside this preview", http.StatusForbidden)
		return
	}
	file, err := grant.root.Open(path)
	s.previewsMu.Unlock()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	base := (&url.URL{Scheme: scheme, Host: r.Host, Path: "/preview/" + key + "/"}).String()
	w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-modals allow-downloads; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' "+base+" blob:; style-src 'unsafe-inline' "+base+"; img-src "+base+" data: blob:; font-src "+base+" data:; media-src "+base+" data: blob:; connect-src "+base+"; frame-src "+base+"; form-action 'none'; base-uri "+base+"; object-src 'none'")
	ext := strings.ToLower(filepath.Ext(path))
	if ext == ".md" || ext == ".markdown" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.Method == http.MethodHead {
			return
		}
		source, err := io.ReadAll(file)
		if err != nil {
			http.Error(w, "document is unavailable", http.StatusNotFound)
			return
		}
		var body bytes.Buffer
		if err := goldmark.New(goldmark.WithExtensions(extension.GFM)).Convert(source, &body); err != nil {
			http.Error(w, "document could not be rendered", http.StatusUnprocessableEntity)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.Method != http.MethodHead {
			fmt.Fprintf(w, "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>%s</title><style>body{max-width:760px;margin:0 auto;padding:24px;font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere;color:#20242b;background:white}img,video{max-width:100%%;height:auto}pre,table{display:block;max-width:100%%;overflow:auto}pre{padding:16px;background:#f4f5f7;border-radius:8px}code{font-family:ui-monospace,monospace}td,th{padding:6px 12px;border:1px solid #ddd}table{border-collapse:collapse}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #ddd}</style></head><body>%s</body></html>", html.EscapeString(info.Name()), body.String())
		}
		return
	}
	w.Header().Set("Content-Type", contentType)
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}
