package repo

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/olliejudge/orion/internal/model"
)

// Scheduler keys besides worktree IDs.
const (
	keyRefs      = "refs"
	keyWorktrees = "worktrees"
)

// fire recomputes the part of the state named by key (spec §4 step 5) and
// publishes the result. On a git error the error is logged and whatever was
// recomputed successfully is published; the rest keeps its last good value.
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
		if err == nil {
			err = e.recomputeUncommitted(ctx, id)
		}
	}
	if err != nil && ctx.Err() == nil {
		log.Printf("orion: recompute %s: %v", key, err)
	}
	e.publish(e.state()) // under e.work, so publishes happen in recompute order
}

// recomputeRefs re-resolves base; if it moved (or full), rebuilds the base
// tree and every committed overlay, else only those whose HEAD moved.
func (e *Engine) recomputeRefs(ctx context.Context, full bool) error {
	ref, sha, err := e.lookupBase(ctx)
	if err != nil {
		return err
	}
	if sha == "" && e.baseSha != "" {
		// A repo that had commits cannot become empty: git failed. Keep the last good base.
		return fmt.Errorf("base %q no longer resolves", e.baseRef)
	}
	moved := full || sha != e.baseSha
	if moved {
		tree, err := baseTree(ctx, e.r, e.mainRoot, sha)
		if err != nil {
			return err
		}
		e.tree = tree
	}
	e.baseRef, e.baseSha = ref, sha
	return e.syncWorktrees(ctx, moved)
}

func (e *Engine) recomputeUncommitted(ctx context.Context, id model.WorktreeID) error {
	ws, ok := e.wts[id]
	if !ok {
		return nil
	}
	if _, err := os.Stat(ws.g.Path); err != nil {
		return e.syncWorktrees(ctx, false) // directory gone: git now reports it prunable
	}
	m, err := uncommittedOverlay(ctx, e.r, ws.g.Path)
	if err != nil {
		return err
	}
	ws.uncommitted = m
	return nil
}
