package repo

import (
	"context"
	"fmt"
	"log"
	"maps"
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
	tree    map[string]model.File
	wts     map[model.WorktreeID]*wtState
	// touchedSha/touched cache the committer time of the latest commit
	// touching each base-tree path, as of touchedSha ("" = no cache yet). When
	// baseSha advances, computeBaseTouched walks only touchedSha..baseSha
	// instead of the whole history.
	touchedSha string
	touched    map[string]int64
	// routingIncomplete is set while a linked worktree's admin dir is unknown.
	routingIncomplete bool
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
	if times, err := e.computeBaseTouched(ctx, sha, treeWant(tree)); err != nil {
		e.logf(ctx, "base file times: %v", err)
	} else {
		applyTouched(tree, times)
	}
	e.baseRef, e.baseSha, e.tree = ref, sha, tree
	e.work.Lock()
	defer e.work.Unlock()
	if err := e.syncWorktrees(ctx, false); err != nil { // also builds the router
		return nil, err
	}
	if err := e.refreshAllSynced(ctx); err != nil {
		e.logf(ctx, "resync after HEAD moved: %v", err)
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

// syncWorktrees reconciles e.wts with `git worktree list`: adds new
// worktrees, drops removed or prunable ones and refreshes their metadata.
// When force is set, every committed overlay is marked stale. The caches
// themselves are recomputed by refreshAll. Routing is rebuilt when the set
// changed, or while a linked worktree's admin dir is still unknown.
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
			ws = &wtState{uncommitted: map[string]model.ChangeEntry{}}
			e.wts[id] = ws
			changed = true
		}
		ws.g = g
		if force {
			ws.committedFor = stamp{}
		}
	}
	for id := range e.wts {
		if !seen[id] {
			delete(e.wts, id)
			changed = true
		}
	}
	if changed || e.routingIncomplete {
		e.rebuildRouting()
	}
	return nil
}

// refreshAll brings every worktree's caches up to date with its HEAD and the
// current base. Only stale values are recomputed, so it is cheap to call
// before every publish, and it retries whatever a git failure left stale.
// It reports whether a status saw a HEAD other than the cached one.
func (e *Engine) refreshAll(ctx context.Context) bool {
	moved := false
	for _, ws := range e.wts {
		if e.refresh(ctx, ws) {
			moved = true
		}
	}
	return moved
}

// refreshAllSynced is refreshAll, followed, when a status saw a moved HEAD,
// by a resync of base and worktrees and another refreshAll, so the moved
// worktree's committed overlay matches its status before anything publishes.
func (e *Engine) refreshAllSynced(ctx context.Context) error {
	if !e.refreshAll(ctx) {
		return nil
	}
	err := e.recomputeRefs(ctx, false)
	e.refreshAll(ctx)
	return err
}

// refresh recomputes ws's HEAD subject and committed overlay when they do not
// match (e.baseSha, ws.g.Head), and its uncommitted overlay when HEAD moved:
// a commit moves HEAD and empties status together, and recomputing both
// makes one patch show uncommitted → committed with the new HEAD. It
// reports whether status saw a HEAD other than ws.g.Head.
func (e *Engine) refresh(ctx context.Context, ws *wtState) bool {
	head := ws.g.Head
	if want := (stamp{ok: true, head: head}); ws.subjectFor != want {
		ws.subject = ""
		if head == "" {
			ws.subjectFor = want
		} else if s, err := gitx.CommitSubject(ctx, e.r, e.mainRoot, head); err != nil {
			e.logf(ctx, "subject of %s: %v", head, err)
		} else {
			ws.subject, ws.subjectFor = s, want
		}
	}
	if want := (stamp{ok: true, base: e.baseSha, head: head}); ws.committedFor != want {
		if m, err := committedOverlay(ctx, e.r, e.mainRoot, e.baseSha, head); err != nil {
			e.logf(ctx, "committed changes of %s: %v", ws.g.Path, err)
		} else {
			ws.committed, ws.committedFor = m, want
		}
	}
	if ws.statusFor != (stamp{ok: true, head: head}) {
		moved, err := e.refreshStatus(ctx, ws)
		if err != nil {
			e.logf(ctx, "status %s: %v", ws.g.Path, err)
		}
		return moved
	}
	return false
}

