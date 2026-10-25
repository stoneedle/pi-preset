package ui

import (
	_ "embed"
	"encoding/json"
	"io/fs"
	"net/http"
)

//go:embed embedded/assets/manifest.webmanifest
var manifestJSON string

//go:embed embedded/assets/icon.svg
var iconSVG string

//go:embed embedded/assets/icon-maskable.svg
var iconMaskableSVG string

//go:embed embedded/assets/icon-192.png
var icon192PNG []byte

//go:embed embedded/assets/icon-512.png
var icon512PNG []byte

//go:embed embedded/assets/icon-maskable-512.png
var iconMaskablePNG []byte

//go:embed embedded/assets/pi-logo.svg
var piLogoSVG string

func RegisterPWAHandlers(mux *http.ServeMux, frontend fs.FS, appName func() string) {
	mux.HandleFunc("/manifest.webmanifest", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var manifest map[string]any
		if err := json.Unmarshal([]byte(manifestJSON), &manifest); err != nil {
			http.Error(w, "manifest unavailable", http.StatusInternalServerError)
			return
		}
		name := appName()
		manifest["name"], manifest["short_name"] = name, name
		w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodHead {
			_ = json.NewEncoder(w).Encode(manifest)
		}
	})
	sw, err := fs.ReadFile(frontend, "sw.js")
	if err != nil {
		panic("frontend service worker missing: " + err.Error())
	}
	for path, asset := range map[string]struct{ content, kind string }{
		"/sw.js":                 {string(sw), "application/javascript; charset=utf-8"},
		"/icon.svg":              {iconSVG, "image/svg+xml"},
		"/icon-192.png":          {string(icon192PNG), "image/png"},
		"/icon-512.png":          {string(icon512PNG), "image/png"},
		"/icon-maskable-512.png": {string(iconMaskablePNG), "image/png"},
		"/icon-maskable.svg":     {iconMaskableSVG, "image/svg+xml"},
		"/pi-logo.svg":           {piLogoSVG, "image/svg+xml"},
	} {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", asset.kind)
			w.Header().Set("Cache-Control", "no-cache")
			if path == "/sw.js" {
				w.Header().Set("Service-Worker-Allowed", "/")
			}
			_, _ = w.Write([]byte(asset.content))
		})
	}
}
