//go:build !windows

package workers

import (
	"context"
	"errors"
	"syscall"

	"github.com/shirou/gopsutil/v4/process"
)

func killProcessTree(ctx context.Context, pid int32) error {
	parent, err := process.NewProcessWithContext(ctx, pid)
	if errors.Is(err, process.ErrorProcessNotRunning) {
		return nil
	}
	if err != nil {
		return err
	}
	children, err := parent.ChildrenWithContext(ctx)
	if err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	for _, child := range children {
		if err := killProcessTree(ctx, child.Pid); err != nil {
			return err
		}
	}
	err = parent.KillWithContext(ctx)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
