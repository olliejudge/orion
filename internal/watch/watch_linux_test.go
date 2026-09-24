//go:build linux

package watch

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
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

func skipIfRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
}

// lockDir makes dir unreadable for the rest of the test.
func lockDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
}

func TestUnreadableSubdirIsPathError(t *testing.T) {
	skipIfRoot(t)
	root := tempRoot(t)
	locked := filepath.Join(root, "locked")
	lockDir(t, locked)
	w, err := New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	if err := w.Add(root); err != nil {
		t.Fatalf("Add: %v", err)
	}
	select {
	case err := <-w.Errors():
		var pe *fs.PathError
		if !errors.As(err, &pe) || pe.Path != locked {
			t.Fatalf("error = %#v, want *fs.PathError for %s", err, locked)
		}
		if !errors.Is(err, fs.ErrPermission) {
			t.Fatalf("error = %v, want a permission error", err)
		}
	case <-time.After(eventTimeout):
		t.Fatal("no error for the unreadable subdirectory")
	}
}

func TestAddFailureLeavesNothingRegistered(t *testing.T) {
	skipIfRoot(t)
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	lockDir(t, root)
	w := newWatcher(t).(*inotifyWatcher)
	err := w.Add(root)
	var pe *fs.PathError
	if !errors.As(err, &pe) {
		t.Fatalf("Add(unreadable root) = %v, want *fs.PathError", err)
	}
	if len(w.roots) != 0 || len(w.fw.WatchList()) != 0 {
		t.Fatalf("after failed Add: roots %v, watches %v; want none", w.roots, w.fw.WatchList())
	}
}

func TestFullErrorBufferBecomesRescan(t *testing.T) {
	root := tempRoot(t)
	w := newWatcher(t, root).(*inotifyWatcher)
	for range cap(w.errors) + 1 {
		w.handleError(&fs.PathError{Op: "watch", Path: filepath.Join(root, "d"), Err: syscall.EACCES})
	}
	select {
	case ev := <-w.Events():
		if ev != (Event{Path: root, Rescan: true}) {
			t.Fatalf("event = %+v, want a rescan of %s", ev, root)
		}
	case <-time.After(eventTimeout):
		t.Fatal("dropped error produced no rescan")
	}
}
