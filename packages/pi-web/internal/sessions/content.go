package sessions

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/buger/jsonparser"
)

var ErrContentChanged = errors.New("native session changed; retry the content request")
var ErrBlockNotFound = errors.New("block not found")
var ErrImageNotFound = errors.New("image not found")

type nativeEntry struct {
	id, parent, kind, timestamp, role, outcome, callID string
	failed                                             bool
	readable                                           bool
	calls                                              []string
	offset                                             int64
	length                                             int
}

// Content retains record identities and byte ranges, never native message bodies.
type Content struct {
	SessionSummary
	CWD     string
	path    string
	info    os.FileInfo
	entries []nativeEntry
	byID    map[string]int
}

func readContentIndex(path, dirName, fileName string) (*Content, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	c := &Content{SessionSummary: newSessionSummary(dirName, fileName), path: path, info: info, byID: make(map[string]int)}
	var headerName, sessionInfoName, firstUserText string
	seenHeaders := make(map[string]bool)
	var offset, nextOffset int64
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, scanInitialBufferBytes), maxScanLineBytes)
	scanner.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		advance, token, err := bufio.ScanLines(data, atEOF)
		if advance > 0 {
			offset, nextOffset = nextOffset, nextOffset+int64(advance)
		}
		return advance, token, err
	})
	for scanner.Scan() {
		line := scanner.Bytes()
		var raw summaryLine
		if json.Unmarshal(line, &raw) != nil {
			continue
		}
		if raw.Type == "session" {
			if raw.Timestamp != "" && c.CreatedAt == "" {
				c.CreatedAt = raw.Timestamp
			}
			key := raw.ID + "\x00" + raw.Timestamp + "\x00" + raw.CWD
			if raw.ID != "" && raw.Timestamp != "" {
				if seenHeaders[key] {
					continue
				}
				seenHeaders[key] = true
			}
			if raw.Name != "" {
				headerName = raw.Name
			}
			if raw.CWD != "" {
				c.CWD = raw.CWD
			}
			if raw.ID != "" {
				c.SessionUUID = raw.ID
			}
			continue
		}
		if raw.Type == "session_info" && raw.Name != "" {
			sessionInfoName = raw.Name
		}
		entry := nativeEntry{id: raw.ID, parent: raw.ParentID, kind: raw.Type, timestamp: raw.Timestamp, offset: offset, length: len(line)}
		if raw.Message != nil {
			entry.role, entry.outcome = raw.Message.Role, raw.Message.StopReason
			entry.callID, entry.failed = raw.Message.ToolCallID, raw.Message.IsError
			if entry.role == "assistant" {
				eachPart(line, func(part contentPart) {
					if part.kind == "text" || part.kind == "thinking" {
						value := part.raw
						kind := jsonparser.String
						if !part.directText {
							value, kind, _, _ = jsonparser.Get(part.raw, part.kind)
						}
						entry.readable = entry.readable || (kind == jsonparser.String && len(value) > 0)
					}
					if part.kind == "toolCall" {
						entry.calls = append(entry.calls, stringField(part.raw, "id"))
					}
				})
			}
		}
		if isInlineSkillMessage(line) {
			entry.role = "user"
		}
		if (entry.role == "user" || entry.role == "assistant") && raw.Timestamp != "" {
			c.LastActivity = raw.Timestamp
		}
		if entry.role == "user" && firstUserText == "" && headerName == "" && sessionInfoName == "" {
			firstUserText = summaryText(line)
		}
		if entry.id != "" {
			c.byID[entry.id] = len(c.entries)
		}
		c.entries = append(c.entries, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	pathEntries, _ := c.activePath(nil)
	for _, entry := range pathEntries {
		if isAssistantReply(entry.role, entry.outcome) {
			c.LastReplyID = ""
			if entry.readable {
				c.LastReplyID = entry.id
			}
		}
	}
	applySummaryContext(&c.SessionSummary, fileName, sessionInfoName, headerName, firstUserText, c.CWD)
	return c, nil
}

func (c *Content) activePath(override *string) ([]*nativeEntry, error) {
	leaf := ""
	if override != nil {
		leaf = *override
		if leaf == "" {
			return nil, nil
		}
		if _, ok := c.byID[leaf]; !ok {
			return nil, ErrContentChanged
		}
	} else {
		for i := len(c.entries) - 1; i >= 0; i-- {
			if c.entries[i].id != "" {
				leaf = c.entries[i].id
				break
			}
		}
	}
	path := make([]*nativeEntry, 0, len(c.entries))
	seen := make(map[string]bool)
	for leaf != "" && !seen[leaf] {
		i, ok := c.byID[leaf]
		if !ok {
			break
		}
		entry := &c.entries[i]
		seen[leaf] = true
		path = append(path, entry)
		leaf = entry.parent
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path, nil
}

func (c *Content) HasResult(id string) bool {
	i, ok := c.byID[id]
	return ok && c.entries[i].readable && isAssistantReply(c.entries[i].role, c.entries[i].outcome)
}

func (c *Content) open() (*os.File, error) {
	f, err := os.Open(c.path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if !os.SameFile(c.info, info) || info.Size() < c.info.Size() || (info.Size() == c.info.Size() && !info.ModTime().Equal(c.info.ModTime())) {
		f.Close()
		return nil, ErrContentChanged
	}
	return f, nil
}

func (c *Content) record(f *os.File, entry *nativeEntry) ([]byte, error) {
	line := make([]byte, entry.length)
	if _, err := f.ReadAt(line, entry.offset); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrContentChanged, err)
	}
	if !json.Valid(line) || stringField(line, "id") != entry.id || stringField(line, "type") != entry.kind {
		return nil, ErrContentChanged
	}
	return line, nil
}

type contentPart struct {
	index      int
	kind       string
	raw        []byte
	directText bool
}

func eachPart(line []byte, visit func(contentPart)) {
	if isInlineSkillMessage(line) {
		eachInlineSkillPart(line, visit)
		return
	}
	value, kind, _, err := jsonparser.Get(line, "message", "content")
	if err != nil {
		return
	}
	if kind == jsonparser.String {
		visit(contentPart{kind: "text", raw: value, directText: true})
		return
	}
	if kind != jsonparser.Array {
		return
	}
	index := 0
	jsonparser.ArrayEach(value, func(raw []byte, kind jsonparser.ValueType, _ int, err error) {
		if err != nil || kind != jsonparser.Object {
			return
		}
		visit(contentPart{index: index, kind: stringField(raw, "type"), raw: raw})
		index++
	})
}

func (p contentPart) text() string {
	if p.directText {
		return decodeString(p.raw)
	}
	return stringField(p.raw, "text")
}

func stringField(raw []byte, keys ...string) string {
	value, kind, _, err := jsonparser.Get(raw, keys...)
	if err != nil || kind != jsonparser.String {
		return ""
	}
	return decodeString(value)
}

func rawField(raw []byte, keys ...string) json.RawMessage {
	value, kind, _, _ := jsonparser.Get(raw, keys...)
	if kind == jsonparser.String {
		encoded, _ := json.Marshal(decodeString(value))
		return encoded
	}
	return json.RawMessage(value)
}

func decodeString(value []byte) string {
	text, err := jsonparser.ParseString(value)
	if err == nil && utf8.ValidString(text) {
		return text
	}
	var fallback string
	quoted := make([]byte, len(value)+2)
	quoted[0], quoted[len(quoted)-1] = '"', '"'
	copy(quoted[1:], value)
	_ = json.Unmarshal(quoted, &fallback)
	return fallback
}

// Metadata previews decode a bounded prefix, including escaped surrogate pairs.
func stringPrefix(value []byte, runes int) string {
	end := min(len(value), runes*12)
	for lower := max(0, end-12); end >= lower; end-- {
		quoted := make([]byte, end+2)
		quoted[0], quoted[len(quoted)-1] = '"', '"'
		copy(quoted[1:], value[:end])
		var text string
		if json.Unmarshal(quoted, &text) == nil {
			chars := []rune(text)
			return string(chars[:min(runes, len(chars))])
		}
	}
	return ""
}

func summaryText(line []byte) string {
	var text strings.Builder
	runes := 0
	eachPart(line, func(part contentPart) {
		if part.kind != "text" || runes >= 81 {
			return
		}
		value := part.raw
		if !part.directText {
			var kind jsonparser.ValueType
			value, kind, _, _ = jsonparser.Get(part.raw, "text")
			if kind != jsonparser.String {
				return
			}
		}
		prefix := stringPrefix(value, 81-runes)
		text.WriteString(prefix)
		runes += utf8.RuneCountInString(prefix)
	})
	return text.String()
}

func resultEntries(path []*nativeEntry) map[string]*nativeEntry {
	results := make(map[string]*nativeEntry)
	for _, entry := range path {
		if entry.role == "toolResult" {
			results[entry.callID] = entry
		}
	}
	return results
}

func (c *Content) Block(id string, index int, leaf *string) (map[string]any, error) {
	path, err := c.activePath(leaf)
	if err != nil {
		return nil, err
	}
	for _, entry := range path {
		if entry.id != id {
			continue
		}
		f, err := c.open()
		if err != nil {
			return nil, err
		}
		defer f.Close()
		line, err := c.record(f, entry)
		if err != nil {
			return nil, err
		}
		var selected *contentPart
		eachPart(line, func(part contentPart) {
			if part.index == index {
				selected = &part
			}
		})
		if selected == nil {
			break
		}
		switch selected.kind {
		case "thinking":
			return map[string]any{"text": stringField(selected.raw, "thinking"), "version": entry.id}, nil
		case "toolCall":
			out := map[string]any{"input": rawField(selected.raw, "arguments"), "version": entry.id}
			if result := resultEntries(path)[stringField(selected.raw, "id")]; result != nil {
				line, err := c.record(f, result)
				if err != nil {
					return nil, err
				}
				var texts []string
				eachPart(line, func(part contentPart) {
					if part.kind == "text" {
						texts = append(texts, part.text())
					}
				})
				out["version"] = result.id
				out["text"] = strings.Join(texts, "\n")
				out["details"] = rawField(line, "message", "details")
			}
			return out, nil
		}
		break
	}
	return nil, ErrBlockNotFound
}

func (c *Content) Image(id string, index int, leaf *string) (string, string, error) {
	path, err := c.activePath(leaf)
	if err != nil {
		return "", "", err
	}
	for _, entry := range path {
		if entry.id != id {
			continue
		}
		f, err := c.open()
		if err != nil {
			return "", "", err
		}
		defer f.Close()
		line, err := c.record(f, entry)
		if err != nil {
			return "", "", err
		}
		var selected *contentPart
		eachPart(line, func(part contentPart) {
			if part.index == index && part.kind == "image" {
				selected = &part
			}
		})
		if selected != nil {
			return stringField(selected.raw, "data"), stringField(selected.raw, "mimeType"), nil
		}
	}
	return "", "", ErrImageNotFound
}
