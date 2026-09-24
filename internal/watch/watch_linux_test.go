//go:build linux

package watch

import (
	"errors"
	"fmt"
	"syscall"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestOverflowBecomesRescanPerRoot(t *testing.T) {
	a, b := tempRoot(t), tempRoot(t)
	w := newWatcher(t, a, b).(*inotifyWatcher)
	w.handleError(fsnotify.ErrEventOverflow)
	got := map[string]bool{}
	for len(got) < 2 {
		select {
		case ev := <-w.Events():
			if !ev.Rescan {
				t.Fatalf("got non-rescan event %+v", ev)
			}
			got[ev.Path] = true
		case <-time.After(eventTimeout):
			t.Fatalf("rescan events = %v, want both roots", got)
		}
	}
	if !got[a] || !got[b] {
		t.Fatalf("rescan events = %v, want %s and %s", got, a, b)
	}
}

func TestLimitErrorIsRecognised(t *testing.T) {
	if !isLimit(fmt.Errorf("watch /x: %w", syscall.ENOSPC)) {
		t.Fatal("wrapped ENOSPC not recognised")
	}
	if isLimit(fmt.Errorf("watch /x: %w", syscall.EACCES)) {
		t.Fatal("EACCES misread as the watch limit")
	}
}

func TestOtherErrorsAreForwarded(t *testing.T) {
	w := newWatcher(t, tempRoot(t)).(*inotifyWatcher)
	w.handleError(syscall.EIO)
	select {
	case err := <-w.Errors():
		if !errors.Is(err, syscall.EIO) {
			t.Fatalf("error = %v, want EIO", err)
		}
	case <-time.After(eventTimeout):
		t.Fatal("error not forwarded")
	}
}
