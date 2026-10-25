package workers

import (
	"context"
	"errors"
	"sync"

	"pi-web/internal/chat"
	"pi-web/internal/sessions"
)

type State string

const (
	WorkerStateIdle    State = "idle"
	WorkerStateRunning State = "running"
	WorkerStateError   State = "error"
)

type WorkerStatus struct {
	State         State  `json:"state"`
	Error         string `json:"error,omitempty"`
	Model         string `json:"model,omitempty"`
	ModelName     string `json:"modelName,omitempty"`
	ModelProvider string `json:"modelProvider,omitempty"`
	ThinkingLevel string `json:"thinkingLevel,omitempty"`
}

type SlashCommand struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"`
}

type ChatWorker interface {
	Prompt(context.Context, chat.Request) error
	SetModel(context.Context, string, string) error
	SetThinkingLevel(context.Context, string) error
	Abort(context.Context) error
	GetCommands(context.Context) ([]SlashCommand, error)
	Status() WorkerStatus
	Close() error
}

type Factory func(sessionID, sessionPath string) (ChatWorker, error)

type execution struct {
	gate   chan struct{}
	worker ChatWorker
}

// Manager owns instance selection and serialized delivery, not native process lifetime.
// Reading history and observing activity never create an executor.
type Manager struct {
	mu         sync.Mutex
	executions map[string]*execution
	owners     map[string]Registration
	factory    Factory
	agentDir   string
	closed     bool
}

func NewManager(factory Factory, agentDir string) *Manager {
	return &Manager{factory: factory, agentDir: agentDir, executions: make(map[string]*execution), owners: make(map[string]Registration)}
}

func (m *Manager) entry(id string) *execution {
	e := m.executions[id]
	if e == nil {
		e = &execution{gate: make(chan struct{}, 1)}
		m.executions[id] = e
	}
	return e
}

func (m *Manager) Observe(id string, owner Registration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.closed && owner.valid() {
		m.owners[id] = owner
	}
}

