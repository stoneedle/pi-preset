package sessions

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Session JSONL is read line-by-line; a single line (e.g. a large assistant
// message or pasted blob) can be big, so the scanner starts with a 64KB buffer
// and grows up to maxScanLineBytes. The cap bounds memory against an
// attacker-controlled file with a pathologically long line.
const (
	scanInitialBufferBytes = 64 * 1024
	maxScanLineBytes       = 256 * 1024 * 1024
)

// Typed structs for ParseSummary — avoid map[string]any per line.
type summaryLine struct {
	Type      string      `json:"type"`
	Timestamp string      `json:"timestamp"`
	Name      string      `json:"name"`
	CWD       string      `json:"cwd"`
	ID        string      `json:"id"`
	Message   *summaryMsg `json:"message"`
}

type summaryMsg struct {
	Role       string          `json:"role"`
	StopReason string          `json:"stopReason"`
	Content    json.RawMessage `json:"content"`
}

type SessionSummary struct {
	ID                 string
	SessionUUID        string
	Project            string
	LastActivity       string
	Name               string
	LastReplyID        string
	ChatAvailable      bool
	ChatDisabledReason string
}

type Session struct {
	SessionSummary
	Header  map[string]any
	Entries []map[string]any
}

func isAssistantReply(role, reason any) bool {
	if role != "assistant" {
		return false
	}
	switch reason {
	case "stop", "length", "error", "aborted":
		return true
	}
	return false
}

func SortSummariesByActivity(s []SessionSummary) {
	type sortableSummary struct {
		summary  SessionSummary
		activity time.Time
		valid    bool
		index    int
	}

	items := make([]sortableSummary, len(s))
	for i := range s {
		activity, err := time.Parse(time.RFC3339, s[i].LastActivity)
		items[i] = sortableSummary{
			summary:  s[i],
			activity: activity,
			valid:    err == nil,
			index:    i,
		}
	}

	sort.Slice(items, func(i, j int) bool {
		if items[i].valid != items[j].valid {
			return items[i].valid
		}
		if !items[i].activity.Equal(items[j].activity) {
			return items[i].activity.After(items[j].activity)
		}
		return items[i].index < items[j].index
	})

	for i := range items {
		s[i] = items[i].summary
	}
}

const chatDisabledCWD = "This session is view-only because its working directory is unavailable."

func newSessionSummary(dirName, fileName string) SessionSummary {
	return SessionSummary{
		ID:                 fileName,
		Project:            cleanProjectName(dirName),
		ChatDisabledReason: chatDisabledCWD,
	}
}

// applySummaryContext finalizes the fields shared by ParseSummary and ParseFile
// after the scan: a LastActivity fallback to the file mtime, the session name
// precedence (session_info > header > first user message > filename), and the
// cwd-derived project / chat-availability. Kept in one place so the two parsers
// (typed vs map) can't drift on name resolution or the disabled-chat reason.
func applySummaryContext(s *SessionSummary, path, fileName, sessionInfoName, headerName, firstUserText, headerCwd string) {
	if s.LastActivity == "" {
		if info, err := os.Stat(path); err == nil {
			s.LastActivity = info.ModTime().Format(time.RFC3339)
		}
	}

	switch {
	case sessionInfoName != "":
		s.Name = sessionInfoName
	case headerName != "":
		s.Name = headerName
	case firstUserText != "":
		s.Name = truncate(firstUserText, 80)
	default:
		s.Name = fileName
	}

	if headerCwd != "" {
		s.Project = headerCwd
		if info, err := os.Stat(headerCwd); err == nil && info.IsDir() {
			s.ChatAvailable = true
			s.ChatDisabledReason = ""
		}
	}
}

// ParseSummary streams path line-by-line, accumulating only the fields the
// index page needs. Lines are discarded after parsing — unlike ParseFile,
// the full conversation is not retained in memory.
func ParseSummary(path, dirName, fileName string) (SessionSummary, error) {
	f, err := os.Open(path)
	if err != nil {
		return SessionSummary{}, err
	}
	defer f.Close()

	s := newSessionSummary(dirName, fileName)

	var headerName, sessionInfoName, firstUserText, headerCwd string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, scanInitialBufferBytes), maxScanLineBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if len(line) == 0 {
			continue
		}
		var raw summaryLine
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		switch raw.Type {
		case "session":
			if raw.Name != "" {
				headerName = raw.Name
			}
			if raw.CWD != "" {
				headerCwd = raw.CWD
			}
			if raw.ID != "" {
				s.SessionUUID = raw.ID
			}
		case "session_info":
			if raw.Name != "" {
				sessionInfoName = raw.Name
			}
		case "message":
			if raw.Timestamp != "" {
				s.LastActivity = raw.Timestamp
			}
			if raw.Message == nil {
				continue
			}
			msg := raw.Message
			if isAssistantReply(msg.Role, msg.StopReason) {
				s.LastReplyID = raw.ID
			}
			if firstUserText == "" && msg.Role == "user" {
				firstUserText = extractRawText(msg.Content)
			}
		default:
			if raw.Timestamp != "" {
				s.LastActivity = raw.Timestamp
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return SessionSummary{}, err
	}

	applySummaryContext(&s, path, fileName, sessionInfoName, headerName, firstUserText, headerCwd)

	return s, nil
}

// extractRawText pulls plain text from a json.RawMessage content value
// (string or content-block array). Used by ParseSummary.
func extractRawText(content json.RawMessage) string {
	if len(content) == 0 {
		return ""
	}
	if content[0] == '"' {
		var s string
		if json.Unmarshal(content, &s) == nil {
			return s
		}
	}
	if content[0] == '[' {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(content, &blocks) == nil {
			var buf strings.Builder
			for _, b := range blocks {
				if b.Type == "text" && b.Text != "" {
					buf.WriteString(b.Text)
				}
			}
			return buf.String()
		}
	}
	return ""
}

func extractMessageText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var buf strings.Builder
		for _, item := range v {
			if block, ok := item.(map[string]any); ok {
				if t, _ := block["type"].(string); t == "text" {
					if txt, _ := block["text"].(string); txt != "" {
						buf.WriteString(txt)
					}
				}
			}
		}
		return buf.String()
	}
	return ""
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}

