package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const diagnosticFileBytes = 4 << 20
const diagnosticSeenLimit = 8192

var diagnosticID = regexp.MustCompile(`^[a-f0-9-]{1,80}$`)
var diagnosticWord = regexp.MustCompile(`^[A-Za-z0-9_.:-]{0,100}$`)
var diagnosticEvents = strings.Fields(`
page.start page.visibility page.freeze page.resume page.pageshow page.pagehide page.focus page.online page.offline page.error page.rejection page.reload page.resource-error
stream.connect stream.open stream.error stream.reconnect stream.close stream.dispose
refresh.preflight refresh.error worker.registered worker.error
session.read session.commit session.invalidate session.read-error session.leaf view.mount view.dispose cache.evict history.intent`)

// Only explicit scalar metadata can reach disk. Unknown fields (including text/URLs)
// are dropped even if an old or malformed browser submits them.
var diagnosticFields = map[string]string{
	"seq": "number", "time": "number", "elapsed": "number", "epoch": "number", "observation": "number",
	"duration": "number", "received": "number", "retained": "number", "pending": "number", "idle": "number",
	"readyState": "number", "status": "number", "bytes": "number", "count": "number", "line": "number",
	"visible": "number", "scrollTop": "number", "height": "number",
	"hidden": "bool", "online": "bool", "discarded": "bool", "standalone": "bool", "persisted": "bool",
	"blocked": "bool", "reloadRequired": "bool", "activated": "bool", "ready": "bool", "previous": "bool",
	"current": "bool", "changed": "bool", "waiting": "bool", "controlled": "bool", "reset": "bool",
	"aborted": "bool", "cached": "bool", "background": "bool", "demand": "bool",
	"session": "id", "stream": "id", "cursor": "id", "key": "id", "leaf": "id", "reply": "id", "previousPage": "id",
	"reason": "word", "category": "word", "navigation": "word", "state": "word", "mode": "word", "result": "word", "source": "word",
}

type diagnosticBatch struct {
	Client    string                       `json:"client"`
	Page      string                       `json:"page"`
	Build     string                       `json:"build"`
	UserAgent string                       `json:"userAgent"`
	Events    []map[string]json.RawMessage `json:"events"`
}

type diagnosticLog struct {
	mu    sync.Mutex
	dir   string
	seen  map[string]bool
	order []string
}

func (s *Server) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	var batch diagnosticBatch
	if !decodeJSONBody(w, r, &batch) {
		return
	}
	if !diagnosticID.MatchString(batch.Client) || !diagnosticID.MatchString(batch.Page) ||
		!diagnosticWord.MatchString(batch.Build) || len(batch.UserAgent) > 512 ||
		len(batch.Events) == 0 || len(batch.Events) > 30 {
		writeJSONError(w, http.StatusBadRequest, "invalid diagnostic batch")
		return
	}
	lines := make([]map[string]any, 0, len(batch.Events))
	ids := make([]string, 0, len(batch.Events))
	for _, fields := range batch.Events {
		var event string
		if json.Unmarshal(fields["event"], &event) != nil || !containsDiagnosticEvent(event) {
			writeJSONError(w, http.StatusBadRequest, "invalid diagnostic event")
			return
		}
		line := map[string]any{
			"receivedAt": s.now().UTC().Format(time.RFC3339Nano),
			"client":     batch.Client, "page": batch.Page, "build": batch.Build,
			"userAgent": batch.UserAgent, "event": event,
		}
		for key, kind := range diagnosticFields {
			raw, ok := fields[key]
			if !ok || bytes.Equal(raw, []byte("null")) {
				continue
			}
			var value any
			if json.Unmarshal(raw, &value) != nil || !validDiagnosticField(kind, value) {
				writeJSONError(w, http.StatusBadRequest, "invalid diagnostic metadata")
				return
			}
			line[key] = value
		}
		seq, ok := line["seq"].(float64)
		if !ok || seq < 1 || math.Trunc(seq) != seq || line["time"] == nil || line["elapsed"] == nil {
			writeJSONError(w, http.StatusBadRequest, "invalid diagnostic sequence")
			return
		}
		ids = append(ids, fmt.Sprintf("%s:%s:%.0f", batch.Client, batch.Page, seq))
		lines = append(lines, line)
	}
	if err := s.diagnostics.append(lines, ids); err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "diagnostic log unavailable")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func containsDiagnosticEvent(event string) bool {
	for _, known := range diagnosticEvents {
		if known == event {
			return true
		}
	}
	return false
}

func validDiagnosticField(kind string, value any) bool {
	switch kind {
	case "number":
		n, ok := value.(float64)
		return ok && math.Abs(n) <= 9e15
	case "bool":
		_, ok := value.(bool)
		return ok
	case "id", "word":
		text, ok := value.(string)
		return ok && ((kind == "id" && (text == "" || diagnosticID.MatchString(text))) ||
			(kind == "word" && diagnosticWord.MatchString(text)))
	}
	return false
}

func (l *diagnosticLog) append(lines []map[string]any, ids []string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.seen == nil {
		l.seen = make(map[string]bool)
	}
	var data bytes.Buffer
	pending := make(map[string]bool)
	for i, line := range lines {
		if l.seen[ids[i]] || pending[ids[i]] {
			continue
		}
		if err := json.NewEncoder(&data).Encode(line); err != nil {
			return err
		}
		pending[ids[i]] = true
	}
	if data.Len() == 0 {
		return nil
	}
	if err := os.MkdirAll(l.dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(l.dir, "browser.jsonl")
	info, err := os.Stat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if info != nil && info.Size()+int64(data.Len()) > diagnosticFileBytes {
		if err := os.Remove(filepath.Join(l.dir, "browser.2.jsonl")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		for i := 1; i >= 0; i-- {
			from := path
			if i > 0 {
				from = filepath.Join(l.dir, fmt.Sprintf("browser.%d.jsonl", i))
			}
			to := filepath.Join(l.dir, fmt.Sprintf("browser.%d.jsonl", i+1))
			if err := os.Rename(from, to); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data.Bytes())
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		return errors.Join(writeErr, closeErr)
	}
	for id := range pending {
		l.seen[id] = true
		l.order = append(l.order, id)
	}
	for len(l.order) > diagnosticSeenLimit {
		delete(l.seen, l.order[0])
		l.order = l.order[1:]
	}
	return nil
}
