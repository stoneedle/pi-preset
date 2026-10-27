package server

import (
	"crypto/ecdh"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
)

func (s *Server) handlePushConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 0, map[string]string{"publicKey": s.push.keys.Public})
}

func validPushSubscription(value pushSubscription) bool {
	u, err := url.Parse(value.Subscription.Endpoint)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || len(u.String()) > 4096 || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	switch u.Hostname() {
	case "fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com":
	default:
		return false
	}
	auth, err := base64.RawURLEncoding.DecodeString(value.Subscription.Keys.Auth)
	if err != nil || len(auth) != 16 {
		return false
	}
	public, err := base64.RawURLEncoding.DecodeString(value.Subscription.Keys.P256dh)
	if err != nil {
		return false
	}
	if _, err := ecdh.P256().NewPublicKey(public); err != nil {
		return false
	}
	return true
}

func (s *Server) handlePushSubscription(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodDelete {
		var input struct {
			Endpoint string `json:"endpoint"`
		}
		if !decodeJSONBody(w, r, &input) {
			return
		}
		tx, err := s.db.Begin()
		if err == nil {
			defer tx.Rollback()
			_, err = tx.Exec(`DELETE FROM push_subscriptions WHERE endpoint=?`, input.Endpoint)
			if err == nil {
				_, err = tx.Exec(`DELETE FROM push_deliveries WHERE endpoint=?`, input.Endpoint)
			}
			if err == nil {
				err = tx.Commit()
			}
		}
		if err != nil {
			writeJSONError(w, 500, "subscription could not be removed")
			return
		}
		writeJSON(w, 0, map[string]bool{"subscribed": false})
		return
	}
	var value pushSubscription
	if !decodeJSONBody(w, r, &value) {
		return
	}
	if !validPushSubscription(value) {
		writeJSONError(w, 400, "invalid subscription or unsupported push service")
		return
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	value.Origin = (&url.URL{Scheme: scheme, Host: r.Host}).String()
	previous := value.PreviousEndpoint
	value.PreviousEndpoint = ""
	data, _ := json.Marshal(value)
	tx, err := s.db.Begin()
	if err == nil {
		defer tx.Rollback()
		_, err = tx.Exec(`INSERT INTO push_subscriptions(endpoint,value) VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET value=excluded.value`, value.Subscription.Endpoint, string(data))
		if err == nil && previous != "" && previous != value.Subscription.Endpoint {
			_, err = tx.Exec(`INSERT OR IGNORE INTO push_deliveries(event_key,endpoint,state,attempt,due) SELECT event_key,?,'pending',0,? FROM push_deliveries WHERE endpoint=? AND state IN ('pending','sending')`, value.Subscription.Endpoint, s.now().Unix(), previous)
			if err == nil {
				_, err = tx.Exec(`DELETE FROM push_subscriptions WHERE endpoint=?`, previous)
			}
			if err == nil {
				_, err = tx.Exec(`DELETE FROM push_deliveries WHERE endpoint=?`, previous)
			}
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		writeJSONError(w, 500, "subscription could not be saved")
		return
	}
	writeJSON(w, 0, map[string]bool{"subscribed": true})
}

func (s *Server) handlePushStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var input struct {
		Endpoint string `json:"endpoint"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM push_subscriptions WHERE endpoint=?`, input.Endpoint).Scan(&count); err != nil {
		writeJSONError(w, 500, "subscription state is unavailable")
		return
	}
	var state, failure string
	err := s.db.QueryRow(`SELECT d.state,d.error FROM push_deliveries d JOIN push_events e ON e.event_key=d.event_key WHERE d.endpoint=? ORDER BY json_extract(e.value,'$.created') DESC,d.rowid DESC LIMIT 1`, input.Endpoint).Scan(&state, &failure)
	if err != nil && err != sql.ErrNoRows {
		writeJSONError(w, 503, "delivery state is unavailable")
		return
	}
	s.push.pendingMu.Lock()
	if len(s.push.pending) != 0 {
		state, failure = "pending", "event-store"
	}
	s.push.pendingMu.Unlock()
	writeJSON(w, 0, map[string]any{"subscribed": count != 0, "delivery": state, "failure": failure})
}

func (s *Server) handlePushTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var input struct {
		Endpoint string `json:"endpoint"`
	}
	if !decodeJSONBody(w, r, &input) {
		return
	}
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM push_subscriptions WHERE endpoint=?`, input.Endpoint).Scan(&count); err != nil || count == 0 {
		writeJSONError(w, 409, "this browser is not subscribed")
		return
	}
	err := s.push.enqueue(pushEvent{Kind: "test", Identity: rand.Text(), Created: s.now().Unix()}, input.Endpoint)
	if err != nil {
		writeJSONError(w, 500, "test notification could not be queued")
		return
	}
	writeJSON(w, 0, map[string]string{"status": "queued"})
}

func (s *Server) handlePushEligibility(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, 405, "method not allowed")
		return
	}
	var data string
	err := s.db.QueryRow(`SELECT value FROM push_events WHERE event_key=?`, r.URL.Query().Get("event")).Scan(&data)
	if err == sql.ErrNoRows {
		writeJSON(w, 0, map[string]bool{"active": false})
		return
	}
	var event pushEvent
	if err != nil || json.Unmarshal([]byte(data), &event) != nil {
		writeJSONError(w, 503, "notification state is unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	active, err := s.pushEventActive(event)
	if err != nil {
		writeJSONError(w, 503, "notification state is unavailable")
		return
	}
	writeJSON(w, 0, map[string]bool{"active": active})
}
