package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"
)

const appNameSetting = "pi-web:app-name"

type appNameRecord struct {
	Override string `json:"override"`
	Revision int64  `json:"revision"`
}

type appNameInfo struct {
	appNameRecord
	Name     string `json:"name"`
	Hostname string `json:"hostname"`
}

func (s *Server) appNameInfo() (appNameInfo, error) {
	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		hostname = "localhost"
	}
	info := appNameInfo{Name: hostname, Hostname: hostname}
	if s.db == nil {
		return info, nil
	}
	var encoded string
	err = s.db.QueryRow("SELECT value FROM settings WHERE key = ?", appNameSetting).Scan(&encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return info, nil
	}
	if err != nil {
		return info, err
	}
	if err := json.Unmarshal([]byte(encoded), &info.appNameRecord); err != nil {
		return info, err
	}
	if info.Override != "" {
		info.Name = info.Override
	}
	return info, nil
}

// AppName supplies the same machine-local name to HTML and the public manifest.
func (s *Server) AppName() string {
	info, _ := s.appNameInfo()
	return info.Name
}

func (s *Server) handleAppName(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		info, err := s.appNameInfo()
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "无法读取应用名称")
			return
		}
		writeJSON(w, 0, info)
	case http.MethodPost:
		var input struct {
			Name *string `json:"name"`
		}
		if !decodeJSONBody(w, r, &input) {
			return
		}
		if input.Name == nil {
			writeJSONError(w, http.StatusBadRequest, "请提供应用名称，留空可恢复主机名")
			return
		}
		name := strings.TrimSpace(*input.Name)
		if utf8.RuneCountInString(name) > 80 || strings.ContainsFunc(name, unicode.IsControl) {
			writeJSONError(w, http.StatusBadRequest, "应用名称最多 80 个字符，不能包含换行或控制字符")
			return
		}
		s.appNameMu.Lock()
		defer s.appNameMu.Unlock()
		info, err := s.appNameInfo()
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "无法读取应用名称，原设置未改变")
			return
		}
		info.Override = name
		info.Revision++
		info.Name = info.Hostname
		if name != "" {
			info.Name = name
		}
		record, _ := json.Marshal(info.appNameRecord)
		if _, err := s.db.Exec(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
			ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, appNameSetting, string(record), s.now().UTC()); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "无法保存应用名称，原设置未改变")
			return
		}
		data, _ := json.Marshal(info)
		s.broadcast(globalSessID, fmt.Sprintf("event: app-name\ndata: %s", data))
		writeJSON(w, 0, info)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
