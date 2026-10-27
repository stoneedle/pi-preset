package ui

import (
	"bytes"
	_ "embed"
	"html/template"
	"io"
	"strings"
)

//go:embed embedded/app.html
var appTmplStr string
var appTmpl = template.Must(template.New("app").Parse(appTmplStr))

func RenderAppShell(w io.Writer, appName string) error {
	var styles strings.Builder
	for _, path := range appStylePaths {
		styles.WriteString(`<link rel="stylesheet" href="` + template.HTMLEscapeString(path) + `">`)
	}
	data := struct {
		LiveDocumentStart template.HTML
		ThemeBoot         template.HTML
		AppScript         template.HTML
		LiveDocumentEnd   template.HTML
	}{
		LiveDocumentStart: template.HTML(renderLiveDocumentStart(liveDocumentData{Title: appName, AppName: appName, Styles: template.HTML(styles.String())})),
		ThemeBoot:         liveThemeBootScript(),
		AppScript:         template.HTML(`<script type="module" src="` + template.HTMLEscapeString(appScriptPath) + `"></script>`),
		LiveDocumentEnd:   liveDocumentEnd(),
	}
	var buf bytes.Buffer
	if err := appTmpl.Execute(&buf, data); err != nil {
		return err
	}
	_, err := w.Write(buf.Bytes())
	return err
}
