//go:build !windows

package workers

import "os"

func openRuntimeFile(path string) (*os.File, error) { return os.Open(path) }
