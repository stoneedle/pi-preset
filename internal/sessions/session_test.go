package sessions

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEncodeProjectName(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		// Native pi encoding: strip one leading separator, then map every
		// /, \ and : to - (dist/core/session-manager.js).
		{"/Users/setkyar", "--Users-setkyar--"},
		{"/home/user/project", "--home-user-project--"},
		// The issue's example: a dot in the last segment is untouched.
		{"/home/neven/code/xyz.net", "--home-neven-code-xyz.net--"},
		{"/a/b/c/d", "--a-b-c-d--"},
		{"/Users/setkyar/pi-web", "--Users-setkyar-pi-web--"},
		// Literal hyphens and underscores are preserved verbatim; the result is
		// therefore ambiguous, which is why the header cwd is authoritative.
		{"/Users/setkyar/my-project", "--Users-setkyar-my-project--"},
		{"/Users/setkyar/_cache", "--Users-setkyar-_cache--"},
		{"/a/_b/_c", "--a-_b-_c--"},
		// Windows-shaped paths use the same mapping, so : and \ become - too.
		{`C:\Users\me\proj`, "--C--Users-me-proj--"},
		{`c:\work`, "--c--work--"},
		{`C:/Users/me/proj`, "--C--Users-me-proj--"},
		{`\\server\share\proj`, "---server-share-proj--"},
	}
	for _, tt := range tests {
		got := EncodeProjectName(tt.input)
		if got != tt.expected {
			t.Errorf("EncodeProjectName(%q) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}

func TestDecodeProjectName(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		// Native encoding: - always decodes to /.
		{"--Users-setkyar--", "/Users/setkyar"},
		{"--home-user-project--", "/home/user/project"},
		{"--home-neven-code-xyz.net--", "/home/neven/code/xyz.net"},
		// A lone underscore is not a marker, so it survives the native decode.
		{"--Users-setkyar-_cache--", "/Users/setkyar/_cache"},
		// Literal hyphens are indistinguishable from separators in native names.
		{"--Users-setkyar-my-project--", "/Users/setkyar/my/project"},
		// Windows dash encoding: drive letter followed by two dashes
		// (both : and \ became -).
		{"--C--Users-me-proj--", `C:\Users\me\proj`},
		{"--c--work--", `c:\work`},
		{"--C--my_app--", `C:\my_app`},
	}
	for _, tt := range tests {
		got := DecodeProjectName(tt.input)
		if got != tt.expected {
			t.Errorf("DecodeProjectName(%q) = %q, want %q", tt.input, got, tt.expected)
		}
	}
}

func TestEncodeDecodeRoundTripWithoutAmbiguousCharacters(t *testing.T) {
	paths := []string{
		"/Users/setkyar",
		"/home/user/project",
		"/a/b/c/d",
		"/home/neven/code/xyz.net",
		"/foo_/bar",
		"/foo__bar/baz",
	}
	for _, p := range paths {
		encoded := EncodeProjectName(p)
		decoded := DecodeProjectName(encoded)
		if decoded != p {
			t.Errorf("round-trip failed: %q -> %q -> %q", p, encoded, decoded)
		}
	}
}

func TestDecodeProjectNameNativeNamesAreLossy(t *testing.T) {
	// Native encoding cannot round-trip these; the session header cwd is the
	// source of truth. This documents the ambiguity instead of asserting
	// losslessness.
	paths := []string{
		"/Users/setkyar/my-project",
		"/project-with-hyphens/sub_dir",
	}
	for _, p := range paths {
		if decoded := DecodeProjectName(EncodeProjectName(p)); decoded == p {
			t.Errorf("expected lossy round-trip for %q, got %q", p, decoded)
		}
	}
}

func TestSortSummariesByActivityOrdersNewestFirst(t *testing.T) {
	summaries := []SessionSummary{
		{ID: "old", LastActivity: "2026-02-27T15:13:25.383Z"},
		{ID: "older", LastActivity: "2026-02-27T15:16:22.278Z"},
		{ID: "newest", LastActivity: "2026-05-18T19:05:05.064Z"},
		{ID: "middle", LastActivity: "2026-05-06T17:10:28.485Z"},
		{ID: "newer", LastActivity: "2026-05-18T18:59:50.965Z"},
	}

	SortSummariesByActivity(summaries)

	got := make([]string, len(summaries))
	for i := range summaries {
		got[i] = summaries[i].ID
	}
	want := []string{"newest", "newer", "middle", "older", "old"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("sorted IDs = %v, want %v", got, want)
	}
}

func TestSortSummariesByActivityKeepsInvalidTimestampsLast(t *testing.T) {
	summaries := []SessionSummary{
		{ID: "invalid", LastActivity: "not-a-time"},
		{ID: "newest", LastActivity: "2026-05-18T19:05:05.064Z"},
		{ID: "empty", LastActivity: ""},
		{ID: "older", LastActivity: "2026-02-27T15:16:22.278Z"},
	}

	SortSummariesByActivity(summaries)

	got := make([]string, len(summaries))
	for i := range summaries {
		got[i] = summaries[i].ID
	}
	want := []string{"newest", "older", "invalid", "empty"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("sorted IDs = %v, want %v", got, want)
	}
}

func TestListRecentLocationsReturnsNewestBoundedLocations(t *testing.T) {
	tmp := t.TempDir()
	base := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)

	for i := 0; i < 15; i++ {
		// A plain literal, not filepath.Join: on Windows Join would produce
		// backslash paths and the assertions below expect /tmp/projectNN.
		project := fmt.Sprintf("/tmp/project%02d", i)
		dir := filepath.Join(tmp, EncodeProjectName(project))
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("mkdir project dir: %v", err)
		}
		mtime := base.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, mtime, mtime); err != nil {
			t.Fatalf("chtimes project dir: %v", err)
		}
	}

	locations, err := ListRecentLocations(tmp)
	if err != nil {
		t.Fatalf("ListRecentLocations failed: %v", err)
	}
	if len(locations) != 10 {
		t.Fatalf("expected 10 bounded locations, got %d: %#v", len(locations), locations)
	}
	if locations[0] != "/tmp/project14" {
		t.Fatalf("expected newest project first, got %q", locations[0])
	}
	if locations[9] != "/tmp/project05" {
		t.Fatalf("expected tenth newest project last, got %q", locations[9])
	}
}

