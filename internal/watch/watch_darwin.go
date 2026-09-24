//go:build darwin

package watch

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsevents"
)

const (
	latency   = 50 * time.Millisecond
	rescanFor = fsevents.MustScanSubDirs | fsevents.UserDropped | fsevents.KernelDropped
)

type stream struct {
	es   *fsevents.EventStream
	quit chan struct{}
	done chan struct{}
}

type fseventsWatcher struct {
	mu      sync.Mutex
	closed  bool
	streams map[string]*stream // resolved root → stream
	events  chan Event
	errors  chan error
}

// New returns an FSEvents-backed Watcher (one stream per root).
func New() (Watcher, error) {
	return &fseventsWatcher{
		streams: map[string]*stream{},
		events:  make(chan Event, 4096),
		errors:  make(chan error, 16),
	}, nil
}

func (w *fseventsWatcher) Events() <-chan Event { return w.events }
func (w *fseventsWatcher) Errors() <-chan error { return w.errors }

func resolve(root string) (string, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

func (w *fseventsWatcher) Add(root string) error {
	real, err := resolve(root)
	if err != nil {
		return fmt.Errorf("watch %s: %w", root, err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return errors.New("watch: watcher is closed")
	}
	if _, ok := w.streams[real]; ok {
		return nil
	}
	s := &stream{
		es: &fsevents.EventStream{
			Paths:   []string{real},
			Latency: latency,
			Flags:   fsevents.FileEvents | fsevents.NoDefer,
			Events:  make(chan []fsevents.Event, 64),
		},
		quit: make(chan struct{}),
		done: make(chan struct{}),
	}
	if err := s.es.Start(); err != nil {
		return fmt.Errorf("watch %s: %w", real, err)
	}
	w.streams[real] = s
	go w.forward(s)
	return nil
}

func (w *fseventsWatcher) forward(s *stream) {
	defer close(s.done)
	for {
		select {
		case <-s.quit:
			return
		case batch := <-s.es.Events:
			for _, e := range batch {
				ev, ok := convert(e)
				if !ok {
					continue
				}
				select {
				case w.events <- ev:
				case <-s.quit:
					return
				}
			}
		}
	}
}

// convert maps an FSEvents event to ours. FSEvents reports absolute,
// symlink-resolved paths when the stream is not device-relative.
func convert(e fsevents.Event) (Event, bool) {
	if e.Flags&fsevents.HistoryDone != 0 || e.Path == "" {
		return Event{}, false
	}
	p := filepath.Clean("/" + e.Path)
	return Event{Path: p, Rescan: e.Flags&rescanFor != 0}, true
}

// stop ends the forwarder, then stops the stream while draining its channel
// so an in-flight FSEvents callback can never block Stop.
func (s *stream) stop() {
	close(s.quit)
	<-s.done
	stopped := make(chan struct{})
	go func() {
		s.es.Stop()
		close(stopped)
	}()
	for {
		select {
		case <-s.es.Events:
		case <-stopped:
			return
		}
	}
}

func (w *fseventsWatcher) Remove(root string) error {
	real, err := resolve(root)
	if err != nil {
		real = filepath.Clean(root) // the root may already be gone
	}
	w.mu.Lock()
	s, ok := w.streams[real]
	delete(w.streams, real)
	w.mu.Unlock()
	if ok {
		s.stop()
	}
	return nil
}

func (w *fseventsWatcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	streams := w.streams
	w.streams = map[string]*stream{}
	w.mu.Unlock()
	for _, s := range streams {
		s.stop()
	}
	close(w.events)
	close(w.errors)
	return nil
}
