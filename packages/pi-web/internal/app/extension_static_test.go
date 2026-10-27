package app

import (
	"os"
	"strings"
	"testing"
)

func TestPiWebExtensionRegistersExpectedCommands(t *testing.T) {
	data, err := os.ReadFile(repoPath(".pi/extensions/lib/management.ts"))
	if err != nil {
		t.Fatalf("read extension: %v", err)
	}
	src := string(data)
	for _, want := range []string{
		`pi.registerCommand("pi-web"`,
		`pi.registerCommand("remote"`,
		`用法：/pi-web [status|version|path|token|set-token|start|stop|restart|remote|help]`,
		"launchctl",
		"systemctl",
		`import("qrcode")`,
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("extension missing expected marker %q", want)
		}
	}
}
