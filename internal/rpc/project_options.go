package rpc

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
)

//go:embed project_options.mjs
var projectOptionsScript string

// ProjectOptions loads Pi's model catalog without starting an execution worker.
func ProjectOptions(ctx context.Context, cwd, agentDir string) (map[string]any, error) {
	binary, err := exec.LookPath("pi")
	if err != nil {
		return nil, err
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, err
	}
	base, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, node, "--input-type=module", "-", binary, base, cwd, agentDir)
	cmd.Stdin = bytes.NewBufferString(projectOptionsScript)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("读取 Pi 模型目录超时：%w", ctx.Err())
		}
		return nil, fmt.Errorf("无法读取 Pi 模型目录：%w", err)
	}
	var data map[string]any
	if err := json.Unmarshal(output, &data); err != nil {
		return nil, err
	}
	return data, nil
}
