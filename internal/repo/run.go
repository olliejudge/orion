package repo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"maps"
	"sync"
	"time"

	"github.com/olliejudge/orion/internal/model"
	"github.com/olliejudge/orion/internal/watch"
)

const (
	debounce     = 150 * time.Millisecond // Global Constraints
	minInterval  = 250 * time.Millisecond // ≤ 4 recomputes/s per key
	pollInterval = 2 * time.Second        // spec §8 watcher-failure fallback
)

// newWatcher is swapped by tests that need a fake watcher.
var newWatcher = watch.New

// pollSet records which worktrees the watcher failed for (spec §8: log once,
// then poll their status every 2 s). all means the failure could not be
// pinned to one worktree, so everything is polled.
type pollSet struct {
	mu     sync.Mutex
	warned bool
	all    bool
	ids    map[model.WorktreeID]bool
}

func (p *pollSet) add(id model.WorktreeID, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.warned {
		log.Printf("orion: file watcher: %v; polling git status every %v instead", err, pollInterval)
		p.warned = true
	}
	if id == "" {
		p.all = true
		return
	}
	if p.ids == nil {
		p.ids = map[model.WorktreeID]bool{}
	}
	p.ids[id] = true
}

func (p *pollSet) targets() (bool, map[model.WorktreeID]bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	ids := make(map[model.WorktreeID]bool, len(p.ids))
	for id := range p.ids {
		ids[id] = true
	}
	return p.all, ids
}

// Run watches the repo and keeps the model live until ctx is done. Watcher
// failures never stop it: the affected worktrees are polled instead.
func (e *Engine) Run(ctx context.Context) error {
	w, err := newWatcher()
	if err != nil {
		return fmt.Errorf("start watcher: %w", err)
	}
	polls := &pollSet{}
	rw := &rootWatch{w: w, polls: polls, roots: map[string]rootState{}}
	var sched *Scheduler
	sched = NewScheduler(debounce, minInterval, func(key string, r Reason) {
		// Restore lost root watches first, so this recompute misses nothing
		// written while a root was unwatched; other worktrees whose root was
		// (re)watched get a status recompute of their own.
		rw.reconcile()
		e.fire(ctx, key, r)
		for _, id := range rw.takeFresh() {
			if string(id) != key {
				sched.Trigger(string(id), ReasonFiles)
			}
		}
	})
	ticker := time.NewTicker(pollInterval)
	defer func() {
		ticker.Stop()
		sched.Close() // waits for in-flight recomputes, which may still call e.watchRoots
		e.work.Lock()
		e.watchRoots = nil
		e.work.Unlock()
		_ = w.Close()
	}()

	e.work.Lock()
	if err := w.Add(e.mainRoot); err != nil {
		polls.add("", fmt.Errorf("watch %s: %w", e.mainRoot, err))
	}
	if _, inside := under(e.commonDir, e.mainRoot); !inside {
		if err := w.Add(e.commonDir); err != nil {
			polls.add("", fmt.Errorf("watch %s: %w", e.commonDir, err))
		}
	}
	e.watchRoots = rw.set
	e.rebuildRouting() // watches linked worktrees outside the main root
	e.work.Unlock()
	rw.takeFresh() // the startup rescan below covers the roots just watched
	close(e.ready)
	e.triggerAll(sched, ReasonRescan) // catch changes made between Open and now

	events, errs := w.Events(), w.Errors()
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-events:
			if !ok {
				events = nil
				polls.add("", errors.New("watcher event stream closed"))
				continue
			}
			e.dispatch(sched, rw, ev)
		case err, ok := <-errs:
			if !ok {
				errs = nil
				continue
			}
			var id model.WorktreeID
			var pe *fs.PathError
			if errors.As(err, &pe) {
				id = e.router.Load().Route(pe.Path).Worktree
			}
			polls.add(id, err)
		case <-ticker.C:
			all, ids := polls.targets()
			for _, id := range e.router.Load().ids() {
				switch {
				case all:
					sched.Trigger(string(id), ReasonFiles|ReasonRef)
				case ids[id]:
					sched.Trigger(string(id), ReasonFiles)
				}
			}
			if all {
				sched.Trigger(keyRefs, ReasonRefs)
			}
		}
	}
}