// ParseFile parses path in a single pass, collecting both the SessionSummary
// fields and the full Entries slice. This avoids the double-read that would
// result from calling ParseSummary followed by os.ReadFile.
func ParseFile(path, dirName, fileName string) (Session, error) {
	f, err := os.Open(path)
	if err != nil {
		return Session{}, err
	}
	defer f.Close()

	s := newSessionSummary(dirName, fileName)

	var entries []map[string]any
	var header map[string]any
	var headerName, sessionInfoName, firstUserText, headerCwd string
	seenSessionHeaders := make(map[string]bool)

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, scanInitialBufferBytes), maxScanLineBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		if raw["type"] == "session" {
			key := sessionHeaderKey(raw)
			if key != "" && seenSessionHeaders[key] {
				continue
			}
			if key != "" {
				seenSessionHeaders[key] = true
			}
		}
		entries = append(entries, raw)
		switch raw["type"] {
		case "session":
			header = raw
			if n, _ := raw["name"].(string); n != "" {
				headerName = n
			}
			if cwd, _ := raw["cwd"].(string); cwd != "" {
				headerCwd = cwd
			}
			if sid, _ := raw["id"].(string); sid != "" {
				s.SessionUUID = sid
			}
		case "session_info":
			if n, _ := raw["name"].(string); n != "" {
				sessionInfoName = n
			}
		case "message":
			if ts, ok := raw["timestamp"].(string); ok {
				s.LastActivity = ts
			}
			msg, ok := raw["message"].(map[string]any)
			if !ok {
				continue
			}
			if isAssistantReply(msg["role"], msg["stopReason"]) {
				s.LastReplyID, _ = raw["id"].(string)
			}
			if firstUserText == "" {
				if role, _ := msg["role"].(string); role == "user" {
					firstUserText = extractMessageText(msg["content"])
				}
			}
		default:
			if ts, ok := raw["timestamp"].(string); ok {
				s.LastActivity = ts
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return Session{}, err
	}

	applySummaryContext(&s, path, fileName, sessionInfoName, headerName, firstUserText, headerCwd)

	return Session{SessionSummary: s, Header: header, Entries: entries}, nil
}

func sessionHeaderKey(raw map[string]any) string {
	id, _ := raw["id"].(string)
	timestamp, _ := raw["timestamp"].(string)
	cwd, _ := raw["cwd"].(string)
	if id == "" || timestamp == "" {
		return ""
	}
	return id + "\x00" + timestamp + "\x00" + cwd
}

// cleanProjectName reverses EncodeProjectName for display purposes. The
// mapping is lossy, so this is only a fallback when a session has no cwd in
// its header (see applySummaryContext), which is authoritative.
func cleanProjectName(dirName string) string {
	s := strings.TrimPrefix(dirName, "--")
	s = strings.TrimSuffix(s, "--")
	if win, ok := decodeWindowsBody(s); ok {
		return win
	}
	return decodeProjectBody(s)
}

