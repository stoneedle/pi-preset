package sessions

import (
	"encoding/json"
	"os"
	"slices"
	"strings"

	"github.com/buger/jsonparser"
)

const windowMessages = 30
const windowBytes = 64 << 10

type ViewImage struct {
	Entry string `json:"entry"`
	Index int    `json:"index"`
}

type ViewBlock struct {
	Type    string      `json:"type"`
	Index   int         `json:"index"`
	Text    string      `json:"text,omitempty"`
	Name    string      `json:"name,omitempty"`
	Summary string      `json:"summary,omitempty"`
	State   string      `json:"state,omitempty"`
	Files   []string    `json:"files,omitempty"`
	Images  []ViewImage `json:"images,omitempty"`
}

type ViewMessage struct {
	ID        string      `json:"id"`
	Role      string      `json:"role"`
	Timestamp string      `json:"timestamp,omitempty"`
	Blocks    []ViewBlock `json:"blocks"`
	Error     string      `json:"error,omitempty"`
}

type Window struct {
	Messages []ViewMessage `json:"messages"`
	Before   string        `json:"before"`
	Cursor   string        `json:"cursor"`
	Reset    bool          `json:"reset"`
	ReplyID  string        `json:"replyId"`
}

func (c *Content) Window(before, after string, leaf *string) (Window, error) {
	path, err := c.activePath(leaf)
	if err != nil {
		return Window{}, err
	}
	window := Window{Messages: []ViewMessage{}}
	if len(path) == 0 {
		window.Reset = after != "" || before != ""
		return window, nil
	}
	window.Cursor = path[len(path)-1].id
	for _, entry := range path {
		if isAssistantReply(entry.role, entry.outcome) {
			window.ReplyID = ""
			if entry.readable {
				window.ReplyID = entry.id
			}
		}
	}
	results := resultEntries(path)
	start, end := 0, len(path)
	changedTools := make(map[string]bool)
	if before != "" || after != "" {
		found := false
		for i, entry := range path {
			if before != "" && entry.id == before {
				end, found = i, true
				break
			}
			if after != "" && entry.id == after {
				start, found = i+1, true
				break
			}
		}
		if !found {
			window.Reset = true
			after = ""
		} else if after != "" {
			for _, entry := range path[start:] {
				if entry.role == "toolResult" {
					changedTools[entry.callID] = true
				}
			}
		}
	}
	f, err := c.open()
	if err != nil {
		return Window{}, err
	}
	defer f.Close()
	bytes := 0
	for i := end - 1; i >= 0; i-- {
		entry := path[i]
		if entry.role != "user" && entry.role != "assistant" {
			continue
		}
		if after != "" && i < start && !slices.ContainsFunc(entry.calls, func(id string) bool { return changedTools[id] }) {
			continue
		}
		if after == "" && len(window.Messages) > 0 && (len(window.Messages) >= windowMessages || bytes >= windowBytes) {
			window.Before = window.Messages[len(window.Messages)-1].ID
			break
		}
		view, err := c.project(f, entry, results)
		if err != nil {
			return Window{}, err
		}
		if len(view.Blocks) == 0 && view.Error == "" {
			continue
		}
		raw, _ := json.Marshal(view)
		bytes += len(raw)
		window.Messages = append(window.Messages, view)
	}
	slices.Reverse(window.Messages)
	return window, nil
}

func (c *Content) project(f *os.File, entry *nativeEntry, results map[string]*nativeEntry) (ViewMessage, error) {
	line, err := c.record(f, entry)
	if err != nil {
		return ViewMessage{}, err
	}
	view := ViewMessage{ID: entry.id, Role: entry.role, Timestamp: entry.timestamp, Blocks: []ViewBlock{}}
	var projectionError error
	eachPart(line, func(part contentPart) {
		if projectionError != nil {
			return
		}
		block := ViewBlock{Type: part.kind, Index: part.index}
		switch part.kind {
		case "text":
			block.Text = part.text()
			if strings.TrimSpace(block.Text) == "" {
				return
			}
		case "thinking":
			value, kind, _, _ := jsonparser.Get(part.raw, "thinking")
			if kind != jsonparser.String {
				return
			}
			block.Summary = blockSummary(value)
			if block.Summary == "" {
				return
			}
		case "image":
		case "toolCall":
			block.Type = "tool"
			block.Name = stringField(part.raw, "name")
			for _, key := range []string{"file_path", "path"} {
				value, kind, _, _ := jsonparser.Get(part.raw, "arguments", key)
				if kind != jsonparser.String || len(value) > 4096*6 {
					continue
				}
				path := decodeString(value)
				if path != "" && len(path) <= 4096 && !strings.ContainsAny(path, "\x00\r\n") {
					block.Files = append(block.Files, path)
					break
				}
			}
			for _, key := range []string{"command", "file_path", "path", "query", "code"} {
				value, kind, _, _ := jsonparser.Get(part.raw, "arguments", key)
				if kind != jsonparser.String || len(value) == 0 {
					continue
				}
				block.Summary = blockSummary(value)
				break
			}
			block.State = "pending"
			if result := results[stringField(part.raw, "id")]; result != nil {
				block.State = "done"
				if result.failed {
					block.State = "error"
				}
				resultLine, err := c.record(f, result)
				if err != nil {
					projectionError = err
					return
				}
				eachPart(resultLine, func(image contentPart) {
					if image.kind == "image" {
						block.Images = append(block.Images, ViewImage{Entry: result.id, Index: image.index})
					}
				})
			}
		default:
			return
		}
		view.Blocks = append(view.Blocks, block)
	})
	if entry.outcome == "error" || entry.outcome == "aborted" {
		view.Error = stringField(line, "message", "errorMessage")
		if view.Error == "" {
			view.Error = entry.outcome
		}
	}
	return view, projectionError
}

func blockSummary(value []byte) string {
	return truncate(strings.Join(strings.Fields(stringPrefix(value, 256)), " "), 80)
}
