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

//go:embed sdk.mjs
var sdkResolverScript string

// SDK-only operations do not construct an AgentSession or load extensions.
func runSDK(ctx context.Context, script string, args ...string) (map[string]any, error) {
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
	cmd := exec.CommandContext(ctx, node, append([]string{"--input-type=module", "-", binary, base}, args...)...)
	cmd.Stdin = bytes.NewBufferString(sdkResolverScript + "\n" + script)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("Pi SDK: %w: %s", err, stderr.String())
	}
	var data map[string]any
	if err := json.Unmarshal(output, &data); err != nil {
		return nil, err
	}
	return data, nil
}

// ForkSessionFile uses a separate manager: createBranchedSession replaces that
// manager's identity, not the original Pi runtime or its source file.
func ForkSessionFile(ctx context.Context, path, sessionID, entryID, name string) (map[string]any, error) {
	return runSDK(ctx, `
const { SessionManager } = await import(new URL('./core/session-manager.js', pathToFileURL(entry)));
const { mkdtempSync, renameSync, rmSync } = await import('node:fs');
const { basename } = await import('node:path');
const directory = dirname(sdkArgs[0]);
// Publish only a complete native file; a cancelled helper cannot expose half a fork.
const staging = mkdtempSync(join(directory, '.pi-web-fork-'));
try {
  const manager = SessionManager.open(sdkArgs[0], staging);
  if (manager.getSessionId() !== sdkArgs[1]) throw new Error('源会话已更换，请刷新后再试');
  if (!manager.getEntry(sdkArgs[2])) throw new Error('分叉节点已变化，请刷新后再试');
  const file = manager.createBranchedSession(sdkArgs[2]);
  manager.appendSessionInfo(sdkArgs[3] + ' · 分支');
  renameSync(file, join(directory, basename(file)));
  process.stdout.write(JSON.stringify({id:basename(file),sessionId:manager.getSessionId()}));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
`, path, sessionID, entryID, name)
}

func RenameSessionFile(ctx context.Context, path, name string) (string, error) {
	data, err := runSDK(ctx, `
const { SessionManager } = await import(new URL('./core/session-manager.js', pathToFileURL(entry)));
const manager = SessionManager.open(sdkArgs[0]);
manager.appendSessionInfo(sdkArgs[1]);
process.stdout.write(JSON.stringify({name:manager.getSessionName()}));
`, path, name)
	if err != nil {
		return "", err
	}
	saved, _ := data["name"].(string)
	return saved, nil
}
