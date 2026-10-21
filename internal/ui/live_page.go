package ui

import (
	"html/template"
	"strings"
)

var themeProvider = func() string { return "dark" }

const defaultMonoStack = "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace"

var fontProvider = func() (string, string, string, string, string) {
	return defaultMonoStack, defaultMonoStack, defaultMonoStack, "14", "14"
}

func SetThemeProvider(provider func() string) { themeProvider = provider }
func SetFontProvider(provider func() (string, string, string, string, string)) {
	fontProvider = provider
}

type liveDocumentData struct {
	Title  string
	Styles template.HTML
}

func renderLiveDocumentStart(data liveDocumentData) string {
	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content"><title>`)
	b.WriteString(template.HTMLEscapeString(data.Title))
	b.WriteString(`</title><link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/icon-192.png"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#111116"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Pi"><meta name="pi-web-theme" content="`)
	b.WriteString(template.HTMLEscapeString(themeProvider()))
	b.WriteString(`"><style>` + liveThemeCss + `</style><link rel="stylesheet" href="/custom-themes.css">`)
	ui, content, code, uiSize, contentSize := fontProvider()
	b.WriteString(`<style>:root{--font-sans:` + ui + `;--font-content:` + content + `;--font-code:` + code + `;--font-size-ui:` + uiSize + `px;--font-content-size:` + contentSize + `px}</style>`)
	b.WriteString(string(data.Styles))
	b.WriteString(`</head><body>`)
	return b.String()
}

func liveThemeBootScript() template.HTML {
	return template.HTML(`<script>(function(){var m=document.querySelector('meta[name="pi-web-theme"]');document.documentElement.dataset.theme=m&&m.content||'dark';var color=getComputedStyle(document.documentElement).getPropertyValue('--body-bg').trim();var meta=document.querySelector('meta[name="theme-color"]');if(color&&meta)meta.content=color;})();</script>`)
}

func liveServiceWorkerScript() template.HTML {
	return template.HTML(`<script>if('serviceWorker' in navigator&&window.isSecureContext){navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){});}</script>`)
}

func liveDocumentEnd() template.HTML { return template.HTML("</body></html>") }
