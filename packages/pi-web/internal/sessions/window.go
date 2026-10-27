package sessions

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"time"

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
	Version string      `json:"version,omitempty"`
	Files   []string    `json:"files,omitempty"`
	Images  []ViewImage `json:"images,omitempty"`
}

type ViewMessage struct {
	ID         string      `json:"id"`
	Role       string      `json:"role"`
	Timestamp  string      `json:"timestamp,omitempty"`
	DurationMs *int64      `json:"durationMs,omitempty"`
	Blocks     []ViewBlock `json:"blocks"`
	Error      string      `json:"error,omitempty"`
	Forkable   bool        `json:"forkable,omitempty"`
}

type Window struct {
	Messages []ViewMessage `json:"messages"`
	Before   string        `json:"before"`
	Cursor   string        `json:"cursor"`
	Reset    bool          `json:"reset"`
	ReplyID  string        `json:"replyId"`
	Next     string        `json:"next,omitempty"`
	Anchor   string        `json:"anchor,omitempty"`
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
	points := forkPoints(path)
	durations := replyDurations(path)
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
		view, err := c.project(f, entry, results, durations[entry.id])
		if err != nil {
			return Window{}, err
		}
		if len(view.Blocks) == 0 && view.Error == "" {
			continue
		}
		view.Forkable = entry.forkMessage() && points[entry.id]
		raw, _ := json.Marshal(view)
		bytes += len(raw)
		window.Messages = append(window.Messages, view)
	}
	slices.Reverse(window.Messages)
	return window, nil
}

// Locate reads one bounded page near a reading bookmark, or the page following it.
// An inactive bookmark walks its native parents to the closest surviving active message.
func (c *Content) Locate(anchor, forward, previous string, fallback []string, leaf *string) (Window, error) {
	path, err := c.activePath(leaf)
	if err != nil {
		return Window{}, err
	}
	positions := make(map[string]int, len(path))
	for i, entry := range path {
		positions[entry.id] = i
	}
	requested := anchor
	if forward != "" {
		requested = forward
		fallback = nil
	}
	target, index := "", 0
	for _, candidate := range append([]string{requested}, fallback[:min(5, len(fallback))]...) {
		target = candidate
		for steps := 0; target != "" && steps <= len(c.entries); steps++ {
			if _, ok := positions[target]; ok {
				break
			}
			entryIndex, ok := c.byID[target]
			if !ok {
				target = ""
				break
			}
			target = c.entries[entryIndex].parent
		}
		if position, ok := positions[target]; ok {
			index = position
			break
		}
	}
	if len(path) == 0 {
		window, err := c.Window("", "", leaf)
		window.Reset = true
		return window, err
	}
	f, err := c.open()
	if err != nil {
		return Window{}, err
	}
	defer f.Close()
	results, points := resultEntries(path), forkPoints(path)
	durations := replyDurations(path)
	readable := func(i int) (bool, error) {
		if path[i].role != "user" && path[i].role != "assistant" {
			return false, nil
		}
		view, err := c.project(f, path[i], results, durations[path[i].id])
		return len(view.Blocks) > 0 || view.Error != "", err
	}
	for index >= 0 {
		ok, err := readable(index)
		if err != nil {
			return Window{}, err
		}
		if ok {
			break
		}
		index--
	}
	if index < 0 {
		// With no surviving predecessor, prefer the first readable context, never skip to the tail.
		for index = 0; index < len(path); index++ {
			ok, err := readable(index)
			if err != nil {
				return Window{}, err
			}
			if ok {
				break
			}
		}
	}
	window := Window{Messages: []ViewMessage{}, Cursor: path[len(path)-1].id}
	if index == len(path) {
		window.Reset = true
		return window, nil
	}
	window.Anchor = path[index].id
	_, sameBranch := positions[previous]
	window.Reset = (previous != "" && !sameBranch) || target != requested || (forward == "" && window.Anchor != requested)
	start := index
	if forward != "" && !window.Reset {
		start++
	} else {
		for count := 0; start > 0 && count < 5; {
			start--
			if path[start].role == "user" || path[start].role == "assistant" {
				count++
			}
		}
	}
	bytes := 0
	for i := start; i < len(path); i++ {
		entry := path[i]
		if entry.role != "user" && entry.role != "assistant" {
			continue
		}
		if i > index && len(window.Messages) > 0 && (len(window.Messages) >= windowMessages || bytes >= windowBytes) {
			window.Next = path[i-1].id
			break
		}
		view, err := c.project(f, entry, results, durations[entry.id])
		if err != nil {
			return Window{}, err
		}
		if len(view.Blocks) == 0 && view.Error == "" {
			continue
		}
		view.Forkable = entry.forkMessage() && points[entry.id]
		raw, _ := json.Marshal(view)
		bytes += len(raw)
		window.Messages = append(window.Messages, view)
	}
	if start > 0 && len(window.Messages) > 0 {
		window.Before = window.Messages[0].ID
	}
	return window, nil
}

// Pair on the complete active branch, even when the question is outside the requested window.
func replyDurations(path []*nativeEntry) map[string]*int64 {
	durations := make(map[string]*int64)
	var started time.Time
	for _, entry := range path {
		if entry.role == "user" {
			started, _ = time.Parse(time.RFC3339Nano, entry.timestamp)
			continue
		}
		if started.IsZero() || !isAssistantReply(entry.role, entry.outcome) || len(entry.calls) > 0 {
			continue
		}
		finished, err := time.Parse(time.RFC3339Nano, entry.timestamp)
		if err == nil && !finished.Before(started) {
			elapsed := finished.Sub(started).Milliseconds()
			durations[entry.id] = &elapsed
		}
	}
	return durations
}

func (c *Content) project(f *os.File, entry *nativeEntry, results map[string]*nativeEntry, durationMs *int64) (ViewMessage, error) {
	line, err := c.record(f, entry)
	if err != nil {
		return ViewMessage{}, err
	}
	view := ViewMessage{ID: entry.id, Role: entry.role, Timestamp: entry.timestamp, DurationMs: durationMs, Blocks: []ViewBlock{}}
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
			block.Version = entry.id
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
			block.Version = entry.id
			if result := results[stringField(part.raw, "id")]; result != nil {
				block.State = "done"
				block.Version = result.id
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
