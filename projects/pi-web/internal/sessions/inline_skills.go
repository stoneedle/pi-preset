package sessions

import (
	"encoding/json"
	"strings"

	"github.com/buger/jsonparser"
)

// The inline-skill extension consumes the input instead of persisting a normal
// user message. Its details own the readable prompt; content contains expanded
// model instructions and must not be used as the displayed user text.
func isInlineSkillMessage(line []byte) bool {
	if stringField(line, "type") != "custom_message" || stringField(line, "customType") != "inline-skills" {
		return false
	}
	display, err := jsonparser.GetBoolean(line, "display")
	return err == nil && display
}

func eachInlineSkillPart(line []byte, visit func(contentPart)) {
	var commands []string
	_, _ = jsonparser.ArrayEach(line, func(block []byte, kind jsonparser.ValueType, _ int, err error) {
		if err == nil && kind == jsonparser.Object {
			if name := stringField(block, "name"); name != "" {
				commands = append(commands, "/skill:"+name)
			}
		}
	}, "details", "blocks")
	if len(commands) > 0 {
		encoded, _ := json.Marshal(strings.Join(commands, " "))
		visit(contentPart{index: 0, kind: "text", raw: encoded[1 : len(encoded)-1], directText: true})
	}
	if text, kind, _, err := jsonparser.Get(line, "details", "userMessage"); err == nil && kind == jsonparser.String {
		visit(contentPart{index: 1, kind: "text", raw: text, directText: true})
	}
}
