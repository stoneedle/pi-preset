package workers

import "io"

func readRuntimeFile(path string) ([]byte, error) {
	file, err := openRuntimeFile(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(file)
}
