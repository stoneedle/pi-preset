package sessions

import "errors"

// forkPoints marks complete prefixes, including metadata after the last message.
// A tool call and its results must stay together; a later result cannot make an
// earlier, incomplete prefix safe to resume.
func forkPoints(path []*nativeEntry) map[string]bool {
	points := make(map[string]bool, len(path))
	pending := make(map[string]bool)
	conversation := false
	for _, entry := range path {
		if entry.role == "user" || entry.role == "assistant" {
			conversation = true
		}
		for _, id := range entry.calls {
			pending[id] = true
		}
		if entry.role == "toolResult" {
			delete(pending, entry.callID)
		}
		points[entry.id] = conversation && len(pending) == 0
	}
	return points
}

func (entry *nativeEntry) forkMessage() bool {
	return entry.role == "user" || (entry.role == "assistant" && entry.readable &&
		len(entry.calls) == 0 && (entry.outcome == "stop" || entry.outcome == "length"))
}

// ForkPoint resolves one immutable native entry, never a display-block offset.
// nil leaf means dormant file state; a non-nil empty leaf means a known empty root.
func (c *Content) ForkPoint(entryID string, leaf *string) (string, error) {
	path, err := c.activePath(leaf)
	if err != nil {
		return "", err
	}
	if len(path) == 0 {
		return "", errors.New("当前分支还没有可分叉的消息")
	}
	parent := ""
	var target *nativeEntry
	for _, entry := range path {
		if entry.parent != parent {
			return "", errors.New("会话父链不完整，无法分叉")
		}
		parent = entry.id
		if entry.id == entryID {
			target = entry
		}
	}
	if entryID == "" {
		target = path[len(path)-1]
	} else if target == nil || !target.forkMessage() {
		return "", errors.New("请选择当前分支中的用户消息或完整助手回复")
	}
	if !forkPoints(path)[target.id] {
		return "", errors.New("这个位置有未完成的工具调用，请从更早的完整消息分叉")
	}
	file, err := c.open()
	if err != nil {
		return "", err
	}
	file.Close()
	return target.id, nil
}
