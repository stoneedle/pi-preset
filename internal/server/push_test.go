package server

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pi-web/internal/auth"

	"github.com/golang-jwt/jwt/v5"
)

type pushReceiver func(*http.Request) (*http.Response, error)

func (receive pushReceiver) RoundTrip(request *http.Request) (*http.Response, error) {
	return receive(request)
}

func decryptPush(body, secret []byte, private *ecdh.PrivateKey) ([]byte, error) {
	if len(body) < 86 || body[20] != 65 {
		return nil, fmt.Errorf("invalid encrypted record")
	}
	public, err := ecdh.P256().NewPublicKey(body[21:86])
	if err != nil {
		return nil, err
	}
	shared, err := private.ECDH(public)
	if err != nil {
		return nil, err
	}
	info := append(append([]byte("WebPush: info\x00"), private.PublicKey().Bytes()...), public.Bytes()...)
	ikm, err := hkdf.Key(sha256.New, shared, secret, string(info), 32)
	if err != nil {
		return nil, err
	}
	key, err := hkdf.Key(sha256.New, ikm, body[:16], "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Key(sha256.New, ikm, body[:16], "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, body[86:], nil)
	if err != nil {
		return nil, err
	}
	plain = bytes.TrimRight(plain, "\x00")
	if len(plain) == 0 || plain[len(plain)-1] != 2 {
		return nil, fmt.Errorf("missing encrypted record delimiter")
	}
	return plain[:len(plain)-1], nil
}

