//go:build !darwin && !linux

package watch

import (
	"fmt"
	"runtime"
)

// New reports that file watching is unsupported on this platform.
func New() (Watcher, error) {
	return nil, fmt.Errorf("watch: %s is not supported (orion runs on macOS and Linux)", runtime.GOOS)
}
