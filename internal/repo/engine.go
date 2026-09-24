package repo

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
)

// subBuffer is each subscriber's channel capacity; a subscriber that falls
// this far behind is dropped and must resync.
const subBuffer = 256

// Engine owns the live model of one repo: it watches the filesystem,
// recomputes the affected parts with gitx and broadcasts model patches.
type Engine struct {
	r            gitx.Runner
	baseOverride string
	warnedBase   bool
	mainRoot     string // canonical
	commonDir    string // canonical
	name         string

	work    sync.Mutex // serialises recomputes; guards the fields below
	baseRef string
	baseSha string
	tree    map[string]int64
	wts     map[model.WorktreeID]*wtState
	// watchRoots is set by Run: it receives the roots (outside the main
	// root) that must be watched, mapped to their worktree.
	watchRoots func(roots map[string]model.WorktreeID)

	router atomic.Pointer[Router]
	ready  chan struct{} // closed once Run's watchers are live

	mu      sync.Mutex // guards store and subs
	store   *model.Store
	subs    map[int]chan model.Patch
	nextSub int
}

// Open resolves the repo containing path and computes its initial state.
func Open(ctx context.Context, path, baseOverride string, r gitx.Runner) (*Engine, error) {
	if _, err := gitx.CheckVersion(ctx, r); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	mainRoot, err := gitx.MainRoot(ctx, r, abs)
	if err != nil {
		return nil, fmt.Errorf("not a git repository: %s: %w", abs, err)
	}
	commonDir, err := gitx.CommonDir(ctx, r, abs)
	if err != nil {
		return nil, err
	}
	e := &Engine{
		r:            r,
		baseOverride: baseOverride,
		mainRoot:     canon(mainRoot),
		commonDir:    canon(commonDir),
		wts:          map[model.WorktreeID]*wtState{},
		ready:        make(chan struct{}),
		subs:         map[int]chan model.Patch{},
	}
	e.name = filepath.Base(e.mainRoot)
	ref, sha, err := e.lookupBase(ctx)
	if err != nil {
		return nil, err
	}
	tree, err := baseTree(ctx, r, e.mainRoot, sha)
	if err != nil {
		return nil, err
	}
	e.baseRef, e.baseSha, e.tree = ref, sha, tree
	e.work.Lock()
	defer e.work.Unlock()
	if err := e.syncWorktrees(ctx, true); err != nil { // also builds the router
		return nil, err
	}
	e.store = model.NewStore(e.state(), time.Now())
	return e, nil
}

// Snapshot returns the current full state.
func (e *Engine) Snapshot() model.Snapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.store.Snapshot()
}

// Subscribe returns a channel of every future patch. When the buffer fills,
// the channel is closed and dropped; the subscriber must Subscribe again and
// take a fresh Snapshot. The returned func unsubscribes (safe to call twice).
func (e *Engine) Subscribe() (<-chan model.Patch, func()) {
	e.mu.Lock()
	defer e.mu.Unlock()
	id := e.nextSub
	e.nextSub++
	ch := make(chan model.Patch, subBuffer)
	e.subs[id] = ch
	return ch, func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if c, ok := e.subs[id]; ok {
			delete(e.subs, id)
			close(c)
		}
	}
}

// syncWorktrees reconciles e.wts with `git worktree list`: adds new worktrees
// (fully computed), drops removed or prunable ones, refreshes metadata, and
// recomputes committed overlays for moved HEADs (all of them when force).
func (e *Engine) syncWorktrees(ctx context.Context, force bool) error {
	list, err := gitx.ListWorktrees(ctx, e.r, e.mainRoot)
	if err != nil {
		return err
	}
	seen := map[model.WorktreeID]bool{}
	changed := false
	for _, g := range list {
		if g.Prunable {
			continue
		}
		g.Path = canon(g.Path)
		id := model.IDFor(g.Path)
		seen[id] = true
		ws, ok := e.wts[id]
		if !ok {
			ws = &wtState{g: g, uncommitted: map[string]model.ChangeEntry{}}
			e.wts[id] = ws
			changed = true
			e.refreshHead(ctx, ws)
			e.refreshStatus(ctx, ws)
			continue
		}
		moved := ws.g.Head != g.Head
		ws.g = g
		if moved || force {
			e.refreshHead(ctx, ws)
		}
		if moved {
			// A commit moves HEAD and empties status together; recompute both
			// so one patch shows uncommitted → committed with the new HEAD.
			e.refreshStatus(ctx, ws)
		}
	}
	for id := range e.wts {
		if !seen[id] {
			delete(e.wts, id)
			changed = true
		}
	}
	if changed {
		e.rebuildRouting()
	}
	return nil
}

