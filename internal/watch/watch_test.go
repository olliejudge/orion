package watch

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const eventTimeout = 2 * time.Second

func tempRoot(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func newWatcher(t *testing.T, roots ...string) Watcher {
	t.Helper()
	w, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = w.Close() })
	for _, r := range roots {
		if err := w.Add(r); err != nil {
			t.Fatalf("Add(%s): %v", r, err)
		}
	}
	settle(w)
	return w
}

// settle drains events for a short quiet period so earlier activity (or
// stream start-up) cannot satisfy the next expectation.
func settle(w Watcher) {
	for {
		select {
		case _, ok := <-w.Events():
			if !ok {
				return
			}
		case <-time.After(200 * time.Millisecond):
			return
		}
	}
}

func expectEvent(t *testing.T, w Watcher, path string) {
	t.Helper()
	deadline := time.After(eventTimeout)
	for {
		select {
		case ev, ok := <-w.Events():
			if !ok {
				t.Fatalf("events closed while waiting for %s", path)
			}
			if ev.Path == path || ev.Rescan {
				return
			}
		case err := <-w.Errors():
			t.Fatalf("watch error while waiting for %s: %v", path, err)
		case <-deadline:
			t.Fatalf("no event for %s within %s", path, eventTimeout)
		}
	}
}

func expectNoEventUnder(t *testing.T, w Watcher, root string, wait time.Duration) {
	t.Helper()
	deadline := time.After(wait)
	for {
		select {
		case ev := <-w.Events():
			if rel, err := filepath.Rel(root, ev.Path); err == nil && filepath.IsLocal(rel) || ev.Path == root {
				t.Fatalf("unexpected event under removed root: %+v", ev)
			}
		case <-deadline:
			return
		}
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCreateModifyRenameDelete(t *testing.T) {
	root := tempRoot(t)
	w := newWatcher(t, root)
	a := filepath.Join(root, "a.txt")
	b := filepath.Join(root, "b.txt")

	write(t, a, "one")
	expectEvent(t, w, a)
	settle(w)

	f, err := os.OpenFile(a, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(" two"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	expectEvent(t, w, a)
	settle(w)

	if err := os.Rename(a, b); err != nil {
		t.Fatal(err)
	}
	expectEvent(t, w, b)
	settle(w)

	if err := os.Remove(b); err != nil {
		t.Fatal(err)
	}
	expectEvent(t, w, b)
}

func TestNestedDirCreatedAfterStartIsWatched(t *testing.T) {
	root := tempRoot(t)
	w := newWatcher(t, root)
	deep := filepath.Join(root, "sub", "deeper", "x.txt")
	write(t, deep, "hi") // MkdirAll + write races the watcher adding sub/ and sub/deeper/
	expectEvent(t, w, deep)
	settle(w)

	write(t, deep, "again")
	expectEvent(t, w, deep)
}

func TestExistingNestedDirIsWatched(t *testing.T) {
	root := tempRoot(t)
	nested := filepath.Join(root, "pre", "existing", "file.txt")
	write(t, nested, "before")
	w := newWatcher(t, root)
	write(t, nested, "after")
	expectEvent(t, w, nested)
}

func TestRemoveStopsEvents(t *testing.T) {
	keep, drop := tempRoot(t), tempRoot(t)
	w := newWatcher(t, keep, drop)
	if err := w.Remove(drop); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	settle(w)

	write(t, filepath.Join(drop, "ignored.txt"), "x")
	expectNoEventUnder(t, w, drop, 500*time.Millisecond)

	kept := filepath.Join(keep, "kept.txt")
	write(t, kept, "y")
	expectEvent(t, w, kept)
}

func TestAddIsIdempotentAndResolvesSymlinks(t *testing.T) {
	root := tempRoot(t)
	link := filepath.Join(tempRoot(t), "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	w := newWatcher(t, root, root, link)
	p := filepath.Join(root, "f.txt")
	write(t, p, "x")
	expectEvent(t, w, p) // reported under the resolved root, not the link
}

func TestCloseClosesChannels(t *testing.T) {
	w, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Add(tempRoot(t)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case _, ok := <-w.Events():
		if ok {
			// A buffered event may still be pending; the channel must close right after.
			for range w.Events() {
			}
		}
	case <-time.After(eventTimeout):
		t.Fatal("Events not closed after Close")
	}
	if err := w.Add(tempRoot(t)); err == nil {
		t.Fatal("Add after Close: want error")
	}
}
