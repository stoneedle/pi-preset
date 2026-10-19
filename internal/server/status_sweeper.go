package server

import (
	"os"
	"strings"
	"time"
)

func (s *Server) sweepStatusOnce() {
	ids := make(map[string]bool)
	s.lastKnownMu.Lock()
	for id := range s.lastStates {
		ids[id] = true
	}
	s.lastKnownMu.Unlock()
	files, _ := os.ReadDir(s.sessionStatusDir())
	for _, file := range files {
		name := file.Name()
		if index := strings.Index(name, ".jsonl."); index >= 0 && strings.HasSuffix(name, ".json") {
			ids[name[:index+len(".jsonl")]] = true
		}
	}
	for id := range ids {
		s.recomputeAndBroadcastStatus(id)
	}
}

func (s *Server) runStatusSweeper(stop <-chan struct{}, interval time.Duration) {
	s.sweepStatusOnce()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.sweepStatusOnce()
		case <-stop:
			return
		}
	}
}
