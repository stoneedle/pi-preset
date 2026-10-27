package server

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"pi-web/internal/rpc"
	"pi-web/internal/sessions"
)

func (s *Server) handleDirectories(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	path := r.URL.Query().Get("path")
	home, _ := os.UserHomeDir()
	if path == "" {
		path = home
	}
	path, err := sessions.ResolveDirectory(path)
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	directories := make([]map[string]string, 0)
	for _, entry := range entries {
		target := filepath.Join(path, entry.Name())
		info, err := os.Stat(target)
		if err != nil || !info.IsDir() {
			continue
		}
		directories = append(directories, map[string]string{"name": entry.Name(), "path": target})
	}
	sort.Slice(directories, func(i, j int) bool {
		return strings.ToLower(directories[i]["name"]) < strings.ToLower(directories[j]["name"])
	})
	roots := []string{home}
	if runtime.GOOS == "windows" {
		for drive := 'A'; drive <= 'Z'; drive++ {
			root := string(drive) + ":\\"
			if info, err := os.Stat(root); err == nil && info.IsDir() {
				roots = append(roots, root)
			}
		}
	} else {
		roots = append(roots, "/")
	}
	writeJSON(w, 0, map[string]any{"path": path, "parent": filepath.Dir(path), "directories": directories, "roots": roots})
}

func (s *Server) handleProjectOptions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		path, _ = os.UserHomeDir()
	}
	path, err := sessions.ResolveDirectory(path)
	if err != nil {
		writeJSONError(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	options, err := rpc.ProjectOptions(ctx, path, s.agentDir)
	if err != nil {
		writeJSONError(w, 503, err.Error())
		return
	}
	writeJSON(w, 0, options)
}
