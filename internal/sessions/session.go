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

// Native routing metadata deliberately excludes content, arguments and details.
type summaryLine struct {
	Type      string      `json:"type"`
	Timestamp string      `json:"timestamp"`
	Name      string      `json:"name"`
	CWD       string      `json:"cwd"`
	ID        string      `json:"id"`
	ParentID  string      `json:"parentId"`
	Message   *summaryMsg `json:"message"`
}

type summaryMsg struct {
	Role       string `json:"role"`
	StopReason string `json:"stopReason"`
	ToolCallID string `json:"toolCallId"`
	IsError    bool   `json:"isError"`
}

type SessionSummary struct {
	ID                 string
	SessionUUID        string
	Project            string
	LastActivity       string
	CreatedAt          string
	Name               string
	LastReplyID        string
	ChatAvailable      bool
	ChatDisabledReason string
}

type Session struct {
	SessionSummary
	Header map[string]any
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

// applySummaryContext finalizes native naming, activity and CWD availability.
func applySummaryContext(s *SessionSummary, fileName, sessionInfoName, headerName, firstUserText, headerCwd string) {
	if s.LastActivity == "" {
		s.LastActivity = s.CreatedAt
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

// ParseSummary reads the same body-free native index used by content access.
func ParseSummary(path, dirName, fileName string) (SessionSummary, error) {
	content, err := readContentIndex(path, dirName, fileName)
	if err != nil {
		return SessionSummary{}, err
	}
	return content.SessionSummary, nil
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
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

func ResolveDirectory(directory string) (string, error) {
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
	return filepath.Clean(directory), nil
}

func CreateSessionFile(sessionsDir, directory string) (string, error) {
	directory, err := ResolveDirectory(directory)
	if err != nil {
		return "", err
	}
	project := filepath.Join(sessionsDir, EncodeProjectName(directory))
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
