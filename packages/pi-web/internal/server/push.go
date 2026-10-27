package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type pushSubscription struct {
	Subscription     webpush.Subscription `json:"subscription"`
	Origin           string               `json:"origin"`
	PreviousEndpoint string               `json:"previousEndpoint,omitempty"`
}

type pushEvent struct {
	Key       string `json:"eventId"`
	Kind      string `json:"kind"`
	SessionID string `json:"sessionId"`
	File      string `json:"file"`
	Name      string `json:"name"`
	Identity  string `json:"identity"`
	Reason    string `json:"reason"`
	Created   int64  `json:"created"`
	Sequence  int64  `json:"sequence,omitempty"`
}

type pushDelivery struct {
	event        pushEvent
	subscription pushSubscription
	attempt      int
	retryAfter   time.Duration
}

type pushModule struct {
	db     *sql.DB
	now    func() time.Time
	client *http.Client
	keys   struct {
		Private string `json:"private"`
		Public  string `json:"public"`
	}
	wake      chan struct{}
	pendingMu sync.Mutex
	pending   map[string]pushEvent
}

func newPushModule(db *sql.DB, now func() time.Time, client *http.Client) (*pushModule, error) {
	if client == nil {
		client = &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone(), Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	p := &pushModule{db: db, now: now, client: client, wake: make(chan struct{}, 1), pending: make(map[string]pushEvent)}
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS push_events(event_key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS push_deliveries(event_key TEXT NOT NULL, endpoint TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(event_key,endpoint))`,
		`CREATE INDEX IF NOT EXISTS push_due ON push_deliveries(state,due)`,
		`UPDATE push_subscriptions SET value=json_remove(value,'$.strings') WHERE json_type(value,'$.strings') IS NOT NULL`,
	} {
		if _, err := db.Exec(statement); err != nil {
			return nil, err
		}
	}
	if _, err := db.Exec(`UPDATE push_deliveries SET state='pending',due=? WHERE state='sending'`, now().Unix()); err != nil {
		return nil, err
	}
	var encoded string
	err := db.QueryRow(`SELECT value FROM settings WHERE key='pi-web:push:vapid'`).Scan(&encoded)
	if err == sql.ErrNoRows {
		p.keys.Private, p.keys.Public, err = webpush.GenerateVAPIDKeys()
		if err == nil {
			data, _ := json.Marshal(p.keys)
			_, err = db.Exec(`INSERT INTO settings(key,value) VALUES('pi-web:push:vapid',?)`, string(data))
		}
	} else if err == nil {
		err = json.Unmarshal([]byte(encoded), &p.keys)
		if p.keys.Private == "" || p.keys.Public == "" {
			err = errors.New("stored Web Push credentials are invalid; existing keys were not replaced")
		}
	}
	return p, err
}

func (p *pushModule) observe(snapshot runtimeSnapshot) error {
	if snapshot.Availability != "connected" || snapshot.SessionID == "" {
		return nil
	}
	event := pushEvent{SessionID: snapshot.SessionID, File: snapshot.ID, Name: snapshot.Name, Created: p.now().Unix()}
	switch {
	case snapshot.State == "needs-you" && snapshot.AttentionID != "":
		event.Kind, event.Identity, event.Reason = "attention", snapshot.AttentionID, snapshot.AttentionKind
	case snapshot.State == "idle" && snapshot.Completed && snapshot.Unread != nil && *snapshot.Unread && snapshot.ReplyID != "" && (snapshot.Outcome == "stop" || snapshot.Outcome == "length"):
		event.Kind, event.Identity = "completed", snapshot.ReplyID
	default:
		return nil
	}
	err := p.enqueue(event, "")
	p.pendingMu.Lock()
	if err != nil {
		p.pending[event.SessionID+"\x00"+event.Kind] = event
	}
	p.pendingMu.Unlock()
	return err
}

func (p *pushModule) retryObserved() {
	p.pendingMu.Lock()
	var key string
	var event pushEvent
	for key, event = range p.pending {
		break
	}
	p.pendingMu.Unlock()
	if key == "" {
		return
	}
	if p.now().Unix()-event.Created < 86400 && p.enqueue(event, "") != nil {
		return
	}
	p.pendingMu.Lock()
	if p.pending[key].Identity == event.Identity {
		delete(p.pending, key)
	}
	p.pendingMu.Unlock()
}

func (p *pushModule) enqueue(event pushEvent, endpoint string) error {
	digest := sha256.Sum256([]byte(event.SessionID + "\x00" + event.Kind + "\x00" + event.Identity))
	event.Key = base64.RawURLEncoding.EncodeToString(digest[:])
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	tx, err := p.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`INSERT OR IGNORE INTO push_events(event_key,value) VALUES(?,?)`, event.Key, string(data))
	if err != nil {
		return err
	}
	inserted, _ := result.RowsAffected()
	if inserted != 0 {
		_, err = tx.Exec(`INSERT INTO push_deliveries(event_key,endpoint,due) SELECT ?,endpoint,? FROM push_subscriptions WHERE ?='' OR endpoint=?`, event.Key, event.Created, endpoint, endpoint)
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(); err == nil && inserted != 0 {
		select {
		case p.wake <- struct{}{}:
		default:
		}
	}
	return err
}

func (p *pushModule) run(stop <-chan struct{}, active func(pushEvent) (bool, error)) {
	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			p.deliver(ctx, active)
		}()
	}
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	for {
		select {
		case <-stop:
			cancel()
			workers.Wait()
			p.client.CloseIdleConnections()
			return
		case <-timer.C:
			p.retryObserved()
		}
	}
}

func (p *pushModule) claim(ctx context.Context) (*pushDelivery, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var eventJSON, subscriptionJSON string
	var sequence int64
	job := &pushDelivery{}
	err = tx.QueryRowContext(ctx, `SELECT e.rowid,e.value,s.value,d.attempt FROM push_deliveries d JOIN push_events e ON e.event_key=d.event_key JOIN push_subscriptions s ON s.endpoint=d.endpoint WHERE d.state IN ('pending','sending') AND d.due<=? ORDER BY d.due,d.event_key LIMIT 1`, p.now().Unix()).Scan(&sequence, &eventJSON, &subscriptionJSON, &job.attempt)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(eventJSON), &job.event); err != nil {
		return nil, err
	}
	job.event.Sequence = sequence
	if err = json.Unmarshal([]byte(subscriptionJSON), &job.subscription); err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE push_deliveries SET state='sending',attempt=attempt+1,due=? WHERE event_key=? AND endpoint=?`, p.now().Add(time.Minute).Unix(), job.event.Key, job.subscription.Subscription.Endpoint)
	if err != nil {
		return nil, err
	}
	return job, tx.Commit()
}

func (p *pushModule) deliver(ctx context.Context, active func(pushEvent) (bool, error)) {
	timer := time.NewTicker(time.Second)
	defer timer.Stop()
	for ctx.Err() == nil {
		job, err := p.claim(ctx)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			case <-p.wake:
			case <-timer.C:
			}
			continue
		}
		state, failure := "skipped", ""
		if p.now().Unix()-job.event.Created < 86400 {
			eligible, err := active(job.event)
			if err != nil {
				state, failure = "pending", "state-unavailable"
			} else if eligible {
				state, failure = p.send(ctx, job)
			}
		}
		if ctx.Err() != nil {
			return
		}
		delay := max(time.Duration(min(3600, 15<<min(job.attempt, 8)))*time.Second, job.retryAfter)
		_, _ = p.db.Exec(`UPDATE push_deliveries SET state=?,error=?,due=? WHERE event_key=? AND endpoint=?`, state, failure, p.now().Add(delay).Unix(), job.event.Key, job.subscription.Subscription.Endpoint)
	}
}