func TestListRecentLocationsRecoversHyphenatedNativePaths(t *testing.T) {
	tmp := t.TempDir()

	// Native pi encoding for a path with a literal hyphen:
	// /tmp/my-project  →  --tmp-my-project--
	nativeDir := filepath.Join(tmp, "--tmp-my-project--")
	if err := os.MkdirAll(nativeDir, 0755); err != nil {
		t.Fatal(err)
	}
	// Write a session file with the real cwd in the header.
	sessionPath := filepath.Join(nativeDir, "2026-05-08T10-00-00.000Z_abc.jsonl")
	content := `{"type":"session","version":3,"id":"abc","timestamp":"2026-05-08T10:00:00Z","cwd":"/tmp/my-project"}` + "\n"
	if err := os.WriteFile(sessionPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	locations, err := ListRecentLocations(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if len(locations) != 1 {
		t.Fatalf("expected exactly 1 location, got %#v", locations)
	}
	if locations[0] != "/tmp/my-project" {
		t.Fatalf("expected recovered path /tmp/my-project, got %q", locations[0])
	}
}

func TestResolveLocationUsesNativeHeader(t *testing.T) {
	tmp := t.TempDir()
	sessionsDir := filepath.Join(tmp, "sessions")
	// Unix-shaped literal so the assertion is identical on every platform;
	// resolveLocation reads the header cwd, which need not exist on disk.
	const realPath = "/Users/setkyar/custom-project_dir"

	projectDir := filepath.Join(sessionsDir, "arbitrary-project-directory")
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := `{"type":"session","version":3,"id":"abc","timestamp":"2026-05-08T10:00:00Z","cwd":"` + realPath + `"}` + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, "s.jsonl"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	locations, err := ListRecentLocations(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(locations) != 1 || locations[0] != realPath {
		t.Fatalf("locations = %#v, want [%q]", locations, realPath)
	}
}

func TestResolveLocationFallsBackToDecodedNameWithoutHeader(t *testing.T) {
	tmp := t.TempDir()

	// Hyphen-free name: native decode is exact for it, and this exercises the
	// no-session-header fallback path.
	realPath := filepath.Join(tmp, "myproject")
	if err := os.MkdirAll(realPath, 0755); err != nil {
		t.Fatal(err)
	}

	sessionsDir := filepath.Join(tmp, "sessions")
	encodedDir := filepath.Join(sessionsDir, EncodeProjectName(realPath))
	if err := os.MkdirAll(encodedDir, 0755); err != nil {
		t.Fatal(err)
	}

	locations, err := ListRecentLocations(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(locations) != 1 {
		t.Fatalf("expected exactly 1 location, got %#v", locations)
	}
	if locations[0] != realPath {
		t.Fatalf("expected %q, got %q", realPath, locations[0])
	}
}

func TestResolveLocationPrefersHeaderCwdOverLossyDecode(t *testing.T) {
	tmp := t.TempDir()
	sessionsDir := filepath.Join(tmp, "sessions")

	// Both /…/my/project and /…/my-project exist, so a name-only decode is
	// plausible but wrong; the header cwd must win.
	split := filepath.Join(tmp, "my", "project")
	joined := filepath.Join(tmp, "my-project")
	for _, p := range []string{split, joined} {
		if err := os.MkdirAll(p, 0755); err != nil {
			t.Fatal(err)
		}
	}

	projectDir := filepath.Join(sessionsDir, EncodeProjectName(joined))
	if err := os.MkdirAll(projectDir, 0755); err != nil {
		t.Fatal(err)
	}
	cwdJSON, err := json.Marshal(joined)
	if err != nil {
		t.Fatal(err)
	}
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z","cwd":` + string(cwdJSON) + `}` + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, "s.jsonl"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	locations, err := ListRecentLocations(sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(locations) != 1 || locations[0] != joined {
		t.Fatalf("locations = %#v, want [%q] (not the lossy decode)", locations, joined)
	}
}

func TestReadSessionCWDStopsAtFirstNonHeaderRecord(t *testing.T) {
	tmp := t.TempDir()

	// a.jsonl starts with a message and only later carries a session-shaped
	// line; that later line must be ignored, and the file must not be scanned
	// further. It sorts before b.jsonl, so accepting the fake header would
	// change the result below.
	fake := `{"type":"message","timestamp":"2026-05-08T10:00:00Z","message":{"role":"user","content":"hi"}}` + "\n" +
		`{"type":"session","timestamp":"2026-05-08T10:00:01Z","cwd":"/fake/later/header"}` + "\n"
	if err := os.WriteFile(filepath.Join(tmp, "a.jsonl"), []byte(fake), 0644); err != nil {
		t.Fatal(err)
	}

	// A separate file whose first record is a proper header is still found.
	good := `{"type":"session","timestamp":"2026-05-08T10:00:00Z","cwd":"/real/project"}` + "\n"
	if err := os.WriteFile(filepath.Join(tmp, "b.jsonl"), []byte(good), 0644); err != nil {
		t.Fatal(err)
	}

	if got := readSessionCWD(tmp); got != "/real/project" {
		t.Fatalf("readSessionCWD = %q, want %q", got, "/real/project")
	}
}

// piEncodeProjectDir is an independent restatement of pi's directory encoding
// (dist/core/session-manager.js) used as a test oracle.
func piEncodeProjectDir(path string) string {
	s := path
	if len(s) > 0 && (s[0] == '/' || s[0] == '\\') {
		s = s[1:]
	}
	s = strings.NewReplacer("/", "-", `\`, "-", ":", "-").Replace(s)
	return "--" + s + "--"
}

func TestCreateSessionFile(t *testing.T) {
	tmpDir := t.TempDir()
	sessDir := filepath.Join(tmpDir, "sessions")
	projectPath := filepath.Join(tmpDir, "test-project")
	if err := os.MkdirAll(projectPath, 0755); err != nil {
		t.Fatal(err)
	}
	id, err := CreateSessionFile(sessDir, projectPath)
	if err != nil {
		t.Fatalf("CreateSessionFile failed: %v", err)
	}
	if !strings.HasSuffix(id, ".jsonl") {
		t.Fatalf("expected .jsonl suffix, got %q", id)
	}

	// Verify file exists
	projectDir := filepath.Join(sessDir, EncodeProjectName(projectPath))
	entries, err := os.ReadDir(projectDir)
	if err != nil {
		t.Fatalf("project dir not created: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 file, got %d", len(entries))
	}

	// Verify content starts with session header
	data, err := os.ReadFile(filepath.Join(projectDir, entries[0].Name()))
	if err != nil {
		t.Fatalf("read file failed: %v", err)
	}
	if !strings.Contains(string(data), `"type":"session"`) {
		t.Fatalf("missing session header: %s", string(data))
	}
	wantCwd, err := json.Marshal(projectPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"cwd":`+string(wantCwd)) {
		t.Fatalf("missing cwd: %s", string(data))
	}
}

func TestCreateSessionFileUsesNativePiProjectDirectory(t *testing.T) {
	tmp := t.TempDir()
	sessDir := filepath.Join(tmp, "sessions")
	// A hyphen and an underscore: native pi leaves both verbatim.
	projectPath := filepath.Join(tmp, "native-project_dir")
	if err := os.MkdirAll(projectPath, 0755); err != nil {
		t.Fatal(err)
	}
	id, err := CreateSessionFile(sessDir, projectPath)
	if err != nil {
		t.Fatalf("CreateSessionFile failed: %v", err)
	}

	wantDir := piEncodeProjectDir(projectPath)
	if _, err := os.Stat(filepath.Join(sessDir, wantDir, id)); err != nil {
		t.Fatalf("session not written to native pi directory %q: %v", wantDir, err)
	}
}

func TestCreateSessionFileAcceptsLegitimateDoubleDotInName(t *testing.T) {
	tmp := t.TempDir()
	dir := filepath.Join(tmp, "..hidden-project")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	id, err := CreateSessionFile(tmp, dir)
	if err != nil {
		t.Fatalf("expected legitimate ..hidden path to be accepted, got %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty session id")
	}
}

func TestCreateSessionFileRejectsRelativePath(t *testing.T) {
	tmp := t.TempDir()
	if _, err := CreateSessionFile(tmp, "relative/foo"); err == nil {
		t.Fatal("expected error for relative path, got nil")
	}
}

func TestParseSummaryHandlesLargeToolResultLine(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")

	// A single tool-result message line larger than the old 4MB scanner cap.
	// Before the buffer bump, scanner.Err() returns bufio.ErrTooLong and the
	// whole session is dropped from the index.
	big := strings.Repeat("a", 8*1024*1024)
	content := `{"type":"session","name":"Big Session","timestamp":"2026-05-08T10:00:00Z"}` + "\n" +
		`{"type":"message","timestamp":"2026-05-08T10:00:01Z","message":{"role":"user","content":"hello"}}` + "\n" +
		`{"type":"message","timestamp":"2026-05-08T10:00:02Z","message":{"role":"assistant","content":"` + big + `"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "s.jsonl")
	if err != nil {
		t.Fatalf("ParseSummary returned error on large line: %v", err)
	}
	if s.Name != "Big Session" {
		t.Errorf("Name = %q, want %q", s.Name, "Big Session")
	}
}

func TestParseSummaryUsesHeaderName(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	content := `{"type":"session","name":"My Project","timestamp":"2026-05-08T10:00:00Z"}` + "\n" +
		`{"type":"message","timestamp":"2026-05-08T10:00:01Z","message":{"role":"user","content":"hello"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "My Project" {
		t.Errorf("Name = %q, want %q", s.Name, "My Project")
	}
}

func TestParseSummaryUsesSessionInfoName(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z"}` + "\n" +
		`{"type":"message","timestamp":"2026-05-08T10:00:01Z","message":{"role":"user","content":"first user line"}}` + "\n" +
		`{"type":"session_info","timestamp":"2026-05-08T10:00:02Z","name":"Renamed Session"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "Renamed Session" {
		t.Errorf("Name = %q, want %q", s.Name, "Renamed Session")
	}
}

func TestParseSummarySessionInfoOverridesHeaderName(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	content := `{"type":"session","name":"Header Name","timestamp":"2026-05-08T10:00:00Z"}` + "\n" +
		`{"type":"session_info","timestamp":"2026-05-08T10:00:01Z","name":"Session Info Name"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "Session Info Name" {
		t.Errorf("Name = %q, want %q", s.Name, "Session Info Name")
	}
}

func TestParseSummarySessionInfoLatestWins(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z"}` + "\n" +
		`{"type":"session_info","timestamp":"2026-05-08T10:00:01Z","name":"First Rename"}` + "\n" +
		`{"type":"session_info","timestamp":"2026-05-08T10:00:02Z","name":"Second Rename"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "Second Rename" {
		t.Errorf("Name = %q, want %q", s.Name, "Second Rename")
	}
}

func TestParseSummaryFallsBackToFirstUserMessage(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z"}` + "\n" +
		`{"type":"message","timestamp":"2026-05-08T10:00:01Z","message":{"role":"user","content":"first user line"}}` + "\n" +
		`{"type":"message","timestamp":"2026-05-08T10:00:02Z","message":{"role":"user","content":"second user line"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "first user line" {
		t.Errorf("Name = %q, want %q", s.Name, "first user line")
	}
}

func TestParseSummaryTruncatesNameAt80(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	long := strings.Repeat("x", 120)
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z"}` + "\n" +
		`{"type":"message","timestamp":"2026-05-08T10:00:01Z","message":{"role":"user","content":"` + long + `"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Repeat("x", 80) + "…"
	if s.Name != want {
		t.Errorf("Name = %q, want %q", s.Name, want)
	}
}

func TestParseSummaryTruncatesUnicodeNameAt80Runes(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	// Each "🎉" is a 4-byte UTF-8 sequence; 90 of them = 360 bytes but only 90 runes.
	long := strings.Repeat("🎉", 90)
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z"}` + "\n" +
		`{"type":"message","timestamp":"2026-05-08T10:00:01Z","message":{"role":"user","content":"` + long + `"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Repeat("🎉", 80) + "…"
	if s.Name != want {
		t.Errorf("Name length = %d runes, want 81+ellipsis; got %q", len([]rune(s.Name)), s.Name)
	}
}

func TestParseSummaryFallsBackToFilename(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "fallback.jsonl")
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "fallback.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.Name != "fallback.jsonl" {
		t.Errorf("Name = %q, want %q", s.Name, "fallback.jsonl")
	}
}

func TestParseSummaryExtractsSessionUUID(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	content := `{"type":"session","id":"019e122d-bcc4-7308-8a30-7ef83dae1983","timestamp":"2026-05-08T10:00:00Z"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--proj--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.SessionUUID != "019e122d-bcc4-7308-8a30-7ef83dae1983" {
		t.Errorf("SessionUUID = %q, want %q", s.SessionUUID, "019e122d-bcc4-7308-8a30-7ef83dae1983")
	}
}

func TestParseFileMarksSessionBrokenWhenCwdMissing(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	content := `{"type":"session","version":3,"id":"sid","timestamp":"2026-05-06T00:00:00.000Z","cwd":"/definitely/missing/path"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	sess, err := ParseFile(path, "--tmp-project--", "session.jsonl")
	if err != nil {
		t.Fatalf("ParseFile failed: %v", err)
	}
	if sess.ChatAvailable {
		t.Fatal("expected chat to be disabled for missing cwd")
	}
	if !strings.Contains(sess.ChatDisabledReason, "working directory is unavailable") {
		t.Fatalf("reason = %q", sess.ChatDisabledReason)
	}
}

func TestParseSummaryUsesHeaderCwdAsProject(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z","cwd":"/Users/setkyar/pi-web"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	s, err := ParseSummary(path, "--Users-setkyar-pi-web--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.Project != "/Users/setkyar/pi-web" {
		t.Errorf("Project = %q, want %q", s.Project, "/Users/setkyar/pi-web")
	}
}

func TestParseSummaryFallsBackToDirNameWhenCwdMissing(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "s.jsonl")
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z"}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	// dir name as produced by EncodeProjectName for /Users/setkyar/pi/web.
	s, err := ParseSummary(path, "--Users-setkyar-pi-web--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.Project != "Users/setkyar/pi/web" {
		t.Errorf("Project = %q, want %q", s.Project, "Users/setkyar/pi/web")
	}
	if s.ChatAvailable {
		t.Fatal("missing native cwd must be view-only")
	}
}

func TestParseFileUsesHeaderCwdAsProject(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "project")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "s.jsonl")
	// json.Marshal the cwd: Windows paths contain backslashes, which are
	// invalid JSON when concatenated raw.
	cwdJSON, err := json.Marshal(cwd)
	if err != nil {
		t.Fatal(err)
	}
	content := `{"type":"session","timestamp":"2026-05-08T10:00:00Z","cwd":` + string(cwdJSON) + `}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	sess, err := ParseFile(path, "--tmp-project--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if sess.Project != cwd {
		t.Errorf("Project = %q, want %q", sess.Project, cwd)
	}
}

func TestParseFileDeduplicatesRepeatedSessionHeader(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	rootJSON, err := json.Marshal(root)
	if err != nil {
		t.Fatal(err)
	}
	header := `{"type":"session","id":"sid","timestamp":"2026-05-08T10:00:00Z","cwd":` + string(rootJSON) + `}`
	content := header + "\n" +
		header + "\n" +
		`{"type":"message","id":"u1","parentId":"sid","timestamp":"2026-05-08T10:00:01Z","message":{"role":"user","content":"hello"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	sess, err := ParseFile(path, "--tmp-project--", "session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if len(sess.Entries) != 2 {
		t.Fatalf("entries = %d, want 2 (%#v)", len(sess.Entries), sess.Entries)
	}
	if sess.Entries[0]["type"] != "session" || sess.Entries[1]["type"] != "message" {
		t.Fatalf("unexpected entries: %#v", sess.Entries)
	}
}

func TestParseFileLeavesChatEnabledWhenCwdExists(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "project")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "session.jsonl")
	cwdJSON, err := json.Marshal(cwd)
	if err != nil {
		t.Fatal(err)
	}
	content := `{"type":"session","version":3,"id":"sid","timestamp":"2026-05-06T00:00:00.000Z","cwd":` + string(cwdJSON) + `}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	sess, err := ParseFile(path, "--tmp-project--", "session.jsonl")
	if err != nil {
		t.Fatalf("ParseFile failed: %v", err)
	}
	if !sess.ChatAvailable {
		t.Fatalf("expected chat to be enabled, reason = %q", sess.ChatDisabledReason)
	}
}