func (e *Engine) dispatch(s *Scheduler, rw *rootWatch, ev watch.Event) {
	if ev.Rescan {
		// The path may be a root or (FSEvents drops) an ancestor of one, and
		// the dropped events may include a root's deletion.
		rw.markStale("")
		e.triggerAll(s, ReasonRescan)
		return
	}
	rw.markStale(ev.Path)
	rt := e.router.Load().Route(ev.Path)
	switch rt.Class {
	case FileEvent:
		s.Trigger(string(rt.Worktree), ReasonFiles)
	case WorktreeRefEvent:
		s.Trigger(string(rt.Worktree), ReasonRef)
	case RefsEvent:
		s.Trigger(keyRefs, ReasonRefs)
	case WorktreesChanged:
		s.Trigger(keyWorktrees, ReasonWorktrees)
	}
}

// rootWatch keeps the watcher's roots for linked worktrees outside the main
// root in line with the worktree set.
//
// A root whose directory is deleted, renamed or replaced loses its inotify
// watch without notice (watches follow the inode, and the root's parent is
// not watched); the only sign is an event naming the root itself. Such a
// root is marked stale and added again before the next recompute. Add is
// idempotent, so a false alarm costs little (on darwin, whose path-based
// streams survive this, nothing), and inode numbers are not compared
// because a recreated directory can reuse its predecessor's.
type rootWatch struct {
	w     watch.Watcher
	polls *pollSet

	mu    sync.Mutex
	want  map[string]model.WorktreeID // roots the current worktrees need
	roots map[string]rootState        // roots Add was called for
	fresh []model.WorktreeID          // worktrees whose root was (re)watched since takeFresh
}

type rootState int

const (
	live   rootState = iota
	stale            // the watch may be gone: Add again
	polled           // Add failed: the worktree is polled instead
)

// set is e.watchRoots: it records the roots the worktrees need and brings
// the watcher in line. It is called on every routing rebuild, often with an
// unchanged set, so it only acts on differences.
func (rw *rootWatch) set(want map[string]model.WorktreeID) {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	rw.want = maps.Clone(want)
	rw.sync()
}

// reconcile re-adds stale roots, and wanted roots that were missing before.
func (rw *rootWatch) reconcile() {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	rw.sync()
}

// sync unwatches unwanted roots and watches wanted ones. rw.mu must be held.
func (rw *rootWatch) sync() {
	for root := range rw.roots {
		if _, ok := rw.want[root]; !ok {
			_ = rw.w.Remove(root)
			delete(rw.roots, root)
		}
	}
	for root, id := range rw.want {
		if st, ok := rw.roots[root]; ok && st != stale {
			continue
		}
		switch err := rw.w.Add(root); {
		case err == nil:
			rw.roots[root] = live
			rw.fresh = append(rw.fresh, id)
		case errors.Is(err, fs.ErrNotExist):
			// Gone: the worktree sync drops it, or it comes back and is retried.
		default:
			rw.roots[root] = polled
			rw.polls.add(id, fmt.Errorf("watch %s: %w", root, err))
		}
	}
}

// markStale marks the live root p stale, or every live root when p is "".
func (rw *rootWatch) markStale(p string) {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	if p != "" {
		if rw.roots[p] == live {
			rw.roots[p] = stale
		}
		return
	}
	for root, st := range rw.roots {
		if st == live {
			rw.roots[root] = stale
		}
	}
}

// takeFresh returns and clears the worktrees whose root was (re)watched.
func (rw *rootWatch) takeFresh() []model.WorktreeID {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	fresh := rw.fresh
	rw.fresh = nil
	return fresh
}

func (e *Engine) triggerAll(s *Scheduler, r Reason) {
	for _, id := range e.router.Load().ids() {
		s.Trigger(string(id), r)
	}
	s.Trigger(keyRefs, r)
}
