package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"pi-web/internal/chat"
	"pi-web/internal/workers"
)

type piRPCWorker struct {
	mu                   sync.Mutex
	writeMu              sync.Mutex
	stdin                io.WriteCloser
	status               workers.WorkerStatus
	seq                  atomic.Uint64
	pending              map[string]chan response
	currentModel         string
	currentProvider      string
	currentThinkingLevel string
	commands             []workers.SlashCommand
	commandsCached       bool
}

// workerDir loads the session's own project resources instead of inheriting
// the web service's checkout. Missing native directories fall back to temp.
func workerDir(sessionPath string) string {
	if cwd := sessionHeaderCWD(sessionPath); cwd != "" {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			return cwd
		}
	}
	return detachedPiDir()
}

// detachedPiDir avoids loading project configuration from the server checkout.
func detachedPiDir() string {
	return os.TempDir()
}

func sessionHeaderCWD(sessionPath string) string {
	f, err := os.Open(sessionPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return ""
	}
	var hdr struct {
		Type string `json:"type"`
		CWD  string `json:"cwd"`
	}
	if json.Unmarshal(sc.Bytes(), &hdr) != nil || hdr.Type != "session" {
		return ""
	}
	return strings.TrimSpace(hdr.CWD)
}

func NewPiWorker(sessionPath string) (workers.ChatWorker, error) {
	return connectWorker(sessionPath)
}

func (w *piRPCWorker) Prompt(ctx context.Context, chat chat.Request) error {
	if chat.Delivery == "followUp" {
		return errors.New("排队需要原生控制桥接，请在电脑端 /reload")
	}
	w.mu.Lock()
	streaming := w.status.State == workers.WorkerStateRunning
	w.status = workers.WorkerStatus{State: workers.WorkerStateRunning}
	w.mu.Unlock()
	id := w.nextID()
	if err := w.sendAndAwait(ctx, BuildPromptCommand(id, chat, streaming)); err != nil {
		w.mu.Lock()
		w.status = workers.WorkerStatus{State: workers.WorkerStateError, Error: err.Error()}
		w.mu.Unlock()
		return err
	}
	return nil
}

func (w *piRPCWorker) SetModel(ctx context.Context, provider, modelID string) error {
	id := w.nextID()
	ch := make(chan response, 1)
	w.mu.Lock()
	w.pending[id] = ch
	w.mu.Unlock()

	cmd := map[string]any{
		"id":       id,
		"type":     "set_model",
		"provider": provider,
		"modelId":  modelID,
	}
	w.writeMu.Lock()
	err := WriteCommand(w.stdin, cmd)
	w.writeMu.Unlock()
	if err != nil {
		w.removePending(id)
		return err
	}

	select {
	case res := <-ch:
		if !res.Success {
			if res.Error != "" {
				return errors.New(res.Error)
			}
			return fmt.Errorf("rpc set_model rejected")
		}
		var m model
		if err := json.Unmarshal(res.Data, &m); err != nil {
			// Some responses wrap the model in a "model" field
			var wrapper struct {
				Model model `json:"model"`
			}
			if err2 := json.Unmarshal(res.Data, &wrapper); err2 == nil && wrapper.Model.ID != "" {
				m = wrapper.Model
			}
		}
		if m.ID == "" {
			return fmt.Errorf("set_model returned empty model id")
		}
		if m.Provider != provider || m.ID != modelID {
			return fmt.Errorf("set_model returned unexpected model: %s/%s (wanted %s/%s)", m.Provider, m.ID, provider, modelID)
		}
		w.mu.Lock()
		w.currentModel = m.ID
		w.currentProvider = m.Provider
		w.status.Model = m.ID
		w.status.ModelName = m.Name
		w.status.ModelProvider = m.Provider
		w.mu.Unlock()
		// Refresh thinking level after model switch
		go w.refreshThinkingLevel()
		return nil
	case <-ctx.Done():
		w.removePending(id)
		return ctx.Err()
	}
}

func (w *piRPCWorker) SetThinkingLevel(ctx context.Context, level string) error {
	return w.sendAndAwait(ctx, BuildSetThinkingLevelCommand(w.nextID(), level))
}

func (w *piRPCWorker) Abort(ctx context.Context) error {
	if err := w.sendAndAwait(ctx, BuildAbortCommand(w.nextID())); err != nil {
		return err
	}
	return nil
}

func (w *piRPCWorker) GetState(ctx context.Context) (workers.WorkerStatus, error) {
	id := w.nextID()
	ch := make(chan response, 1)
	w.mu.Lock()
	w.pending[id] = ch
	w.mu.Unlock()

	w.writeMu.Lock()
	err := WriteCommand(w.stdin, BuildGetStateCommand(id))
	w.writeMu.Unlock()
	if err != nil {
		w.removePending(id)
		w.setError(err)
		return workers.WorkerStatus{}, err
	}

	select {
	case res := <-ch:
		if !res.Success {
			if res.Error != "" {
				return workers.WorkerStatus{}, errors.New(res.Error)
			}
			return workers.WorkerStatus{}, fmt.Errorf("rpc get_state rejected")
		}
		var state struct {
			ThinkingLevel string `json:"thinkingLevel"`
			Model         model  `json:"model"`
		}
		_ = json.Unmarshal(res.Data, &state)
		w.mu.Lock()
		w.currentThinkingLevel = state.ThinkingLevel
		if state.Model.ID != "" {
			w.currentModel = state.Model.ID
			w.currentProvider = state.Model.Provider
			w.status.Model = state.Model.ID
			w.status.ModelName = state.Model.Name
			w.status.ModelProvider = state.Model.Provider
		}
		s := w.status
		s.ThinkingLevel = state.ThinkingLevel
		w.mu.Unlock()
		return s, nil
	case <-ctx.Done():
		w.removePending(id)
		return workers.WorkerStatus{}, ctx.Err()
	}
}

