//go:build linux

package watch

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/fsnotify/fsnotify"
)

type inotifyWatcher struct {
	mu     sync.Mutex
	roots  map[string]bool // resolved roots
	fw     *fsnotify.Watcher
	events chan Event
	errors chan error
	done   chan struct{} // closed when loop exits

	// sendMu guards closed: senders hold it for reading while sending, so
	// Close (which takes it for writing after closing quit) never closes a
	// channel mid-send; quit unblocks senders whose consumer has gone.
	sendMu    sync.RWMutex
	closed    bool
	quit      chan struct{}
	closeOnce sync.Once
}

// New returns an inotify-backed Watcher that adds every directory under each
// root, and new directories as they appear.
func New() (Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &inotifyWatcher{
		fw:     fw,
		roots:  map[string]bool{},
		events: make(chan Event, 4096),
		errors: make(chan error, 16),
		done:   make(chan struct{}),
		quit:   make(chan struct{}),
	}
	go w.loop()
	return w, nil
}

func (w *inotifyWatcher) Events() <-chan Event { return w.events }
func (w *inotifyWatcher) Errors() <-chan error { return w.errors }

func resolve(root string) (string, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// Add watches every directory under root. Unreadable subdirectories are
// reported on Errors and skipped; hitting the inotify watch limit (ENOSPC)
// aborts and returns the error so the caller can fall back to polling.
func (w *inotifyWatcher) Add(root string) error {
	real, err := resolve(root)
	if err != nil {
		return fmt.Errorf("watch %s: %w", root, err)
	}
	w.sendMu.RLock()
	closed := w.closed
	w.sendMu.RUnlock()
	if closed {
		return errors.New("watch: watcher is closed")
	}
	w.mu.Lock()
	w.roots[real] = true
	w.mu.Unlock()
	return w.addTree(real, false)
}

// addTree adds dir and its subdirectories. When announce is true (a directory
// created after start), every entry found is also emitted as an event,
// because files may have been written before the watch existed.
func (w *inotifyWatcher) addTree(dir string, announce bool) error {
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == dir {
				return err
			}
			w.sendError(fmt.Errorf("watch %s: %w", p, err))
			return fs.SkipDir
		}
		if announce && p != dir {
			w.send(Event{Path: p})
		}
		if !d.IsDir() {
			return nil
		}
		if err := w.fw.Add(p); err != nil {
			werr := fmt.Errorf("watch %s: %w", p, err)
			if errors.Is(err, fsnotify.ErrClosed) || isLimit(err) {
				return werr
			}
			w.sendError(werr)
			return fs.SkipDir
		}
		return nil
	})
}

// isLimit reports whether err means the inotify watch limit was reached
// (fs.inotify.max_user_watches), which inotify signals as ENOSPC.
func isLimit(err error) bool { return errors.Is(err, syscall.ENOSPC) }

func (w *inotifyWatcher) loop() {
	defer close(w.done)
	for {
		select {
		case e, ok := <-w.fw.Events:
			if !ok {
				return
			}
			w.handle(e)
		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			w.handleError(err)
		}
	}
}

func (w *inotifyWatcher) handle(e fsnotify.Event) {
	p := filepath.Clean(e.Name)
	if !w.underRoot(p) {
		return
	}
	w.send(Event{Path: p})
	if e.Has(fsnotify.Create) {
		if err := w.addTree(p, true); err != nil && isLimit(err) {
			w.sendError(err)
		}
	}
}

func (w *inotifyWatcher) handleError(err error) {
	if errors.Is(err, fsnotify.ErrEventOverflow) {
		w.mu.Lock()
		roots := make([]string, 0, len(w.roots))
		for r := range w.roots {
			roots = append(roots, r)
		}
		w.mu.Unlock()
		for _, r := range roots {
			w.send(Event{Path: r, Rescan: true})
		}
		return
	}
	w.sendError(err)
}

func (w *inotifyWatcher) underRoot(p string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return rootOf(w.roots, p) != ""
}

// within reports whether p is root or inside it.
func within(root, p string) bool {
	if p == root {
		return true
	}
	rel, err := filepath.Rel(root, p)
	return err == nil && filepath.IsLocal(rel)
}

// rootOf returns the registered root containing p, or "".
func rootOf(roots map[string]bool, p string) string {
	for r := range roots {
		if within(r, p) {
			return r
		}
	}
	return ""
}

func (w *inotifyWatcher) send(ev Event) {
	w.sendMu.RLock()
	defer w.sendMu.RUnlock()
	if w.closed {
		return
	}
	select {
	case w.events <- ev:
	case <-w.quit:
	}
}

func (w *inotifyWatcher) sendError(err error) {
	w.sendMu.RLock()
	defer w.sendMu.RUnlock()
	if w.closed {
		return
	}
	select {
	case w.errors <- err:
	default: // never block the event loop on an unread error
	}
}

func (w *inotifyWatcher) Remove(root string) error {
	real, err := resolve(root)
	if err != nil {
		real = filepath.Clean(root)
	}
	w.mu.Lock()
	delete(w.roots, real)
	remaining := make(map[string]bool, len(w.roots))
	for r := range w.roots {
		remaining[r] = true
	}
	w.mu.Unlock()
	for _, p := range w.fw.WatchList() {
		if !within(real, p) || rootOf(remaining, p) != "" {
			continue // not ours, or also inside another root
		}
		if err := w.fw.Remove(p); err != nil && !errors.Is(err, fsnotify.ErrNonExistentWatch) {
			return fmt.Errorf("unwatch %s: %w", p, err)
		}
	}
	return nil
}

func (w *inotifyWatcher) Close() error {
	var err error
	w.closeOnce.Do(func() {
		close(w.quit) // unblock any sender stuck on a full channel
		w.sendMu.Lock()
		w.closed = true
		w.sendMu.Unlock()
		err = w.fw.Close()
		<-w.done
		close(w.events)
		close(w.errors)
	})
	return err
}