func (m *Manager) run(ctx context.Context, id string, fn func(*execution) (map[string]any, error)) (map[string]any, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errors.New("Pi execution manager is closed")
	}
	e := m.entry(id)
	m.mu.Unlock()
	select {
	case e.gate <- struct{}{}:
		defer func() { <-e.gate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	m.mu.Lock()
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return nil, errors.New("Pi execution manager is closed")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return fn(e)
}

func (m *Manager) Ensure(ctx context.Context, session sessions.ResolvedSession) error {
	_, err := m.run(ctx, session.Session.ID, func(e *execution) (map[string]any, error) {
		owner, err := m.owner(session.Session)
		if err != nil || owner != nil {
			return nil, err
		}
		_, err = m.worker(e, session)
		return nil, err
	})
	return err
}

// Control never retries a delivered command. Only a user send may resume a dormant session.
func (m *Manager) Control(ctx context.Context, session sessions.ResolvedSession, command map[string]any) (map[string]any, error) {
	action, _ := command["action"].(string)
	return m.run(ctx, session.Session.ID, func(e *execution) (map[string]any, error) {
		owner, err := m.owner(session.Session)
		if err != nil {
			return nil, err
		}
		queued := false
		if action == "send" {
			request, ok := command["chat"].(chat.Request)
			if !ok {
				return nil, errors.New("invalid chat request")
			}
			queued = request.Delivery == "followUp"
			if queued && request.Settings != nil && len(request.Settings.Commands()) > 0 {
				return nil, errors.New("排队不修改当前运行设置，请先应用设置")
			}
		}
		var worker ChatWorker
		if owner == nil {
			if action == "send" && !queued {
				if !session.Session.ChatAvailable {
					return nil, errors.New(session.Session.ChatDisabledReason)
				}
				worker, err = m.worker(e, session)
				if err != nil {
					return nil, err
				}
				// Native startup registers its control bridge before RPC reports readiness.
				owner, err = m.owner(session.Session)
				if err != nil {
					return nil, err
				}
			} else {
				worker = e.worker
				if worker == nil || worker.Status().State == WorkerStateError {
					return nil, errors.New("当前会话尚未启动，发送消息后会自动连接 Pi")
				}
			}
		}
		call := func(input map[string]any) (map[string]any, error) {
			if owner != nil {
				input["sessionId"] = session.Session.SessionUUID
				return owner.Call(ctx, input)
			}
			return callWorker(ctx, worker, input)
		}
		if queued && owner != nil {
			state, err := call(map[string]any{"action": "state"})
			if err != nil {
				return nil, err
			}
			if state["canQueue"] != true {
				return nil, errors.New("当前 Pi 尚未提供排队控制，请先在电脑端 /reload")
			}
		}
		if action == "send" {
			request, ok := command["chat"].(chat.Request)
			if !ok {
				return nil, errors.New("invalid chat request")
			}
			if settings := request.Settings; settings != nil {
				for _, input := range settings.Commands() {
					if _, err := call(input); err != nil {
						return nil, err
					}
				}
			}
		}
		return call(command)
	})
}

// Rename uses the live owner when present; dormant metadata edits never start a worker.
func (m *Manager) Rename(ctx context.Context, session sessions.ResolvedSession, name string, persist func(context.Context, string, string) (string, error)) (string, error) {
	reply, err := m.run(ctx, session.Session.ID, func(e *execution) (map[string]any, error) {
		owner, err := m.owner(session.Session)
		if err != nil {
			return nil, err
		}
		if owner != nil {
			return owner.Call(ctx, map[string]any{"action": "rename-title", "sessionId": session.Session.SessionUUID, "name": name})
		}
		if e.worker != nil && e.worker.Status().State != WorkerStateError {
			return nil, errors.New("现有 Pi 实例未提供命名控制，请等待连接恢复")
		}
		saved, err := persist(ctx, session.Path, name)
		return map[string]any{"name": saved}, err
	})
	if err != nil {
		return "", err
	}
	saved, _ := reply["name"].(string)
	return saved, nil
}

// Fork captures the live owner's position without replacing or starting a runtime.
// The callback only reads the source and creates an independent session file.
func (m *Manager) Fork(ctx context.Context, session sessions.ResolvedSession, persist func(*string) (map[string]any, error)) (map[string]any, error) {
	return m.run(ctx, session.Session.ID, func(e *execution) (map[string]any, error) {
		owner, err := m.owner(session.Session)
		if err != nil {
			return nil, err
		}
		var leaf *string
		if owner != nil {
			state, err := owner.Call(ctx, map[string]any{"action": "state", "sessionId": session.Session.SessionUUID})
			if err != nil {
				return nil, err
			}
			value, exists := state["leafId"]
			if !exists || state["sessionId"] != session.Session.SessionUUID {
				return nil, errors.New("无法确认原生会话的分叉位置，请等待连接恢复")
			}
			id, valid := value.(string)
			if value != nil && !valid {
				return nil, errors.New("原生分叉位置无效")
			}
			leaf = &id
		} else if e.worker != nil && e.worker.Status().State != WorkerStateError {
			return nil, errors.New("现有 Pi 实例未提供分叉位置，请等待连接恢复")
		}
		return persist(leaf)
	})
}

func (m *Manager) worker(e *execution, session sessions.ResolvedSession) (ChatWorker, error) {
	if e.worker != nil {
		if e.worker.Status().State != WorkerStateError {
			return e.worker, nil
		}
		_ = e.worker.Close()
		e.worker = nil
	}
	if m.factory == nil {
		return nil, errors.New("Pi is unavailable")
	}
	worker, err := m.factory(session.Session.ID, session.Path)
	if err != nil {
		return nil, err
	}
	if worker == nil || worker.Status().State == WorkerStateError {
		if worker != nil {
			_ = worker.Close()
		}
		return nil, errors.New("Pi worker terminated during initialization")
	}
	e.worker = worker
	return worker, nil
}

func callWorker(ctx context.Context, worker ChatWorker, command map[string]any) (map[string]any, error) {
	var err error
	switch command["action"] {
	case "send":
		err = worker.Prompt(ctx, command["chat"].(chat.Request))
	case "abort":
		err = worker.Abort(ctx)
	case "model":
		err = worker.SetModel(ctx, command["provider"].(string), command["modelId"].(string))
	case "thinking":
		err = worker.SetThinkingLevel(ctx, command["level"].(string))
	case "models":
		return map[string]any{"models": []any{}}, nil
	case "commands":
		commands, commandErr := worker.GetCommands(ctx)
		skills := make([]SlashCommand, 0)
		for _, command := range commands {
			if command.Source == "skill" {
				skills = append(skills, command)
			}
		}
		return map[string]any{"commands": skills}, commandErr
	default:
		return nil, errors.New("当前 Pi 未提供此控制桥接")
	}
	return map[string]any{"status": "accepted"}, err
}

func (m *Manager) Close() error {
	m.mu.Lock()
	if !m.closed {
		m.closed = true
	}
	entries := make([]*execution, 0, len(m.executions))
	for _, e := range m.executions {
		entries = append(entries, e)
	}
	m.mu.Unlock()
	var result error
	for _, e := range entries {
		e.gate <- struct{}{}
		if e.worker != nil {
			result = errors.Join(result, e.worker.Close())
			e.worker = nil
		}
		<-e.gate
	}
	return result
}
