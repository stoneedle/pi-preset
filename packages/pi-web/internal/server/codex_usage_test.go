package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pi-web/internal/auth"
	"pi-web/internal/rpc"
)

type quotaTransport func(*http.Request) (*http.Response, error)

func (transport quotaTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestCodexUsageAPIReusesAuthCachesAndReturnsOnlyQuota(t *testing.T) {
	s := newTestServer(t)
	s.auth = auth.New("web-token")
	now := time.Now()
	s.now = func() time.Time { return now }
	calls := 0
	reads := 0
	s.codexUsage.readAuth = func(ctx context.Context, agentDir string) (rpc.CodexUsageAuth, error) {
		reads++
		if agentDir != s.agentDir {
			t.Fatal("credential source must be the current Pi agent directory")
		}
		return rpc.CodexUsageAuth{Status: "ok", AccessToken: "private-access", AccountID: "private-account"}, nil
	}
	s.codexUsage.client.Transport = quotaTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.URL.String() != codexUsageURL || request.Method != "GET" || request.Header.Get("Authorization") != "Bearer private-access" || request.Header.Get("ChatGPT-Account-Id") != "private-account" {
			t.Fatal("invalid authenticated quota request")
		}
		// A real account may have only a weekly primary window, not a five-hour window.
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"plan_type":"pro","email":"do-not-forward@example.test","access_token":"upstream-secret","rate_limit":{"primary_window":{"used_percent":94,"limit_window_seconds":604800,"reset_at":1793774146},"secondary_window":null}}`))}, nil
	})
	mux := http.NewServeMux()
	s.Register(mux)
	query := func(method, path, token string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, nil)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder
	}
	if response := query("GET", "/api/codex-usage", ""); response.Code != 401 || reads != 0 {
		t.Fatal("quota must require Web authentication before reading credentials")
	}
	if response := query("POST", "/api/codex-usage", "web-token"); response.Code != 405 || reads != 0 {
		t.Fatal("quota must be read-only")
	}
	response := query("GET", "/api/codex-usage", "web-token")
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response %d %v", response.Code, response.Header())
	}
	var snapshot codexUsageSnapshot
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Status != "ok" || snapshot.UpdatedAt != now.UnixMilli() || len(snapshot.Windows) != 1 || snapshot.Windows[0].WindowMinutes != 10080 || snapshot.Windows[0].RemainingPercent != 6 {
		t.Fatalf("wrong live quota: %+v", snapshot)
	}
	for _, secret := range []string{"private-access", "private-account", "upstream-secret", "do-not-forward"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatal("secret or unrelated upstream field reached browser")
		}
	}
	now = now.Add(time.Second)
	query("GET", "/api/codex-usage", "web-token")
	if calls != 1 || reads != 1 {
		t.Fatal("drawers must share the one-minute server cache")
	}
	query("GET", "/api/codex-usage?refresh=1", "web-token")
	if calls != 2 {
		t.Fatal("manual refresh must fetch current usage")
	}
	now = now.Add(61 * time.Second)
	query("GET", "/api/codex-usage", "web-token")
	if calls != 3 {
		t.Fatal("expired cache must be refreshed")
	}
	if _, err := os.Stat(filepath.Join(s.agentDir, "pi-web", "workers")); !os.IsNotExist(err) {
		t.Fatal("quota read created a Pi worker")
	}
}

func TestCodexUsageConcurrentDrawersShareInFlightRead(t *testing.T) {
	source := newCodexUsageSource()
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	source.readAuth = func(context.Context, string) (rpc.CodexUsageAuth, error) {
		if calls.Add(1) == 1 {
			close(entered)
		}
		<-release
		return rpc.CodexUsageAuth{Status: "signed-out"}, nil
	}
	first, second := make(chan codexUsageSnapshot, 1), make(chan codexUsageSnapshot, 1)
	go func() { first <- source.read(context.Background(), "unused", false, time.Now) }()
	<-entered
	go func() { second <- source.read(context.Background(), "unused", false, time.Now) }()
	close(release)
	if (<-first).Status != "signed-out" || (<-second).Status != "signed-out" || calls.Load() != 1 {
		t.Fatal("concurrent readers duplicated credential access")
	}
}

func TestCodexUsageFailuresNeverExposeCredentialsOrInventQuota(t *testing.T) {
	for _, fixture := range []struct {
		name, status, body, want string
		code                     int
	}{
		{name: "signed out", status: "signed-out", want: "signed-out"},
		{name: "refresh error", status: "auth-error", want: "auth-error"},
		{name: "unauthorized", status: "ok", code: 401, want: "auth-error"},
		{name: "rate limited", status: "ok", code: 429, want: "unavailable"},
		{name: "upstream error", status: "ok", code: 500, want: "unavailable"},
		{name: "bad json", status: "ok", code: 200, body: "private-access is not JSON", want: "unavailable"},
		{name: "missing windows", status: "ok", code: 200, body: `{"rate_limit":{}}`, want: "unavailable"},
		{name: "missing percentage", status: "ok", code: 200, body: `{"rate_limit":{"primary_window":{"limit_window_seconds":18000}}}`, want: "unavailable"},
		{name: "zero remaining", status: "ok", code: 200, body: `{"rate_limit":{"primary_window":{"used_percent":100,"limit_window_seconds":18000}}}`, want: "ok"},
		{name: "zero used", status: "ok", code: 200, body: `{"rate_limit":{"primary_window":{"used_percent":0,"limit_window_seconds":18000}}}`, want: "ok"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			source := newCodexUsageSource()
			source.readAuth = func(context.Context, string) (rpc.CodexUsageAuth, error) {
				return rpc.CodexUsageAuth{Status: fixture.status, AccessToken: "private-access", AccountID: "private-account"}, nil
			}
			source.client.Transport = quotaTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: fixture.code, Body: io.NopCloser(strings.NewReader(fixture.body))}, nil
			})
			result := source.read(context.Background(), "unused", false, time.Now)
			if result.Status != fixture.want {
				t.Fatalf("%+v", result)
			}
			if fixture.want != "ok" && (result.UpdatedAt != 0 || len(result.Windows) != 0) {
				t.Fatal("failure invented quota")
			}
			if strings.Contains(fmt.Sprint(result), "private-") {
				t.Fatal("failure exposed credential")
			}
			if fixture.name == "zero remaining" && result.Windows[0].RemainingPercent != 0 {
				t.Fatal("zero remaining lost")
			}
			if fixture.name == "zero used" && result.Windows[0].RemainingPercent != 100 {
				t.Fatal("zero usage lost")
			}
		})
	}
}