// decodeWindowsBody reverses the Windows body of EncodeProjectName: both :
// and \ became -, so a drive letter is always followed by two dashes.
// C--Users-me → C:\Users\me. Paths with literal hyphens decode wrongly, just
// like Unix paths; callers recover via the session-header cwd (see
// resolveLocation).
func decodeWindowsBody(s string) (string, bool) {
	if len(s) >= 3 && s[1] == '-' && s[2] == '-' &&
		(('A' <= s[0] && s[0] <= 'Z') || ('a' <= s[0] && s[0] <= 'z')) {
		return s[:1] + `:\` + strings.ReplaceAll(s[3:], "-", `\`), true
	}
	return "", false
}

// EncodeProjectName returns the session directory name pi itself uses for an
// absolute cwd, mirroring dist/core/session-manager.js:
//
//	`--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
//
// One leading separator is stripped and every /, \ and : becomes -. Writing
// the same directory pi writes keeps current-project session discovery
// working for pi and for SDK clients that scan the sessions tree.
//
//	/home/neven/code/xyz.net → --home-neven-code-xyz.net--
//	C:\Users\me\proj        → --C--Users-me-proj--
//
// The mapping is lossy: a literal hyphen is indistinguishable from a
// separator, so it cannot be reversed exactly. The session header cwd is the
// source of truth for recovering a path (see resolveLocation).
func EncodeProjectName(path string) string {
	s := strings.TrimSpace(path)
	if len(s) > 0 && (s[0] == '/' || s[0] == '\\') {
		s = s[1:]
	}
	s = strings.NewReplacer("/", "-", `\`, "-", ":", "-").Replace(s)
	return "--" + s + "--"
}

// DecodeProjectName is the lossy inverse of Pi's native encoding, used only
// when a session has no authoritative header cwd.
func DecodeProjectName(dirName string) string {
	s := strings.TrimPrefix(dirName, "--")
	s = strings.TrimSuffix(s, "--")
	if win, ok := decodeWindowsBody(s); ok {
		return win
	}
	s = decodeProjectBody(s)
	if s != "" && !strings.HasPrefix(s, "/") {
		s = "/" + s
	}
	return s
}

func decodeProjectBody(s string) string {
	return strings.ReplaceAll(s, "-", "/")
}

const maxRecentLocations = 10

type recentLocationDir struct {
	name    string
	modTime time.Time
}

func ListRecentLocations(sessionsDir string) ([]string, error) {
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return nil, err
	}
	dirs := make([]recentLocationDir, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		dirs = append(dirs, recentLocationDir{name: e.Name(), modTime: info.ModTime()})
	}
	sort.Slice(dirs, func(i, j int) bool {
		return dirs[i].modTime.After(dirs[j].modTime)
	})

	locations := make([]string, 0, maxRecentLocations)
	seen := make(map[string]bool)
	for _, dir := range dirs {
		loc := resolveLocation(sessionsDir, dir.name)
		if loc == "" || seen[loc] {
			continue
		}
		seen[loc] = true
		locations = append(locations, loc)
		if len(locations) == maxRecentLocations {
			break
		}
	}
	return locations, nil
}

// resolveLocation returns the project's absolute path for the given project
// directory name. The session header cwd is authoritative because
// EncodeProjectName is lossy (a literal hyphen looks like a separator). Only
// when the directory has no valid session header does it fall back to decoding
// the directory name.
func resolveLocation(sessionsDir, dirName string) string {
	if cwd := readSessionCWD(filepath.Join(sessionsDir, dirName)); cwd != "" {
		return cwd
	}
	return DecodeProjectName(dirName)
}

// readSessionCWD returns the cwd from the first valid session header found in
// any *.jsonl file in dir, or "" when none exists. The header cwd is the only
// lossless record of a project path, so it is preferred over decoding dir.
func readSessionCWD(dir string) string {
	matches, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil {
		return ""
	}
	for _, match := range matches {
		if cwd := sessionHeaderCWD(match); cwd != "" {
			return cwd
		}
	}
	return ""
}

func sessionHeaderCWD(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, scanInitialBufferBytes), maxScanLineBytes)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if len(line) == 0 {
			continue
		}
		var raw struct {
			Type string `json:"type"`
			CWD  string `json:"cwd"`
		}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		// Session headers belong at the start. Once the first parseable
		// record is not a valid header, the file has no usable header; a later
		// session-shaped line (e.g. a pasted transcript) must not win, and we
		// must not scan the rest of a potentially huge headerless file.
		if raw.Type == "session" && raw.CWD != "" {
			return raw.CWD
		}
		return ""
	}
	return ""
}

func CreateSessionFile(sessionsDir, directory string) (string, error) {
	directory = strings.TrimSpace(directory)
	if strings.HasPrefix(directory, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		directory = filepath.Join(home, directory[2:])
	}
	if !filepath.IsAbs(directory) {
		return "", errors.New("working directory must be absolute")
	}
	info, err := os.Stat(directory)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("working directory is not a directory")
	}
	project := filepath.Join(sessionsDir, EncodeProjectName(filepath.Clean(directory)))
	if err := os.MkdirAll(project, 0755); err != nil {
		return "", err
	}
	id, err := randomUUID()
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	filename := now.Format("2006-01-02T15-04-05.000Z") + "_" + id + ".jsonl"
	header, err := json.Marshal(map[string]any{
		"type": "session", "version": 3, "id": id, "timestamp": now.Format(time.RFC3339Nano), "cwd": filepath.Clean(directory),
	})
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(project, filename), append(header, '\n'), 0644); err != nil {
		return "", err
	}
	return filename, nil
}

func randomUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
