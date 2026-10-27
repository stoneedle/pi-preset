//go:build windows

package rpc

import (
	"os/exec"
	"syscall"
)

func detachHost(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x00000008, HideWindow: true}
}
