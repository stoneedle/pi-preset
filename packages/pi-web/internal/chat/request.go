package chat

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const DefaultMaxImageBytes int64 = 10 << 20
const DefaultMaxRequestBytes int64 = 32 << 20

var ErrEmptyRequest = errors.New("message or attachment required")
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

	// Keep successful uploads outside multipart's request-scoped cleanup: Pi may
	// read them later, including after a queued message starts running.
	var uploadDir string
	complete := false
	defer func() {
		if !complete && uploadDir != "" {
			_ = os.RemoveAll(uploadDir)
		}
	}()
	files := r.MultipartForm.File["files"]
	var names []string
	if raw := r.FormValue("fileNames"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &names); err != nil || len(names) != len(files) {
			return Request{}, errors.New("invalid attachment names")
		}
	}
	for index, fh := range files {
		if uploadDir == "" {
			var err error
			uploadDir, err = os.MkdirTemp("", "pi-web-upload-")
			if err != nil {
				return Request{}, err
			}
		}
		// Separate directories preserve duplicate names without overwriting.
		dir := filepath.Join(uploadDir, fmt.Sprint(index+1))
		if err := os.Mkdir(dir, 0700); err != nil {
			return Request{}, err
		}
		// Browsers escape multipart filenames and Go strips host separators.
		// Separate JSON metadata preserves the provider's original name.
		name := fh.Filename
		if names != nil {
			name = names[index]
		}
		path := filepath.Join(dir, uploadFilename(name))
		if err := saveUpload(fh, path); err != nil {
			return Request{}, err
		}
		chat.Message += "\n\n附件（已上传到电脑临时目录）：" + strconv.Quote(name) + "\n" + strconv.Quote(path)
	}

	if chat.Message == "" && len(chat.Images) == 0 {
		return Request{}, ErrEmptyRequest
	}
	complete = true
	return chat, nil
}

// Android file providers may supply names that Windows cannot create.
func uploadFilename(name string) string {
	name = strings.Map(func(char rune) rune {
		if char < 32 || strings.ContainsRune(`<>:"/\|?*`, char) {
			return '_'
		}
		return char
	}, name)
	name = strings.TrimRight(name, ". ")
	if name == "" {
		return "attachment"
	}
	stem := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	if stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
		(len(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && stem[3] >= '1' && stem[3] <= '9') {
		name = "_" + name[1:]
	}
	return name
}

func saveUpload(header *multipart.FileHeader, path string) error {
	source, err := header.Open()
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(target, source)
	closeErr := target.Close()
	return errors.Join(copyErr, closeErr)
}
