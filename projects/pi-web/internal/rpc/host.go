package rpc

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v4/process"
	"pi-web/internal/agentdir"
	"pi-web/internal/workers"
)

//go:embed host.mjs
var hostSource string

type hostConnection struct {
	net.Conn
	reader *bufio.Reader
}

func (c *hostConnection) Read(p []byte) (int, error) { return c.reader.Read(p) }

// openHost starts or attaches a session's independent RPC-pipe owner. It never
// replaces a registration whose process may still be alive.
func openHost(sessionPath string) (io.ReadWriteCloser, error) {
	file, err := os.Open(sessionPath)
	if err != nil {
		return nil, err
	}
	var header struct {
		ID string `json:"id"`
	}
	decoder := json.NewDecoder(file)
	err = decoder.Decode(&header)
	file.Close()
	if err != nil || header.ID == "" {
		return nil, errors.New("invalid native session header")
	}
	directory := filepath.Join(agentdir.Path(), "pi-web", "workers")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	registry := filepath.Join(directory, filepath.Base(sessionPath)+".json")
	var lastErr error
	starting := false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		owner, err := existingHost(registry, header.ID)
		if err != nil {
			return nil, err
		}
		if owner == nil {
			if !starting {
				if err := startHost(sessionPath, registry, header.ID); err != nil {
					return nil, err
				}
				starting = true
			}
		} else {
			starting = false
			connection, err := connectHost(*owner)
			if err == nil {
				return connection, nil
			}
			lastErr = err
			// Only bootstrap is retried. No RPC command has been delivered yet.
			// A retiring host must release its registration (or be confirmed dead)
			// before this loop can start its successor.
		}
		time.Sleep(50 * time.Millisecond)
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("Pi RPC host did not register; see " + registry + ".log")
}

func connectHost(owner workers.Registration) (io.ReadWriteCloser, error) {
	connection, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", owner.Port), time.Second)
	if err != nil {
		return nil, fmt.Errorf("现有 Pi 宿主暂不可达，不会启动替代实例：%w", err)
	}
	_ = connection.SetDeadline(time.Now().Add(time.Second))
	if err := json.NewEncoder(connection).Encode(map[string]string{"token": owner.Token}); err != nil {
		connection.Close()
		return nil, err
	}
	reader := bufio.NewReader(connection)
	line, err := reader.ReadBytes('\n')
	var reply struct {
		Ready bool `json:"ready"`
	}
	if err != nil || json.Unmarshal(line, &reply) != nil || !reply.Ready {
		connection.Close()
		return nil, errors.New("Pi RPC host handshake interrupted")
	}
	_ = connection.SetDeadline(time.Time{})
	return &hostConnection{Conn: connection, reader: reader}, nil
}

func existingHost(path, sessionID string) (*workers.Registration, error) {
	owner, err := workers.ReadRegistration(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if owner.SessionID != sessionID {
		return nil, errors.New("Pi RPC host does not match native session")
	}
	alive, err := process.PidExists(owner.PID)
	if err != nil {
		return nil, err
	}
	if alive {
		return &owner, nil
	}
	current, err := workers.ReadRegistration(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil && current == owner {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	return nil, nil
}

func startHost(sessionPath, registry, sessionID string) error {
	native, err := piCommand("--mode", "rpc", "--session", sessionPath)
	if err != nil {
		return err
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return err
	}
	config, err := json.Marshal(map[string]any{
		"command": native.Path, "args": native.Args[1:], "cwd": workerDir(sessionPath),
		"registry": registry, "sessionId": sessionID, "sessionPath": sessionPath,
		"agentDir": agentdir.Path(), "idleTTL": (5 * time.Hour).Milliseconds(),
	})
	if err != nil {
		return err
	}
	arguments := []string{"--input-type=module", "-e", hostSource, string(config)}
	command := exec.Command(node, arguments...)
	// systemd kills the complete Web service cgroup on restart. A separate
	// transient scope keeps the owned native runtime outside that cgroup.
	if runtime.GOOS == "linux" && os.Getenv("INVOCATION_ID") != "" {
		arguments = append([]string{"--user", "--scope", "--collect", "--quiet", node}, arguments...)
		command = exec.Command("systemd-run", arguments...)
	}
	command.Dir = workerDir(sessionPath)
	detachHost(command)
	log, err := os.OpenFile(registry+".log", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	command.Stdout, command.Stderr = log, log
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}

func connectWorker(sessionPath string) (*piRPCWorker, error) {
	connection, err := openHost(sessionPath)
	if err != nil {
		return nil, err
	}
	worker := &piRPCWorker{stdin: connection, status: workers.WorkerStatus{State: workers.WorkerStateIdle}, pending: make(map[string]chan response)}
	go worker.consume(connection)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := worker.GetState(ctx); err != nil {
		_ = worker.Close()
		return nil, fmt.Errorf("Pi worker failed to initialize: %w", err)
	}
	return worker, nil
}
