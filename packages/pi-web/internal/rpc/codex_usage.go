package rpc

import (
	"context"
	_ "embed"
)

//go:embed codex_usage_auth.mjs
var codexUsageAuthScript string

// CodexUsageAuth is internal request auth, never a browser API payload.
type CodexUsageAuth struct {
	Status      string
	AccessToken string
	AccountID   string
}

func ReadCodexUsageAuth(ctx context.Context, agentDir string) (CodexUsageAuth, error) {
	data, err := runSDK(ctx, codexUsageAuthScript, agentDir)
	if err != nil {
		return CodexUsageAuth{}, err
	}
	value := func(key string) string { result, _ := data[key].(string); return result }
	return CodexUsageAuth{
		Status: value("status"), AccessToken: value("accessToken"),
		AccountID: value("accountId"),
	}, nil
}
