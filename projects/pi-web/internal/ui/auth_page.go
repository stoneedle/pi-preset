package ui

import (
	"bytes"
	_ "embed"
	"html/template"
	"io"
)

//go:embed embedded/styles/theme.css
var liveThemeCss string

//go:embed embedded/auth.html
var authTmplStr string

var authTmpl = template.Must(template.New("auth").Parse(authTmplStr))

// RenderAuthPrompt shares the app's automatic system appearance.
func RenderAuthPrompt(w io.Writer, appName string) error {
	data := struct {
		AppName   string
		ThemeCss  template.HTML
		ThemeBoot template.HTML
	}{
		AppName:   appName,
		ThemeCss:  template.HTML("<style>\n" + liveThemeCss + "\n</style>"),
		ThemeBoot: liveThemeBootScript(),
	}
	var buf bytes.Buffer
	if err := authTmpl.Execute(&buf, data); err != nil {
		return err
	}
	_, err := w.Write(buf.Bytes())
	return err
}
