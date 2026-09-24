package repo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"maps"
	"os"
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
	rw := &rootWatch{w: w, polls: polls, watched: map[string]os.FileInfo{}}
	var sched *Scheduler
	sched = NewScheduler(debounce, minInterval, func(key string, r Reason) {
		e.fire(ctx, key, r)
		// A fire may have dropped or re-found a worktree whose root lost its
		// watch; files written while it was unwatched were never reported.
		for _, id := range rw.reconcile() {
			sched.Trigger(string(id), ReasonFiles)
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
	rw.reconcile() // the startup rescan below covers the roots just added
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
		// the dropped events may include a root's deletion: check them all.
		rw.checkAll()
		e.triggerAll(s, ReasonRescan)
		return
	}
	if rw.lost(ev.Path) {
		s.Trigger(keyWorktrees, ReasonWorktrees)
	}
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
// root in line with the worktree set. A root whose directory is deleted or
// replaced loses its watch without notice on linux (inotify watches follow
// the inode, and the root's parent is not watched), so such roots are
// forgotten and re-added once the directory is back.
type rootWatch struct {
	w     watch.Watcher
	polls *pollSet

	mu   sync.Mutex
	want map[string]model.WorktreeID // roots the current worktrees need
	// watched maps each root Add was called for to the directory it watched;
	// nil means Add failed and the worktree is polled instead.
	watched map[string]os.FileInfo
	fresh   []model.WorktreeID // worktrees whose root was (re)watched since the last reconcile
}

// set is e.watchRoots: it records the roots the worktrees need and brings
// the watcher in line. It is called on every routing rebuild, often with an
// unchanged set, so it only acts on differences.
func (rw *rootWatch) set(roots map[string]model.WorktreeID) {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	rw.want = maps.Clone(roots)
	rw.sync()
}

// reconcile re-adds wanted roots that have no watch (lost, or missing when
// last tried) and returns the worktrees whose root was watched since the
// previous call, so their status can be recomputed.
func (rw *rootWatch) reconcile() []model.WorktreeID {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	rw.sync()
	fresh := rw.fresh
	rw.fresh = nil
	return fresh
}

// sync unwatches unwanted roots and watches wanted ones. rw.mu must be held.
func (rw *rootWatch) sync() {
	for root := range rw.watched {
		if _, ok := rw.want[root]; !ok {
			_ = rw.w.Remove(root)
			delete(rw.watched, root)
		}
	}
	for root, id := range rw.want {
		if _, ok := rw.watched[root]; ok {
			continue
		}
		fi, err := os.Stat(root)
		if err != nil {
			continue // gone: the worktree sync drops it, or it comes back and is retried
		}
		if err := rw.w.Add(root); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			rw.polls.add(id, fmt.Errorf("watch %s: %w", root, err))
			fi = nil
		} else {
			rw.fresh = append(rw.fresh, id)
		}
		rw.watched[root] = fi
	}
}

// lost reports whether p is a watched root whose directory is gone or was
// replaced since it was watched. Such a root is unwatched and forgotten, so
// the next reconcile watches it again if it is still wanted.
func (rw *rootWatch) lost(p string) bool {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	return rw.lostLocked(p)
}

func (rw *rootWatch) lostLocked(root string) bool {
	fi := rw.watched[root]
	if fi == nil {
		return false // not a root, or polled
	}
	if cur, err := os.Stat(root); err == nil && os.SameFile(fi, cur) {
		return false
	}
	_ = rw.w.Remove(root)
	delete(rw.watched, root)
	return true
}

// checkAll runs lost for every watched root.
func (rw *rootWatch) checkAll() {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	for root := range rw.watched {
		rw.lostLocked(root)
	}
}

func (e *Engine) triggerAll(s *Scheduler, r Reason) {
	for _, id := range e.router.Load().ids() {
		s.Trigger(string(id), r)
	}
	s.Trigger(keyRefs, r)
}
