package sessions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// LatestCompaction reads only the most recent summary on the active branch.
func (c *Content) LatestCompaction(leaf *string) (map[string]any, error) {
	path, err := c.activePath(leaf)
	if err != nil {
		return nil, err
	}
	for i := len(path) - 1; i >= 0; i-- {
		entry := path[i]
		if entry.kind != "compaction" {
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
		var data struct {
			Summary              string `json:"summary"`
			TokensBefore         int64  `json:"tokensBefore"`
			EstimatedTokensAfter *int64 `json:"estimatedTokensAfter"`
		}
		if err := json.Unmarshal(line, &data); err != nil {
			return nil, err
		}
		return map[string]any{"id": entry.id, "summary": data.Summary, "tokensBefore": data.TokensBefore, "estimatedTokensAfter": data.EstimatedTokensAfter}, nil
	}
	return nil, nil
}

// TextContext reads the active branch on demand, without starting an executor or
// including image payloads, thinking, opaque metadata, or files outside the log.
func (c *Content) TextContext(ctx context.Context, leaf *string) (string, error) {
	path, err := c.activePath(leaf)
	if err != nil {
		return "", err
	}
	f, err := c.open()
	if err != nil {
		return "", err
	}
	defer f.Close()

	var out strings.Builder
	fmt.Fprintf(&out, "# 会话：%s\n\n项目：%s\n\n", c.Name, c.CWD)
	out.WriteString("范围：当前分支的会话正文、工具输入输出和压缩摘要。\n不包含图片原件、思考、系统提示、未发送草稿或额外读取的项目文件。\n")
	for _, entry := range path {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if entry.kind != "compaction" && entry.kind != "branch_summary" && entry.role != "user" && entry.role != "assistant" && entry.role != "toolResult" {
			continue
		}
		line, err := c.record(f, entry)
		if err != nil {
			return "", err
		}
		if entry.kind == "compaction" || entry.kind == "branch_summary" {
			fmt.Fprintf(&out, "\n## 历史摘要\n\n%s\n", stringField(line, "summary"))
			continue
		}
		var body strings.Builder
		eachPart(line, func(part contentPart) {
			switch part.kind {
			case "text":
				body.WriteString(part.text())
				body.WriteString("\n")
			case "image":
				body.WriteString("[图片未包含]\n")
			case "toolCall":
				fmt.Fprintf(&body, "\n工具调用：%s\n%s\n", stringField(part.raw, "name"), rawField(part.raw, "arguments"))
			}
		})
		if message := stringField(line, "message", "errorMessage"); message != "" {
			fmt.Fprintf(&body, "\n错误：%s\n", message)
		}
		if body.Len() == 0 {
			continue
		}
		label := "Pi"
		if entry.role == "user" {
			label = "用户"
		} else if entry.role == "toolResult" {
			label = "工具结果：" + stringField(line, "message", "toolName")
		}
		fmt.Fprintf(&out, "\n## %s\n\n%s", label, body.String())
	}
	return out.String(), nil
}
