package sessions

import (
	"encoding/json"
	"fmt"
	"strings"
)

const windowMessages = 30
const windowBytes = 64 << 10

type ViewBlock struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Text    string `json:"text,omitempty"`
	Name    string `json:"name,omitempty"`
	Summary string `json:"summary,omitempty"`
	State   string `json:"state,omitempty"`
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

// ActiveEntries follows native parent links, not the physical order of abandoned branches.
func ActiveEntries(entries []map[string]any) []map[string]any {
	byID := make(map[string]map[string]any, len(entries))
	leaf := ""
	for _, entry := range entries {
		id, _ := entry["id"].(string)
		if id == "" || entry["type"] == "session" {
			continue
		}
		byID[id] = entry
		leaf = id
	}
	path := make([]map[string]any, 0, len(entries))
	seen := make(map[string]bool)
	for leaf != "" && !seen[leaf] {
		entry := byID[leaf]
		if entry == nil {
			break
		}
		seen[leaf] = true
		path = append(path, entry)
		leaf, _ = entry["parentId"].(string)
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

func MessageWindow(entries []map[string]any, before, after string) Window {
	path := ActiveEntries(entries)
	window := Window{Messages: []ViewMessage{}}
	if len(path) == 0 {
		window.Reset = after != "" || before != ""
		return window
	}
	window.Cursor, _ = path[len(path)-1]["id"].(string)
	for _, entry := range entries {
		msg, _ := entry["message"].(map[string]any)
		if isAssistantReply(msg["role"], msg["stopReason"]) {
			window.ReplyID, _ = entry["id"].(string)
		}
	}
	results := make(map[string]map[string]any)
	for _, entry := range path {
		msg, _ := entry["message"].(map[string]any)
		if msg["role"] == "toolResult" {
			id, _ := msg["toolCallId"].(string)
			results[id] = msg
		}
	}
	start, end := 0, len(path)
	changedTools := make(map[string]bool)
	if before != "" || after != "" {
		found := false
		for i, entry := range path {
			if before != "" && entry["id"] == before {
				end, found = i, true
				break
			}
			if after != "" && entry["id"] == after {
				start, found = i+1, true
				break
			}
		}
		if !found {
			window.Reset = true
			after = ""
		} else if after != "" {
			for _, entry := range path[start:] {
				msg, _ := entry["message"].(map[string]any)
				if msg["role"] == "toolResult" {
					id, _ := msg["toolCallId"].(string)
					changedTools[id] = true
				}
			}
		}
	}
	bytes := 0
	for i := end - 1; i >= 0; i-- {
		entry := path[i]
		msg, _ := entry["message"].(map[string]any)
		role, _ := msg["role"].(string)
		if role != "user" && role != "assistant" {
			continue
		}
		if after != "" && i < start {
			affected := false
			for _, block := range contentBlocks(msg["content"]) {
				id, _ := block["id"].(string)
				if block["type"] == "toolCall" && changedTools[id] {
					affected = true
				}
			}
			if !affected {
				continue
			}
		}
		view := projectMessage(entry, msg, results)
		if after == "" && len(window.Messages) > 0 && (len(window.Messages) >= windowMessages || bytes >= windowBytes) {
			window.Before = window.Messages[len(window.Messages)-1].ID
			break
		}
		raw, _ := json.Marshal(view)
		bytes += len(raw)
		window.Messages = append(window.Messages, view)
	}
	for i, j := 0, len(window.Messages)-1; i < j; i, j = i+1, j-1 {
		window.Messages[i], window.Messages[j] = window.Messages[j], window.Messages[i]
	}
	return window
}

func contentBlocks(content any) []map[string]any {
	if text, ok := content.(string); ok {
		return []map[string]any{{"type": "text", "text": text}}
	}
	var blocks []map[string]any
	if list, ok := content.([]any); ok {
		for _, item := range list {
			if block, ok := item.(map[string]any); ok {
				blocks = append(blocks, block)
			}
		}
	}
	return blocks
}

func projectMessage(entry, msg map[string]any, results map[string]map[string]any) ViewMessage {
	id, _ := entry["id"].(string)
	role, _ := msg["role"].(string)
	ts, _ := entry["timestamp"].(string)
	view := ViewMessage{ID: id, Role: role, Timestamp: ts, Blocks: []ViewBlock{}}
	for index, block := range contentBlocks(msg["content"]) {
		kind, _ := block["type"].(string)
		b := ViewBlock{Type: kind, Index: index}
		switch kind {
		case "text":
			b.Text, _ = block["text"].(string)
		case "thinking", "image":
		case "toolCall":
			b.Type = "tool"
			b.Name, _ = block["name"].(string)
			args, _ := block["arguments"].(map[string]any)
			for _, key := range []string{"command", "file_path", "path", "query"} {
				if text, ok := args[key].(string); ok && text != "" {
					b.Summary = strings.Join(strings.Fields(text), " ")
					if len(b.Summary) > 160 {
						b.Summary = string([]rune(b.Summary)[:min(80, len([]rune(b.Summary)))]) + "…"
					}
					break
				}
			}
			callID, _ := block["id"].(string)
			b.State = "pending"
			if result := results[callID]; result != nil {
				b.State = "done"
				if result["isError"] == true {
					b.State = "error"
				}
			}
		default:
			continue
		}
		view.Blocks = append(view.Blocks, b)
	}
	if msg["stopReason"] == "error" || msg["stopReason"] == "aborted" {
		view.Error, _ = msg["errorMessage"].(string)
		if view.Error == "" {
			view.Error, _ = msg["stopReason"].(string)
		}
	}
	return view
}

// BlockContent is the only path that exposes a folded body. Images stay separate.
func BlockContent(entries []map[string]any, entryID string, index int) (map[string]any, error) {
	path := ActiveEntries(entries)
	for _, entry := range path {
		if entry["id"] != entryID {
			continue
		}
		msg, _ := entry["message"].(map[string]any)
		blocks := contentBlocks(msg["content"])
		if index < 0 || index >= len(blocks) {
			break
		}
		block := blocks[index]
		switch block["type"] {
		case "thinking":
			return map[string]any{"text": block["thinking"]}, nil
		case "toolCall":
			out := map[string]any{"input": block["arguments"]}
			for _, candidate := range path {
				result, _ := candidate["message"].(map[string]any)
				if result["role"] != "toolResult" || result["toolCallId"] != block["id"] {
					continue
				}
				var texts []string
				var images []map[string]any
				for i, part := range contentBlocks(result["content"]) {
					if text, ok := part["text"].(string); ok {
						texts = append(texts, text)
					}
					if part["type"] == "image" {
						images = append(images, map[string]any{"entry": candidate["id"], "index": i})
					}
				}
				out["text"] = strings.Join(texts, "\n")
				out["images"] = images
				out["details"] = result["details"]
				break
			}
			return out, nil
		}
		break
	}
	return nil, fmt.Errorf("block not found")
}

func ImageContent(entries []map[string]any, entryID string, index int) (string, string, error) {
	for _, entry := range ActiveEntries(entries) {
		if entry["id"] != entryID {
			continue
		}
		msg, _ := entry["message"].(map[string]any)
		blocks := contentBlocks(msg["content"])
		if index >= 0 && index < len(blocks) && blocks[index]["type"] == "image" {
			data, _ := blocks[index]["data"].(string)
			mime, _ := blocks[index]["mimeType"].(string)
			return data, mime, nil
		}
	}
	return "", "", fmt.Errorf("image not found")
}
