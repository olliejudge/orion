package repo

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/olliejudge/orion/internal/model"
)

// Scheduler keys besides worktree IDs.
const (
	keyRefs      = "refs"
	keyWorktrees = "worktrees"
)

// fire recomputes the part of the state named by key (spec §4 step 5),
// refreshes whatever an earlier git failure left stale, and publishes the
// result. On a git error the error is logged and whatever was recomputed
// successfully is published; the rest keeps its last good value and is
// retried by the next fire.
func (e *Engine) fire(ctx context.Context, key string, r Reason) {
	if ctx.Err() != nil {
		return
	}
	e.work.Lock()
	defer e.work.Unlock()
	var err error
	switch key {
	case keyRefs:
		err = e.recomputeRefs(ctx, r&ReasonRescan != 0)
	case keyWorktrees:
		err = e.syncWorktrees(ctx, false)
	default:
		id := model.WorktreeID(key)
		if r&ReasonRef != 0 {
			// HEAD or index moved: check base first so a commit on the base
			// branch is seen as "merged", not briefly as "committed on branch".
			err = e.recomputeRefs(ctx, false)
		}
		// Status does not depend on base: run it even when the refs failed.
		moved, uerr := e.recomputeUncommitted(ctx, id)
		err = errors.Join(err, uerr)
		if moved {
			// A commit landed without a ref event yet: pick up the new HEAD
			// now, so this patch moves its files from uncommitted to committed.
			err = errors.Join(err, e.recomputeRefs(ctx, false))
		}
	}
	err = errors.Join(err, e.refreshAllSynced(ctx))
	if err != nil {
		e.logf(ctx, "recompute %s: %v", key, err)
	}
	e.publish(e.state()) // under e.work, so publishes happen in recompute order
}

// recomputeRefs re-resolves base; if it moved (or full), rebuilds the base
// tree, which leaves every committed overlay stale for refreshAll. It then
// rediscovers the worktrees so moved HEADs are seen. When base cannot be
// resolved, the last good base is kept and the worktrees are still synced
// against it.
func (e *Engine) recomputeRefs(ctx context.Context, full bool) error {
	ref, sha, err := e.lookupBase(ctx)
	if err == nil && sha == "" && e.baseSha != "" {
		// A repo that had commits cannot become empty: git failed (or the
		// main worktree that base falls back to is on an unborn branch).
		err = fmt.Errorf("base %q no longer resolves", e.baseRef)
	}
	if err != nil {
		return errors.Join(err, e.syncWorktrees(ctx, false))
	}
	if full || sha != e.baseSha {
		tree, err := baseTree(ctx, e.r, e.mainRoot, sha)
		if err != nil {
			return errors.Join(err, e.syncWorktrees(ctx, false))
		}
		e.tree = tree
	}
	e.baseRef, e.baseSha = ref, sha
	return e.syncWorktrees(ctx, full)
}

// recomputeUncommitted reruns id's status and reports whether it saw a HEAD
// other than the cached one.
func (e *Engine) recomputeUncommitted(ctx context.Context, id model.WorktreeID) (bool, error) {
	ws, ok := e.wts[id]
	if !ok {
		return false, nil
	}
	if _, err := os.Stat(ws.g.Path); err != nil {
		return false, e.syncWorktrees(ctx, false) // directory gone: git now reports it prunable
	}
	return e.refreshStatus(ctx, ws)
}
