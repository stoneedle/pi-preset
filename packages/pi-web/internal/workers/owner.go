package workers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/shirou/gopsutil/v4/process"
	"pi-web/internal/sessions"
)

// Registration locates a native control endpoint; it does not prove execution state.
type Registration struct {
	PID       int32  `json:"pid"`
	Port      int    `json:"port"`
	Token     string `json:"token"`
	SessionID string `json:"sessionId"`
}

func ReadRegistration(path string) (Registration, error) {
	data, err := readRuntimeFile(path)
	if err != nil {
		return Registration{}, err
	}
	var owner Registration
	if json.Unmarshal(data, &owner) != nil || !owner.valid() {
		return Registration{}, errors.New("invalid session owner")
	}
	return owner, nil
}

func (owner Registration) valid() bool {
	return owner.Port > 0 && owner.Port <= 65535 && owner.PID > 0 && owner.Token != "" && owner.SessionID != ""
}

func (m *Manager) owner(session sessions.Session) (*Registration, error) {
	if m.agentDir == "" {
		return nil, nil
	}
	owner, err := ReadRegistration(filepath.Join(m.agentDir, "pi-web", "owners", session.ID+".json"))
	missing := os.IsNotExist(err)
	if err != nil && !missing {
		return nil, err
	}
	if missing {
		m.mu.Lock()
		owner = m.owners[session.ID]
		m.mu.Unlock()
		if !owner.valid() {
			return nil, nil
		}
	}
	if owner.SessionID != session.SessionUUID {
		return nil, errors.New("session owner does not match native session")
	}
	alive, err := process.PidExists(owner.PID)
	if err != nil {
		return nil, fmt.Errorf("无法确认 Pi 实例是否仍在运行：%w", err)
	}
	if !alive {
		return nil, nil
	}
	m.mu.Lock()
	m.owners[session.ID] = owner
	m.mu.Unlock()
	if missing {
		return nil, errors.New("现有 Pi 实例仍在运行，正在等待控制连接恢复")
	}
	return &owner, nil
}

// Shutdown revalidates the native identity before ending only its process tree.
func (owner Registration) Shutdown(ctx context.Context) error {
	snapshot, err := owner.Call(ctx, map[string]any{"action": "state", "sessionId": owner.SessionID})
	if err != nil {
		return err
	}
	if snapshot["sessionId"] != owner.SessionID {
		return errors.New("无法确认 Pi 进程身份，未关闭进程")
	}
	if err := killProcessTree(ctx, owner.PID); err != nil {
		return fmt.Errorf("关闭 Pi 进程失败：%w", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		alive, err := process.PidExistsWithContext(ctx, owner.PID)
		if err != nil {
			return err
		}
		if !alive {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	return errors.New("Pi 进程尚未退出，请稍后查看连接状态")
}

func (owner Registration) Call(ctx context.Context, payload any) (map[string]any, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/remote", owner.Port), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+owner.Token)
	timeout := 5 * time.Second
	if command, ok := payload.(map[string]any); ok && command["action"] == "reload" {
		timeout = 40 * time.Second
	}
	client := &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接到现有 Pi 实例：%w", err)
	}
	defer response.Body.Close()
	limit := int64(2 << 20)
	if command, ok := payload.(map[string]any); ok && (command["action"] == "queue" || command["action"] == "queue-remove") {
		// Queue detail may contain the original image bytes; ordinary controls remain small.
		limit = 66 << 20
	}
	var reply map[string]any
	if err := json.NewDecoder(io.LimitReader(response.Body, limit)).Decode(&reply); err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("session owner: %v", reply["error"])
	}
	return reply, nil
}
