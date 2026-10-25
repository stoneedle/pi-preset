package workers

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"

	"pi-web/internal/chat"
	"pi-web/internal/sessions"
)

type fakeChatWorker struct {
	mu         sync.Mutex
	state      State
	actions    []string
	closed     atomic.Int32
	onPrompt   func()
	onCommands func()
}

func (w *fakeChatWorker) record(action string) {
	w.mu.Lock()
	w.actions = append(w.actions, action)
	w.mu.Unlock()
}
func (w *fakeChatWorker) Prompt(context.Context, chat.Request) error {
	w.record("send")
	if w.onPrompt != nil {
		w.onPrompt()
	}
	return nil
}
func (w *fakeChatWorker) SetModel(context.Context, string, string) error {
	w.record("model")
	return nil
}
func (w *fakeChatWorker) SetThinkingLevel(context.Context, string) error {
	w.record("thinking")
	return nil
}
func (w *fakeChatWorker) Abort(context.Context) error { w.record("abort"); return nil }
func (w *fakeChatWorker) GetCommands(context.Context) ([]SlashCommand, error) {
	if w.onCommands != nil {
		w.onCommands()
	}
	return []SlashCommand{{Name: "reload", Source: "extension"}, {Name: "skill:memory", Source: "skill"}}, nil
}
func (w *fakeChatWorker) Status() WorkerStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	return WorkerStatus{State: w.state}
}
func (w *fakeChatWorker) Close() error { w.closed.Add(1); return nil }

func target(id string) sessions.ResolvedSession {
	return sessions.ResolvedSession{Session: sessions.Session{SessionSummary: sessions.SessionSummary{ID: id, SessionUUID: id, ChatAvailable: true}}, Path: "/fixture/" + id}
}

func send(m *Manager, id string, settings *chat.Settings) error {
	_, err := m.Control(context.Background(), target(id), map[string]any{"action": "send", "chat": chat.Request{Message: "message", Settings: settings}})
	return err
}

func TestManagerCreatesAndReusesOneWorkerPerSession(t *testing.T) {
	var created atomic.Int32
	m := NewManager(func(id, path string) (ChatWorker, error) {
		if path != "/fixture/"+id {
			t.Error("resume changed session path")
		}
		created.Add(1)
		return &fakeChatWorker{}, nil
	}, "")
	t.Cleanup(func() { m.Close() })
	for _, id := range []string{"a.jsonl", "b.jsonl", "a.jsonl"} {
		if err := send(m, id, nil); err != nil {
			t.Fatal(err)
		}
	}
	if created.Load() != 2 {
		t.Fatalf("created=%d", created.Load())
	}
}

func TestManagerSerializesConcurrentStartAndDelivery(t *testing.T) {
	var created atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	worker := &fakeChatWorker{}
	m := NewManager(func(string, string) (ChatWorker, error) {
		created.Add(1)
		close(started)
		<-release
		return worker, nil
	}, "")
	t.Cleanup(func() { m.Close() })
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := send(m, "a.jsonl", nil); err != nil {
				t.Error(err)
			}
		}()
	}
	<-started
	close(release)
	wg.Wait()
	if created.Load() != 1 || len(worker.actions) != 8 {
		t.Fatalf("created=%d actions=%v", created.Load(), worker.actions)
	}
}

func TestManagerPassiveCommandsDoNotStartWorkers(t *testing.T) {
	var created atomic.Int32
	m := NewManager(func(string, string) (ChatWorker, error) { created.Add(1); return &fakeChatWorker{}, nil }, "")
	t.Cleanup(func() { m.Close() })
	for _, action := range []string{"model", "thinking", "speed", "commands", "models", "abort", "acknowledge"} {
		if _, err := m.Control(context.Background(), target("a.jsonl"), map[string]any{"action": action}); err == nil {
			t.Fatalf("%s started a dormant session", action)
		}
	}
	if created.Load() != 0 {
		t.Fatal("passive controls created worker")
	}
}

func TestManagerExplicitNewSessionStartsWithoutPrompt(t *testing.T) {
	worker := &fakeChatWorker{}
	m := NewManager(func(string, string) (ChatWorker, error) { return worker, nil }, "")
	t.Cleanup(func() { m.Close() })
	if err := m.Ensure(context.Background(), target("new.jsonl")); err != nil {
		t.Fatal(err)
	}
	if len(worker.actions) != 0 {
		t.Fatal("prepare sent a message")
	}
	response, err := m.Control(context.Background(), target("new.jsonl"), map[string]any{"action": "commands"})
	if err != nil {
		t.Fatal(err)
	}
	commands := response["commands"].([]SlashCommand)
	if len(commands) != 1 || commands[0].Name != "skill:memory" {
		t.Fatalf("commands=%v", commands)
	}
}

func TestManagerAppliesFrozenSettingsBeforeFirstPrompt(t *testing.T) {
	worker := &fakeChatWorker{}
	m := NewManager(func(string, string) (ChatWorker, error) { return worker, nil }, "")
	t.Cleanup(func() { m.Close() })
	if err := send(m, "a.jsonl", &chat.Settings{Provider: "test", ModelID: "selected", Thinking: "high"}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(worker.actions, []string{"model", "thinking", "send"}) {
		t.Fatal(worker.actions)
	}
	if err := send(m, "a.jsonl", &chat.Settings{Speed: "fast"}); err == nil {
		t.Fatal("unsupported setting must fail before sending")
	}
	if len(worker.actions) != 3 {
		t.Fatal("failed settings delivered message")
	}
}

func TestManagerFailedStartIsNotReplayedAndNextSendResumes(t *testing.T) {
	created := 0
	m := NewManager(func(string, string) (ChatWorker, error) {
		created++
		if created == 1 {
			return nil, errors.New("startup failed")
		}
		return &fakeChatWorker{}, nil
	}, "")
	t.Cleanup(func() { m.Close() })
	if send(m, "a.jsonl", nil) == nil || created != 1 {
		t.Fatal("failed start was silently retried")
	}
	if err := send(m, "a.jsonl", nil); err != nil {
		t.Fatal(err)
	}
	if created != 2 {
		t.Fatal(created)
	}
}

func TestManagerReplacesErroredWorkerOnlyOnNewSend(t *testing.T) {
	worker := &fakeChatWorker{}
	created := 0
	m := NewManager(func(string, string) (ChatWorker, error) {
		created++
		if created == 1 {
			return worker, nil
		}
		return &fakeChatWorker{}, nil
	}, "")
	t.Cleanup(func() { m.Close() })
	if err := send(m, "a.jsonl", nil); err != nil {
		t.Fatal(err)
	}
	worker.mu.Lock()
	worker.state = WorkerStateError
	worker.mu.Unlock()
	if err := send(m, "a.jsonl", nil); err != nil {
		t.Fatal(err)
	}
	if created != 2 || worker.closed.Load() != 1 {
		t.Fatal("did not replace failed process")
	}
}

func TestManagerCanceledSendNeverStartsWorker(t *testing.T) {
	m := NewManager(func(string, string) (ChatWorker, error) { t.Fatal("canceled send started worker"); return nil, nil }, "")
	t.Cleanup(func() { m.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := m.Control(ctx, target("a.jsonl"), map[string]any{"action": "send", "chat": chat.Request{Message: "canceled"}})
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestManagerClosedNeverStartsWorker(t *testing.T) {
	m := NewManager(func(string, string) (ChatWorker, error) { t.Fatal("started after close"); return nil, nil }, "")
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if err := send(m, "a.jsonl", nil); err == nil {
		t.Fatal("closed manager accepted send")
	}
}
