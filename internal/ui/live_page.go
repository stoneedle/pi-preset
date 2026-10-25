package ui

import (
	"html/template"
	"strings"
)

const defaultMonoStack = "ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace"

var fontProvider = func() (string, string, string, string, string) {
	return "system-ui, -apple-system, sans-serif", "system-ui, -apple-system, sans-serif", defaultMonoStack, "16", "16"
}

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
	b.WriteString(`</title><link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/icon-192.png"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#ffffff"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Pi"><style>` + liveThemeCss + `</style>`)
	ui, content, code, uiSize, contentSize := fontProvider()
	b.WriteString(`<style>:root{--font-sans:` + ui + `;--font-content:` + content + `;--font-code:` + code + `;--font-size-ui:` + uiSize + `px;--font-content-size:` + contentSize + `px}</style>`)
	b.WriteString(string(data.Styles))
	b.WriteString(`</head><body>`)
	return b.String()
}

func liveThemeBootScript() template.HTML {
	return template.HTML(`<script>(function(){function update(){var color=getComputedStyle(document.documentElement).getPropertyValue('--body-bg').trim();var meta=document.querySelector('meta[name="theme-color"]');if(color&&meta)meta.content=color;}update();matchMedia('(prefers-color-scheme: dark)').addEventListener('change',update);})();</script>`)
}

func liveDocumentEnd() template.HTML { return template.HTML("</body></html>") }
