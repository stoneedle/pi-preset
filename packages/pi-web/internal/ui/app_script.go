package ui

var appScriptPath = "/static/assets/app.js"
var appStylePaths []string

func SetAppAssets(script string, styles []string) {
	appScriptPath = script
	appStylePaths = styles
}
