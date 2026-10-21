package server

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
)

func (s *Server) handleAppShell(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.renderAppShell == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := s.renderAppShell(w); err != nil && !isBrokenPipe(err) {
		fmt.Fprintf(os.Stderr, "app shell: %v\n", err)
	}
}

func (s *Server) getSetting(key, fallback string) string {
	if s.db == nil {
		return fallback
	}
	var value string
	if s.db.QueryRow("SELECT value FROM settings WHERE key = ?", key).Scan(&value) != nil {
		return fallback
	}
	return value
}

var fontKeywords = map[string]string{
	"mono":   "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
	"system": "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
	"sans":   "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
	"serif":  "Georgia, 'Times New Roman', Times, serif",
}

func sanitizeFontFamily(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == ' ', r == '-':
			b.WriteRune(r)
		}
		if b.Len() >= 64 {
			break
		}
	}
	return strings.TrimSpace(b.String())
}

func resolveFontStack(value string) string {
	if stack, ok := fontKeywords[value]; ok {
		return stack
	}
	if family := sanitizeFontFamily(value); family != "" {
		return "'" + family + "', " + fontKeywords["mono"]
	}
	return fontKeywords["mono"]
}

func sanitizeFontSize(value, fallback string) string {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		n, _ = strconv.Atoi(fallback)
	}
	return strconv.Itoa(max(8, min(32, n)))
}

func (s *Server) FontStyles() (uiStack, contentStack, codeStack, uiSize, contentSize string) {
	uiStack = resolveFontStack(s.getSetting("pi-web:v1:font-ui", "system"))
	contentStack = resolveFontStack(s.getSetting("pi-web:v1:font-content", "system"))
	codeStack = resolveFontStack(s.getSetting("pi-web:v1:font-code", "mono"))
	uiSize = sanitizeFontSize(s.getSetting("pi-web:v1:font-ui-size", "16"), "16")
	contentSize = sanitizeFontSize(s.getSetting("pi-web:v1:font-content-size", "16"), "16")
	return
}
