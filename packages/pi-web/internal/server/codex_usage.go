package server

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"sync"
	"time"

	"pi-web/internal/rpc"
)

const codexUsageURL = "https://chatgpt.com/backend-api/wham/usage"

type codexUsageWindow struct {
	ID               string  `json:"id"`
	WindowMinutes    int64   `json:"windowMinutes"`
	RemainingPercent float64 `json:"remainingPercent"`
	ResetsAt         int64   `json:"resetsAt,omitempty"`
}

type codexUsageSnapshot struct {
	Status    string             `json:"status"`
	Message   string             `json:"message,omitempty"`
	Plan      string             `json:"plan,omitempty"`
	Windows   []codexUsageWindow `json:"windows,omitempty"`
	UpdatedAt int64              `json:"updatedAt,omitempty"`
}

// One on-demand reader per Web server owns upstream polling, not a Pi session.
type codexUsageSource struct {
	mu        sync.Mutex
	cached    codexUsageSnapshot
	checkedAt time.Time
	client    *http.Client
	readAuth  func(context.Context, string) (rpc.CodexUsageAuth, error)
}

func newCodexUsageSource() *codexUsageSource {
	return &codexUsageSource{
		client: &http.Client{
			Transport:     http.DefaultTransport.(*http.Transport).Clone(),
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		readAuth: rpc.ReadCodexUsageAuth,
	}
}

func (source *codexUsageSource) read(ctx context.Context, agentDir string, refresh bool, now func() time.Time) codexUsageSnapshot {
	requestedAt := now()
	source.mu.Lock()
	defer source.mu.Unlock()
	// Concurrent drawers share a result, including an explicit refresh already in flight.
	if !source.checkedAt.IsZero() && ((!refresh && requestedAt.Sub(source.checkedAt) < time.Minute) || !source.checkedAt.Before(requestedAt)) {
		return source.cached
	}
	result := source.fetch(ctx, agentDir, now)
	if ctx.Err() == nil {
		source.cached, source.checkedAt = result, now()
	}
	return result
}

func (source *codexUsageSource) fetch(ctx context.Context, agentDir string, now func() time.Time) codexUsageSnapshot {
	unavailable := codexUsageSnapshot{Status: "unavailable", Message: "额度暂不可用，请稍后刷新"}
	credential, err := source.readAuth(ctx, agentDir)
	if err != nil {
		return unavailable
	}
	switch credential.Status {
	case "signed-out":
		return codexUsageSnapshot{Status: "signed-out", Message: "请先在电脑端 /login openai-codex"}
	case "auth-error":
		return codexUsageSnapshot{Status: "auth-error", Message: "Pi 登录不可用，请在电脑端重新登录 openai-codex"}
	case "ok":
	default:
		return unavailable
	}
	if credential.AccessToken == "" || credential.AccountID == "" {
		return unavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, codexUsageURL, nil)
	if err != nil {
		return unavailable
	}
	request.Header.Set("Authorization", "Bearer "+credential.AccessToken)
	request.Header.Set("ChatGPT-Account-Id", credential.AccountID)
	request.Header.Set("Accept", "application/json")
	response, err := source.client.Do(request)
	if err != nil {
		return unavailable
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusUnauthorized:
		return codexUsageSnapshot{Status: "auth-error", Message: "订阅登录已失效，请在电脑端重新登录 openai-codex"}
	case http.StatusTooManyRequests:
		return codexUsageSnapshot{Status: "unavailable", Message: "额度查询过于频繁，请稍后刷新"}
	case http.StatusOK:
	default:
		return unavailable
	}
	type window struct {
		UsedPercent *float64 `json:"used_percent"`
		Duration    *int64   `json:"limit_window_seconds"`
		ResetsAt    int64    `json:"reset_at"`
	}
	var payload struct {
		Plan      string `json:"plan_type"`
		RateLimit struct {
			Primary   *window `json:"primary_window"`
			Secondary *window `json:"secondary_window"`
		} `json:"rate_limit"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload); err != nil {
		return unavailable
	}
	result := codexUsageSnapshot{Status: "ok", Plan: payload.Plan, UpdatedAt: now().UnixMilli()}
	for index, value := range []*window{payload.RateLimit.Primary, payload.RateLimit.Secondary} {
		if value == nil || value.UsedPercent == nil || value.Duration == nil || *value.Duration < 60 || *value.UsedPercent < 0 {
			continue
		}
		result.Windows = append(result.Windows, codexUsageWindow{
			ID: []string{"primary", "secondary"}[index], WindowMinutes: *value.Duration / 60,
			RemainingPercent: math.Max(0, 100-*value.UsedPercent), ResetsAt: value.ResetsAt,
		})
	}
	if len(result.Windows) == 0 {
		return unavailable
	}
	return result
}

func (s *Server) handleCodexUsage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	writeJSON(w, 0, s.codexUsage.read(ctx, s.agentDir, r.URL.Query().Get("refresh") == "1", s.now))
}
