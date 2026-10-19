package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/fsnotify/fsnotify"
)

// sessionStatusDir returns the directory that terminal sessions write
// status files into. Mirrors readSessionStatus's path computation so a
// single change keeps both callers consistent.
func (s *Server) sessionStatusDir() string {
	return filepath.Join(s.agentDir, "session-status")
}

// startSessionStatusWatcher watches the session-status/ directory for
// writes/creates. On every event it triggers a status recompute for the
// affected session id (file basename). Returns an error if fsnotify cannot
// be initialised; callers may choose to log and continue (the 1s sweeper
// is a sufficient correctness backstop).
func (s *Server) startSessionStatusWatcher() error {
	dir := s.sessionStatusDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("ensure session-status dir: %w", err)
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	if err := w.Add(dir); err != nil {
		_ = w.Close()
		return err
	}

	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer w.Close()
		for {
			select {
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				if ev.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Rename|fsnotify.Remove) == 0 {
					continue
				}
				name := filepath.Base(ev.Name)
				if index := strings.Index(name, ".jsonl."); index >= 0 && strings.HasSuffix(name, ".json") {
					s.recomputeAndBroadcastStatus(name[:index+len(".jsonl")])
				}
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				fmt.Fprintf(os.Stderr, "session-status watcher: %v\n", err)
			case <-s.stopCh:
				return
			}
		}
	}()
	return nil
}
