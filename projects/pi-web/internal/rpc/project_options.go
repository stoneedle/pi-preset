package rpc

import (
	"context"
	_ "embed"
)

//go:embed project_options.mjs
var projectOptionsScript string

//go:embed project_commands.mjs
var projectCommandsScript string

// ProjectCommands reads installed skill resources without loading extensions or starting Pi.
func ProjectCommands(ctx context.Context, cwd, agentDir string) (map[string]any, error) {
	return runSDK(ctx, projectCommandsScript, cwd, agentDir)
}

// ProjectOptions loads Pi's model catalog without starting an execution worker.
func ProjectOptions(ctx context.Context, cwd, agentDir string) (map[string]any, error) {
	return runSDK(ctx, projectOptionsScript, cwd, agentDir)
}
