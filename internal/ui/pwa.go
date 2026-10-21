package ui

import (
	_ "embed"
	"net/http"
)

//go:embed embedded/assets/manifest.webmanifest
var manifestJSON string

//go:embed embedded/assets/sw.js
var swJS string

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

func RegisterPWAHandlers(mux *http.ServeMux) {
	for path, asset := range map[string]struct{ content, kind string }{
		"/manifest.webmanifest":  {manifestJSON, "application/manifest+json"},
		"/sw.js":                 {swJS, "application/javascript; charset=utf-8"},
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
