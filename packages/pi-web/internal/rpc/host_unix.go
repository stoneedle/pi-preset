//go:build !windows

package rpc

import (
	"os/exec"
	"syscall"
)

func detachHost(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
