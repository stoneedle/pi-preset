package server

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeReadersAllowNativeRevocation(t *testing.T) {
	for _, name := range []string{"heartbeat.json", "owner.json"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), name)
			if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
				t.Fatal(err)
			}
			reader, err := openRuntimeFile(path)
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			if err := os.Remove(path); err != nil {
				t.Fatalf("reader blocked native revocation: %v", err)
			}
			old, err := io.ReadAll(reader)
			if err != nil || string(old) != "old" {
				t.Fatalf("original snapshot = %q, %v", old, err)
			}
			reader.Close()
			if err := os.WriteFile(path, []byte("new"), 0o600); err != nil {
				t.Fatal(err)
			}
			current, err := readRuntimeFile(path)
			if err != nil || string(current) != "new" {
				t.Fatalf("current snapshot = %q, %v", current, err)
			}
		})
	}
}
