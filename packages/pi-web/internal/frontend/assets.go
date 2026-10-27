package frontend

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"strings"

	"pi-web/internal/render"
)

const AppEntry = "src/main.js"

// Script is one Vite-built JavaScript entrypoint ready to be served by Go.
type Script struct {
	Entry string
	Path  string
	JS    string
	CSS   []string
}

func loadManifest(distFS fs.FS) (render.Manifest, error) {
	data, err := fs.ReadFile(distFS, ".vite/manifest.json")
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}
	var manifest render.Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	return manifest, nil
}

func validateManifestEntry(manifest render.Manifest, entryName string) (render.ManifestEntry, error) {
	entry, ok := manifest[entryName]
	if !ok {
		return render.ManifestEntry{}, fmt.Errorf("manifest missing %s entry", entryName)
	}
	if entry.File == "" {
		return render.ManifestEntry{}, fmt.Errorf("manifest entry file is empty: %s", entryName)
	}
	if strings.HasPrefix(entry.File, "/") {
		return render.ManifestEntry{}, fmt.Errorf("manifest entry file is absolute: %s", entry.File)
	}
	if strings.Contains(entry.File, "..") {
		return render.ManifestEntry{}, fmt.Errorf("manifest entry file contains path traversal: %s", entry.File)
	}
	return entry, nil
}

func loadFrontendScript(distFS fs.FS, manifest render.Manifest, entryName string) (Script, error) {
	entry, err := validateManifestEntry(manifest, entryName)
	if err != nil {
		return Script{}, err
	}
	scriptPath, ok := manifest.ScriptPath(entryName)
	if !ok {
		return Script{}, fmt.Errorf("manifest script path not found: %s", entryName)
	}
	content, err := fs.ReadFile(distFS, entry.File)
	if err != nil {
		return Script{}, fmt.Errorf("read %s js: %w", entryName, err)
	}
	css := make([]string, 0, len(entry.CSS))
	for _, path := range entry.CSS {
		if strings.HasPrefix(path, "/") || strings.Contains(path, "..") {
			return Script{}, fmt.Errorf("invalid CSS path")
		}
		css = append(css, "/static/"+path)
	}
	return Script{Entry: entryName, Path: scriptPath, JS: string(content), CSS: css}, nil
}

func LoadScripts(distFS fs.FS, entryNames ...string) ([]Script, error) {
	manifest, err := loadManifest(distFS)
	if err != nil {
		return nil, err
	}
	scripts := make([]Script, 0, len(entryNames))
	for _, entryName := range entryNames {
		script, err := loadFrontendScript(distFS, manifest, entryName)
		if err != nil {
			return nil, err
		}
		scripts = append(scripts, script)
	}
	return scripts, nil
}

func gzipJS(js string) []byte {
	var buf bytes.Buffer
	w, err := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
	if err != nil {
		return []byte(js)
	}
	_, _ = w.Write([]byte(js))
	_ = w.Close()
	return buf.Bytes()
}

type staticAsset struct {
	raw        []byte
	compressed []byte
}

// ServeStaticAssets serves content-hashed assets, pre-compressed at startup.
func ServeStaticAssets(dfs fs.FS) http.HandlerFunc {
	// Pre-load and compress all assets at startup.
	cache := make(map[string]staticAsset)
	entries, _ := fs.ReadDir(dfs, "assets")
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		raw, err := fs.ReadFile(dfs, "assets/"+e.Name())
		if err != nil {
			continue
		}
		cache[e.Name()] = staticAsset{raw: raw, compressed: gzipJS(string(raw))}
	}

	return func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Path[len("/static/assets/"):]
		if name == "" || strings.Contains(name, "/") || strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		asset, ok := cache[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		contentType := mime.TypeByExtension(filepath.Ext(name))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Vary", "Accept-Encoding")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write(asset.compressed)
		} else {
			_, _ = w.Write(asset.raw)
		}
	}
}

func ServeJS(js string, immutable bool) http.HandlerFunc {
	raw := []byte(js)
	compressed := gzipJS(js)
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		if immutable {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			_, _ = w.Write(compressed)
		} else {
			_, _ = w.Write(raw)
		}
	}
}