// GetCommands returns the slash commands pi loaded for this session (skills,
// prompt templates, and extension commands). The set is fixed for a worker's
// lifetime, so the first successful result is cached and reused.
func (w *piRPCWorker) GetCommands(ctx context.Context) ([]workers.SlashCommand, error) {
	w.mu.Lock()
	if w.commandsCached {
		cmds := w.commands
		w.mu.Unlock()
		return cmds, nil
	}
	w.mu.Unlock()

	id := w.nextID()
	ch := make(chan response, 1)
	w.mu.Lock()
	w.pending[id] = ch
	w.mu.Unlock()

	w.writeMu.Lock()
	err := WriteCommand(w.stdin, BuildGetCommandsCommand(id))
	w.writeMu.Unlock()
	if err != nil {
		w.removePending(id)
		return nil, err
	}

	select {
	case res := <-ch:
		if !res.Success {
			if res.Error != "" {
				return nil, errors.New(res.Error)
			}
			return nil, fmt.Errorf("rpc get_commands rejected")
		}
		var payload struct {
			Commands []workers.SlashCommand `json:"commands"`
		}
		if err := json.Unmarshal(res.Data, &payload); err != nil {
			return nil, err
		}
		w.mu.Lock()
		w.commands = payload.Commands
		w.commandsCached = true
		w.mu.Unlock()
		return payload.Commands, nil
	case <-ctx.Done():
		w.removePending(id)
		return nil, ctx.Err()
	}
}

func (w *piRPCWorker) refreshThinkingLevel() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = w.GetState(ctx)
}

func (w *piRPCWorker) Status() workers.WorkerStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	s := w.status
	s.Model = w.currentModel
	s.ModelProvider = w.currentProvider
	s.ThinkingLevel = w.currentThinkingLevel
	return s
}

func (w *piRPCWorker) Close() error {
	if w.stdin != nil {
		_ = w.stdin.Close()
	}
	return nil
}

func (w *piRPCWorker) nextID() string {
	return fmt.Sprintf("req-%d", w.seq.Add(1))
}

func (w *piRPCWorker) sendAndAwait(ctx context.Context, cmd map[string]any) error {
	id, _ := cmd["id"].(string)
	if id == "" {
		return errors.New("rpc command missing id")
	}
	ch := make(chan response, 1)
	w.mu.Lock()
	w.pending[id] = ch
	w.mu.Unlock()

	w.writeMu.Lock()
	err := WriteCommand(w.stdin, cmd)
	w.writeMu.Unlock()
	if err != nil {
		w.removePending(id)
		return err
	}

	select {
	case res := <-ch:
		if !res.Success {
			if res.Error != "" {
				return errors.New(res.Error)
			}
			return fmt.Errorf("rpc %s rejected", res.Command)
		}
		return nil
	case <-ctx.Done():
		w.removePending(id)
		return ctx.Err()
	}
}

func (w *piRPCWorker) removePending(id string) {
	w.mu.Lock()
	delete(w.pending, id)
	w.mu.Unlock()
}

func (w *piRPCWorker) consume(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		w.handleRPCLine(line)
	}
	if err := scanner.Err(); err != nil {
		w.setError(err)
		return
	}
	w.setError(io.ErrUnexpectedEOF)
}

func (w *piRPCWorker) handleRPCLine(line string) {
	var meta struct {
		Type  string `json:"type"`
		Level string `json:"level"`
	}
	if err := json.Unmarshal([]byte(line), &meta); err != nil {
		return
	}
	switch meta.Type {
	case "response":
		var res response
		if err := json.Unmarshal([]byte(line), &res); err != nil {
			return
		}
		w.mu.Lock()
		ch := w.pending[res.ID]
		delete(w.pending, res.ID)
		w.mu.Unlock()
		if ch != nil {
			ch <- res
		}
	case "agent_start":
		w.mu.Lock()
		w.status.State = workers.WorkerStateRunning
		w.mu.Unlock()
	case "agent_settled":
		w.mu.Lock()
		w.status.State = workers.WorkerStateIdle
		w.mu.Unlock()
	case "thinking_level_changed":
		if meta.Level != "" {
			w.mu.Lock()
			w.currentThinkingLevel = meta.Level
			w.mu.Unlock()
		}
	}
}

func (w *piRPCWorker) setError(err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.status.State != workers.WorkerStateError {
		w.status = workers.WorkerStatus{State: workers.WorkerStateError, Error: err.Error()}
	}
	for id, ch := range w.pending {
		delete(w.pending, id)
		ch <- response{ID: id, Type: "response", Success: false, Error: err.Error()}
	}
}