// refreshStatus recomputes ws's uncommitted overlay and reports whether
// status saw a HEAD other than ws.g.Head (a commit landed since HEAD was last
// read): the caller must then resync HEAD and the committed overlay before
// publishing, or the committed files would briefly vanish. On error the last
// good overlay is kept and its stamp cleared, so any later refresh retries.
func (e *Engine) refreshStatus(ctx context.Context, ws *wtState) (bool, error) {
	m, head, err := uncommittedOverlay(ctx, e.r, ws.g.Path, ws.uncommitted, time.Now())
	if err != nil {
		ws.statusFor = stamp{}
		return false, err
	}
	ws.uncommitted, ws.statusFor = m, stamp{ok: true, head: head}
	return head != ws.g.Head, nil
}

// computeBaseTouched returns the committer time (unix seconds) of the latest
// commit touching each path in want, as of sha, using and refreshing e's
// cache. A repeat call with the same sha reuses the cache outright; when the
// cache's sha is an ancestor of sha (the normal case: base only advances), it
// walks just the new commits and merges them in, instead of the whole
// history. Otherwise (first call, or base moved to unrelated history) it
// walks from scratch, bounded to want. e.work must be held.
func (e *Engine) computeBaseTouched(ctx context.Context, sha string, want map[string]bool) (map[string]int64, error) {
	if sha == "" {
		e.touchedSha, e.touched = "", nil
		return nil, nil
	}
	if sha == e.touchedSha {
		return e.touched, nil
	}
	if e.touchedSha != "" {
		mb, err := gitx.MergeBase(ctx, e.r, e.mainRoot, e.touchedSha, sha)
		if err != nil {
			return nil, err
		}
		if mb == e.touchedSha {
			delta, err := gitx.LogTouched(ctx, e.r, e.mainRoot, e.touchedSha+".."+sha, nil)
			if err != nil {
				return nil, err
			}
			merged := make(map[string]int64, len(e.touched)+len(delta))
			maps.Copy(merged, e.touched)
			maps.Copy(merged, delta)
			e.touched, e.touchedSha = merged, sha
			return e.touched, nil
		}
	}
	times, err := gitx.LogTouched(ctx, e.r, e.mainRoot, sha, want)
	if err != nil {
		return nil, err
	}
	e.touched, e.touchedSha = times, sha
	return e.touched, nil
}

// logf logs a recompute problem, unless ctx is done (then the failure is
// just the cancellation).
func (e *Engine) logf(ctx context.Context, format string, args ...any) {
	if ctx.Err() == nil {
		log.Printf("orion: "+format, args...)
	}
}

// rebuildRouting installs a Router for the current worktrees and reports the
// roots that need their own watch (linked worktrees outside the main root) to
// e.watchRoots, which Run sets. A linked worktree whose admin dir cannot be
// read yet (its .git file is written after its admin entry) gets file events
// only, and e.routingIncomplete makes the next sync try again. e.work must be
// held.
func (e *Engine) rebuildRouting() {
	var targets []RouteTarget
	outside := map[string]model.WorktreeID{}
	e.routingIncomplete = false
	for id, ws := range e.wts {
		t := RouteTarget{ID: id, Root: ws.g.Path}
		if ws.g.IsMain {
			t.AdminDir = e.commonDir
		} else if admin, err := gitx.WorktreeAdminDir(ws.g.Path); err == nil {
			t.AdminDir = canon(admin)
		} else {
			log.Printf("orion: routing %s: %v", ws.g.Path, err)
			e.routingIncomplete = true
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
		e.logf(ctx, "%v; falling back to the main worktree's HEAD", err)
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
