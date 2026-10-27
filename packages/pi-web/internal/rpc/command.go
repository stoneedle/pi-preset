package rpc

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func piCommand(args ...string) (*exec.Cmd, error) {
	binary, err := exec.LookPath("pi")
	if err != nil {
		return nil, fmt.Errorf("pi executable not found: %w", err)
	}
	if runtime.GOOS != "windows" || strings.EqualFold(filepath.Ext(binary), ".exe") {
		return exec.Command(binary, args...), nil
	}
	// Execute the npm CLI with Node, not cmd.exe: session paths remain literal arguments.
	entry := filepath.Join(filepath.Dir(binary), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
	if _, err := os.Stat(entry); err != nil {
		return nil, fmt.Errorf("Pi CLI entry unavailable: %w", err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, err
	}
	return exec.Command(node, append([]string{entry}, args...)...), nil
}
