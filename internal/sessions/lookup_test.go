package sessions

import (
	"os"
	"path/filepath"
	"testing"
)

func writeSessionFile(t *testing.T, root, project, name string) string {
	t.Helper()
	dir := filepath.Join(root, project)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	content := `{"type":"session","version":3,"id":"sid","timestamp":"2026-05-06T00:00:00.000Z","cwd":"/tmp/project"}` + "\n" +
		`{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-05-06T00:00:01.000Z","message":{"role":"user","content":"hello","timestamp":1778025601000}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestResolveSessionByIDReturnsKnownPath(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	content, err := NewCache().OpenContent(root, "session.jsonl")
	if err != nil {
		t.Fatalf("Cache.OpenContent returned error: %v", err)
	}
	if content.ID != "session.jsonl" {
		t.Fatalf("ID = %q, want session.jsonl", content.ID)
	}
	window, err := content.Window("", "", nil)
	if err != nil || len(window.Messages) != 1 || window.Messages[0].Blocks[0].Text != "hello" {
		t.Fatalf("known native content was not returned: %+v, %v", window, err)
	}
}

func TestResolveSessionByIDRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	_, err := NewCache().OpenContent(root, "../session.jsonl")
	if err == nil {
		t.Fatalf("Cache.Resolve accepted traversal id")
	}
}

func TestResolveSessionByIDRejectsUnknown(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	_, err := NewCache().OpenContent(root, "missing.jsonl")
	if err == nil {
		t.Fatalf("Cache.Resolve accepted unknown id")
	}
}
