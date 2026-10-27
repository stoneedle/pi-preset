package chat

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

const DefaultMaxImageBytes int64 = 10 << 20
const DefaultMaxRequestBytes int64 = 32 << 20

var ErrEmptyRequest = errors.New("message or image required")
var ErrUnsupportedImageType = errors.New("only image attachments are supported")
var ErrImageTooLarge = errors.New("image attachment too large")

type Image struct {
	Type     string `json:"type"`
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

type Settings struct {
	Provider string `json:"provider,omitempty"`
	ModelID  string `json:"modelId,omitempty"`
	Thinking string `json:"thinking,omitempty"`
	Speed    string `json:"speed,omitempty"`
}

func (s Settings) Commands() []map[string]any {
	commands := make([]map[string]any, 0, 3)
	if s.Provider != "" && s.ModelID != "" {
		commands = append(commands, map[string]any{"action": "model", "provider": s.Provider, "modelId": s.ModelID})
	}
	if s.Thinking != "" {
		commands = append(commands, map[string]any{"action": "thinking", "level": s.Thinking})
	}
	if s.Speed != "" {
		commands = append(commands, map[string]any{"action": "speed", "mode": s.Speed})
	}
	return commands
}

type Request struct {
	Message  string    `json:"message"`
	Images   []Image   `json:"images"`
	Settings *Settings `json:"settings,omitempty"`
	Delivery string    `json:"delivery,omitempty"`
}

func ParseRequest(r *http.Request, maxImageBytes, maxRequestBytes int64) (Request, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, maxRequestBytes)
	if err := r.ParseMultipartForm(maxRequestBytes); err != nil {
		return Request{}, err
	}

	chat := Request{Message: strings.TrimSpace(r.FormValue("message")), Delivery: r.FormValue("delivery")}
	if chat.Delivery != "" && chat.Delivery != "followUp" {
		return Request{}, errors.New("invalid message delivery")
	}
	if settings := r.FormValue("settings"); settings != "" {
		var selected Settings
		if err := json.Unmarshal([]byte(settings), &selected); err != nil {
			return Request{}, errors.New("invalid message settings")
		}
		if (selected.Provider == "") != (selected.ModelID == "") {
			return Request{}, errors.New("model provider and id must be selected together")
		}
		chat.Settings = &selected
	}
	if r.MultipartForm == nil {
		if chat.Message == "" {
			return Request{}, ErrEmptyRequest
		}
		return chat, nil
	}

	for _, fh := range r.MultipartForm.File["images"] {
		file, err := fh.Open()
		if err != nil {
			return Request{}, err
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxImageBytes+1))
		closeErr := file.Close()
		if readErr != nil {
			return Request{}, readErr
		}
		if closeErr != nil {
			return Request{}, closeErr
		}
		if int64(len(data)) > maxImageBytes {
			return Request{}, ErrImageTooLarge
		}
		mimeType := http.DetectContentType(data)
		if !strings.HasPrefix(mimeType, "image/") {
			return Request{}, ErrUnsupportedImageType
		}
		chat.Images = append(chat.Images, Image{Type: "image", Data: base64.StdEncoding.EncodeToString(data), MimeType: mimeType})
	}

	if chat.Message == "" && len(chat.Images) == 0 {
		return Request{}, ErrEmptyRequest
	}
	return chat, nil
}
