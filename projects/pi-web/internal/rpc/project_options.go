package rpc

import (
	"context"
	_ "embed"
)

//go:embed project_options.mjs
var projectOptionsScript string

// ProjectOptions loads Pi's model catalog without starting an execution worker.
func ProjectOptions(ctx context.Context, cwd, agentDir string) (map[string]any, error) {
	return runSDK(ctx, projectOptionsScript, cwd, agentDir)
}