// refreshHead recomputes ws's HEAD subject and committed overlay.
func (e *Engine) refreshHead(ctx context.Context, ws *wtState) {
	if ws.subjectFor != ws.g.Head {
		ws.subject, ws.subjectFor = "", ws.g.Head
		if ws.g.Head != "" {
			if s, err := gitx.CommitSubject(ctx, e.r, e.mainRoot, ws.g.Head); err == nil {
				ws.subject = s
			} else {
				log.Printf("orion: subject of %s: %v", ws.g.Head, err)
			}
		}
	}
	m, err := committedOverlay(ctx, e.r, e.mainRoot, e.baseSha, ws.g.Head)
	if err != nil {
		log.Printf("orion: committed changes of %s: %v", ws.g.Path, err)
		return
	}
	ws.committed = m
}

// refreshStatus recomputes ws's uncommitted overlay, keeping the last good
// one on error.
func (e *Engine) refreshStatus(ctx context.Context, ws *wtState) {
	m, err := uncommittedOverlay(ctx, e.r, ws.g.Path)
	if err != nil {
		log.Printf("orion: status %s: %v", ws.g.Path, err)
		return
	}
	ws.uncommitted = m
}

// rebuildRouting installs a Router for the current worktrees and reports the
// roots that need their own watch (linked worktrees outside the main root) to
// e.watchRoots, which Run sets. e.work must be held.
func (e *Engine) rebuildRouting() {
	var targets []RouteTarget
	outside := map[string]model.WorktreeID{}
	for id, ws := range e.wts {
		t := RouteTarget{ID: id, Root: ws.g.Path}
		if ws.g.IsMain {
			t.AdminDir = e.commonDir
		} else if admin, err := gitx.WorktreeAdminDir(ws.g.Path); err == nil {
			t.AdminDir = canon(admin)
		}
		targets = append(targets, t)
		if _, inside := under(ws.g.Path, e.mainRoot); !inside {
			outside[ws.g.Path] = id
		}
	}
	e.router.Store(NewRouter(e.commonDir, targets))
	if e.watchRoots != nil {
		e.watchRoots(outside)
	}
}

// lookupBase resolves the base branch. When --base cannot be resolved it
// warns (once) and falls back to the main worktree's HEAD (spec §8). The
// override is kept, so creating that branch later makes it the base.
func (e *Engine) lookupBase(ctx context.Context) (string, string, error) {
	ref, sha, err := gitx.ResolveBase(ctx, e.r, e.mainRoot, e.baseOverride)
	if err == nil || e.baseOverride == "" {
		return ref, sha, err
	}
	if !e.warnedBase {
		log.Printf("orion: %v; falling back to the main worktree's HEAD", err)
		e.warnedBase = true
	}
	wts, err := gitx.ListWorktrees(ctx, e.r, e.mainRoot)
	if err != nil {
		return "", "", err
	}
	for _, w := range wts {
		if w.IsMain {
			return label(w), w.Head, nil
		}
	}
	return "", "", nil
}

func (e *Engine) state() model.State {
	return buildState(model.RepoInfo{Name: e.name, Base: e.baseRef, BaseSha: e.baseSha}, e.tree, e.wts)
}

// publish applies st to the store and fans the patch out. A subscriber whose
// buffer is full is closed and dropped.
func (e *Engine) publish(st model.State) {
	e.mu.Lock()
	defer e.mu.Unlock()
	p, ok := e.store.Apply(st, time.Now())
	if !ok {
		return
	}
	for id, ch := range e.subs {
		select {
		case ch <- p:
		default:
			delete(e.subs, id)
			close(ch)
		}
	}
}