func (p *pushModule) send(ctx context.Context, job *pushDelivery) (string, string) {
	event, subscription := job.event, job.subscription
	name := event.Name
	if name == "" {
		name = strings.TrimSuffix(event.File, ".jsonl")
	}
	title := name + " — 回复已就绪"
	if event.Kind == "attention" {
		title = name + " — 待处理"
	} else if event.Kind == "test" {
		title = "Pi 通知测试"
	}
	target := subscription.Origin + "/"
	if event.File != "" {
		target = subscription.Origin + "/session?id=" + url.QueryEscape(event.File)
	}
	topicBytes := sha256.Sum256([]byte(p.keys.Public + "\x00" + event.SessionID + "\x00" + event.Kind))
	topic := base64.RawURLEncoding.EncodeToString(topicBytes[:24])
	body := ""
	if event.Kind == "attention" {
		body = "需要终端交互"
		if reason := (map[string]string{"select": "选择选项", "confirm": "确认操作", "input": "输入文本", "editor": "编辑文本", "custom": "自定义终端对话框"})[event.Reason]; reason != "" {
			body += "：" + reason
		}
	}
	payload, err := json.Marshal(map[string]any{
		"eventId": event.Key, "kind": event.Kind, "sessionId": event.File, "identity": event.Identity,
		"title": title, "body": body, "url": target,
		"tag": topic, "reason": event.Reason, "created": event.Created, "sequence": event.Sequence,
	})
	if err != nil {
		return "failed", "payload"
	}
	response, err := webpush.SendNotificationWithContext(ctx, payload, &subscription.Subscription, &webpush.Options{
		HTTPClient: p.client, VAPIDPrivateKey: p.keys.Private, VAPIDPublicKey: p.keys.Public,
		Subscriber: "https://github.com/stoneedle/pi-web", TTL: 86400, Topic: topic, Urgency: webpush.UrgencyHigh,
	})
	if err != nil {
		if errors.Is(err, webpush.ErrMaxPadExceeded) {
			return "failed", "payload"
		}
		return "pending", "unreachable"
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		return "accepted", ""
	case response.StatusCode == 404 || response.StatusCode == 410:
		tx, err := p.db.Begin()
		if err == nil {
			defer tx.Rollback()
			_, err = tx.Exec(`DELETE FROM push_subscriptions WHERE endpoint=?`, subscription.Subscription.Endpoint)
			if err == nil {
				_, err = tx.Exec(`UPDATE push_deliveries SET state='expired',error='expired' WHERE endpoint=?`, subscription.Subscription.Endpoint)
			}
			if err == nil {
				err = tx.Commit()
			}
		}
		if err != nil {
			return "pending", "state-unavailable"
		}
		return "expired", "expired"
	case response.StatusCode == 429 || response.StatusCode >= 500:
		if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 {
			job.retryAfter = time.Duration(min(seconds, 86400)) * time.Second
		} else if deadline, err := http.ParseTime(response.Header.Get("Retry-After")); err == nil {
			job.retryAfter = min(max(deadline.Sub(p.now()), 0), 24*time.Hour)
		}
		return "pending", fmt.Sprintf("http:%d", response.StatusCode)
	default:
		return "failed", fmt.Sprintf("http:%d", response.StatusCode)
	}
}

func (s *Server) pushEventActive(event pushEvent) (bool, error) {
	if event.Kind == "test" {
		return true, nil
	}
	if event.Kind == "attention" {
		current := s.runtimeState(event.File)
		if current.Availability != "connected" {
			return false, errors.New("native attention state is unavailable")
		}
		return current.SessionID == event.SessionID && current.State == "needs-you" && current.AttentionID == event.Identity, nil
	}
	var acknowledged int
	err := s.db.QueryRow(`SELECT acknowledged FROM session_results WHERE session_id=? AND result_id=?`, event.SessionID, event.Identity).Scan(&acknowledged)
	return err == nil && acknowledged == 0, err
}
