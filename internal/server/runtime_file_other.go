//go:build !windows

package server

import "os"

func openRuntimeFile(path string) (*os.File, error) { return os.Open(path) }
