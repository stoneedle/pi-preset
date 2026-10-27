package server

import (
	"compress/gzip"
	"net/http"
	"strings"
)

type gzipResponse struct {
	http.ResponseWriter
	writer *gzip.Writer
}

func (w gzipResponse) Write(data []byte) (int, error) { return w.writer.Write(data) }

func Compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/session", "/api/session", "/api/session/block", "/api/sessions", "/api/status":
		default:
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Accept-Encoding")
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		writer, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
		defer writer.Close()
		next.ServeHTTP(gzipResponse{ResponseWriter: w, writer: writer}, r)
	})
}