func TestAuthenticatedWebPushLifecycle(t *testing.T) {
	agentDir := t.TempDir()
	sessionsDir := filepath.Join(agentDir, "sessions")
	path := writeSessionFile(t, sessionsDir, "--push--", "session.jsonl")
	secretBody := "PRIVATE_REPLY_BODY_MUST_NOT_BE_PUSHED"
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(file, `{"type":"message","id":"r1","parentId":"aaaaaaaa","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":%s}]}}`+"\n", jsonString(secretBody))
	file.Close()
	private, _ := ecdh.P256().GenerateKey(rand.Reader)
	secret := make([]byte, 16)
	rand.Read(secret)
	var offset, statusCode atomic.Int64
	statusCode.Store(201)
	var calls atomic.Int64
	type received struct {
		payload map[string]any
		headers http.Header
		err     error
	}
	messages := make(chan received, 32)
	client := &http.Client{Transport: pushReceiver(func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		code := int(statusCode.Load())
		body, err := io.ReadAll(request.Body)
		var payload map[string]any
		if err == nil {
			body, err = decryptPush(body, secret, private)
			if err == nil {
				err = json.Unmarshal(body, &payload)
			}
		}
		messages <- received{payload, request.Header.Clone(), err}
		return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	deps := Deps{AgentDir: agentDir, SessionsDir: sessionsDir, Auth: auth.New("control-token"), PushClient: client, Now: func() time.Time { return time.Now().Add(time.Duration(offset.Load()) * time.Second) }}
	s, err := New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Shutdown()
	mux := http.NewServeMux()
	s.Register(mux)
	remote := httptest.NewServer(mux)
	defer remote.Close()
	call := func(method, path string, body any, expected int) map[string]any {
		t.Helper()
		data, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, remote.URL+path, bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer control-token")
		req.Header.Set("Origin", remote.URL)
		req.Header.Set("Content-Type", "application/json")
		response, err := remote.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != expected {
			data, _ := io.ReadAll(response.Body)
			t.Fatalf("%s %s = %d: %s", method, path, response.StatusCode, data)
		}
		var result map[string]any
		json.NewDecoder(response.Body).Decode(&result)
		return result
	}
	wait := func(condition func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if condition() {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("notification lifecycle condition timed out")
	}
	config := call("GET", "/api/push/config", nil, 200)
	if len(config) != 1 || config["publicKey"] == "" {
		t.Fatalf("public-only config: %v", config)
	}
	unauthorized, _ := http.Get(remote.URL + "/api/push/config")
	unauthorized.Body.Close()
	if unauthorized.StatusCode != 401 {
		t.Fatal("push configuration bypassed auth")
	}
	subscription := pushSubscription{}
	subscription.Subscription.Endpoint = "https://web.push.apple.com/test-only-endpoint"
	subscription.Subscription.Keys.P256dh = base64.RawURLEncoding.EncodeToString(private.PublicKey().Bytes())
	subscription.Subscription.Keys.Auth = base64.RawURLEncoding.EncodeToString(secret)
	bad := subscription
	bad.Subscription.Endpoint = "https://127.0.0.1/private"
	call("POST", "/api/push/subscription", bad, 400)
	call("POST", "/api/push/subscription", subscription, 200)
	call("POST", "/api/push/subscription", subscription, 200)

	var ownerMu sync.Mutex
	snapshot := runtimeSnapshot{ID: "session.jsonl", Name: "Runtime session", SessionID: "sid", InstanceID: "native-owner", State: "running", MainRunning: true}
	listeners := make(map[chan runtimeSnapshot]bool)
	owner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer owner-token" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path != "/snapshot" {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, "{}")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		updates := make(chan runtimeSnapshot, 16)
		ownerMu.Lock()
		listeners[updates] = true
		initial := snapshot
		ownerMu.Unlock()
		defer func() { ownerMu.Lock(); delete(listeners, updates); ownerMu.Unlock() }()
		write := func(value runtimeSnapshot) {
			data, _ := json.Marshal(value)
			fmt.Fprintf(w, "data: %s\n\n", data)
			w.(http.Flusher).Flush()
		}
		write(initial)
		for {
			select {
			case value := <-updates:
				write(value)
			case <-r.Context().Done():
				return
			}
		}
	}))
	defer owner.Close()
	defer owner.CloseClientConnections()
	_, port, _ := net.SplitHostPort(owner.Listener.Addr().String())
	number, _ := strconv.Atoi(port)
	os.MkdirAll(filepath.Join(agentDir, "pi-web", "owners"), 0700)
	registration, _ := json.Marshal(remoteOwner{PID: int32(os.Getpid()), Port: number, Token: "owner-token", SessionID: "sid"})
	os.WriteFile(filepath.Join(agentDir, "pi-web", "owners", "session.jsonl.json"), registration, 0600)
	wait(func() bool { return call("GET", "/api/status?id=session.jsonl", nil, 200)["state"] == "running" })
	publish := func(value runtimeSnapshot) {
		ownerMu.Lock()
		value.Revision = snapshot.Revision + 1
		snapshot = value
		for listener := range listeners {
			listener <- snapshot
		}
		ownerMu.Unlock()
		wait(func() bool {
			return call("GET", "/api/status?id=session.jsonl", nil, 200)["revision"] == float64(value.Revision)
		})
	}
	unread, zero := true, 0
	for _, state := range []string{"running", "background", "unknown"} {
		value := snapshot
		value.State = state
		value.ReplyID = "r1"
		value.Completed = true
		value.Unread = &unread
		value.Outcome = "stop"
		publish(value)
	}
	if calls.Load() != 0 {
		t.Fatal("non-settled state sent a completion")
	}
	s.db.Exec(`INSERT INTO session_results(session_id,result_id,completed) VALUES('sid','r1',1)`)
	value := snapshot
	value.State = "idle"
	value.MainRunning = false
	value.Children = &zero
	publish(value)
	var first received
	select {
	case first = <-messages:
	case <-time.After(5 * time.Second):
		t.Fatal("no encrypted notification")
	}
	if first.err != nil {
		t.Fatal(first.err)
	}
	encoded, _ := json.Marshal(first.payload)
	if bytes.Contains(encoded, []byte(secretBody)) || first.payload["title"] != "Runtime session — 回复已就绪" || first.payload["url"] != remote.URL+"/session?id=session.jsonl" || first.payload["body"] != strings.TrimPrefix(remote.URL, "http://") {
		t.Fatalf("wrong or private notification: %s", encoded)
	}
	if first.headers.Get("Content-Encoding") != "aes128gcm" || first.headers.Get("TTL") != "86400" {
		t.Fatal("missing Web Push protocol headers")
	}
	authorization := strings.Split(strings.TrimPrefix(first.headers.Get("Authorization"), "vapid "), ",")
	publicBytes, _ := base64.RawURLEncoding.DecodeString(config["publicKey"].(string))
	x, y := elliptic.Unmarshal(elliptic.P256(), publicBytes)
	parsed, err := jwt.Parse(strings.TrimPrefix(authorization[0], "t="), func(*jwt.Token) (any, error) { return &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, nil }, jwt.WithValidMethods([]string{"ES256"}), jwt.WithAudience("https://web.push.apple.com"))
	if err != nil || !parsed.Valid {
		t.Fatalf("VAPID authentication invalid: %v", err)
	}
	wait(func() bool {
		return call("POST", "/api/push/status", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)["delivery"] == "accepted"
	})
	publish(snapshot)
	owner.CloseClientConnections()
	wait(func() bool {
		return call("GET", "/api/status?id=session.jsonl", nil, 200)["availability"] == "disconnected"
	})
	wait(func() bool {
		return call("GET", "/api/status?id=session.jsonl", nil, 200)["availability"] == "connected"
	})
	time.Sleep(100 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("snapshot/reconnect duplicated completion: %d", calls.Load())
	}
	if call("GET", "/api/status?id=session.jsonl", nil, 200)["unread"] != true {
		t.Fatal("push acknowledged the result")
	}
	call("POST", "/api/session/acknowledge?id=session.jsonl", map[string]string{"replyId": "r1"}, 200)
	if call("GET", "/api/push/eligibility?event="+first.payload["eventId"].(string), nil, 200)["active"] != false {
		t.Fatal("late push can resurrect a read result")
	}
	value = snapshot
	value.State = "needs-you"
	value.AttentionID = "prompt-1"
	value.AttentionKind = "confirm"
	publish(value)
	select {
	case attention := <-messages:
		if attention.err != nil || attention.payload["kind"] != "attention" || !strings.Contains(attention.payload["body"].(string), "确认操作") {
			t.Fatalf("wrong attention metadata: %v %v", attention.payload, attention.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no attention notification")
	}
	publish(snapshot)
	if calls.Load() != 2 {
		t.Fatal("attention repeated")
	}
	statusCode.Store(503)
	call("POST", "/api/push/test", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)
	select {
	case <-messages:
	case <-time.After(5 * time.Second):
		t.Fatal("no retryable request")
	}
	wait(func() bool {
		return call("POST", "/api/push/status", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)["failure"] == "http:503"
	})
	if _, err := s.db.Exec(`UPDATE push_subscriptions SET value=json_set(value,'$.strings',json_object('completed','old locale'))`); err != nil {
		t.Fatal(err)
	}
	remote.Close()
	s.Shutdown()
	statusCode.Store(201)
	offset.Store(30)
	s, err = New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Shutdown()
	mux = http.NewServeMux()
	s.Register(mux)
	remote = httptest.NewServer(mux)
	defer remote.Close()
	if call("GET", "/api/push/config", nil, 200)["publicKey"] != config["publicKey"] {
		t.Fatal("restart replaced notification credentials")
	}
	var localizedSubscriptions int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM push_subscriptions WHERE json_type(value,'$.strings') IS NOT NULL`).Scan(&localizedSubscriptions); err != nil || localizedSubscriptions != 0 {
		t.Fatalf("obsolete notification templates survived cleanup: count=%d, err=%v", localizedSubscriptions, err)
	}
	select {
	case <-messages:
	case <-time.After(5 * time.Second):
		t.Fatal("durable transient delivery was not retried after server restart")
	}
	wait(func() bool {
		return call("POST", "/api/push/status", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)["delivery"] == "accepted"
	})
	statusCode.Store(503)
	call("POST", "/api/push/test", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)
	var rotating received
	select {
	case rotating = <-messages:
	case <-time.After(5 * time.Second):
		t.Fatal("no delivery before subscription renewal")
	}
	wait(func() bool {
		return call("POST", "/api/push/status", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)["failure"] == "http:503"
	})
	oldEndpoint := subscription.Subscription.Endpoint
	subscription.PreviousEndpoint = oldEndpoint
	subscription.Subscription.Endpoint = "https://web.push.apple.com/renewed-test-only-endpoint"
	statusCode.Store(201)
	call("POST", "/api/push/subscription", subscription, 200)
	select {
	case renewed := <-messages:
		if renewed.err != nil || renewed.payload["eventId"] != rotating.payload["eventId"] {
			t.Fatal("renewal lost the pending native event identity")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pending delivery did not migrate to the renewed subscription")
	}
	if call("POST", "/api/push/status", map[string]string{"endpoint": oldEndpoint}, 200)["subscribed"] != false {
		t.Fatal("renewal kept the old endpoint active")
	}
	statusCode.Store(410)
	call("POST", "/api/push/test", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)
	select {
	case <-messages:
	case <-time.After(5 * time.Second):
		t.Fatal("no expiring endpoint request")
	}
	wait(func() bool {
		return call("POST", "/api/push/status", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)["subscribed"] == false
	})
	if call("POST", "/api/push/status", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)["failure"] != "expired" {
		t.Fatal("expired subscription was not visible")
	}
	call("DELETE", "/api/push/subscription", map[string]string{"endpoint": subscription.Subscription.Endpoint}, 200)
}
