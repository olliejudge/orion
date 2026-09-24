package repo

import (
	"context"
	"os"
	"path/filepath"
	"sort"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
)

// wtState is the engine's cached view of one worktree. Maps are replaced,
// never mutated, because model.Store keeps references to published States.
type wtState struct {
	g           gitx.Worktree // g.Path is canonical (symlinks resolved)
	subject     string        // subject of g.Head
	subjectFor  string        // the Head that subject belongs to
	committed   map[string]model.ChangeEntry
	uncommitted map[string]model.ChangeEntry
}

// canon returns p with symlinks resolved (macOS: /var → /private/var), or p
// cleaned when it does not exist.
func canon(p string) string {
	if c, err := filepath.EvalSymlinks(p); err == nil {
		return c
	}
	return filepath.Clean(p)
}

// label implements model.Worktree.Label: branch, else short sha, else "main".
func label(g gitx.Worktree) string {
	switch {
	case g.Branch != "":
		return g.Branch
	case len(g.Head) >= 7:
		return g.Head[:7]
	case g.Head != "":
		return g.Head
	default:
		return "main"
	}
}

// baseTree lists the files of sha. An empty sha (no commits) is an empty tree.
func baseTree(ctx context.Context, r gitx.Runner, dir, sha string) (map[string]int64, error) {
	tree := map[string]int64{}
	if sha == "" {
		return tree, nil
	}
	files, err := gitx.LsTree(ctx, r, dir, sha)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		tree[f.Path] = f.Size
	}
	return tree, nil
}

// committedOverlay is what head has on top of merge-base(baseSha, head).
// It is empty when head is unborn, has no base to compare with, is already
// contained in base, or shares no history with base (orphan branch: showing
// its whole tree as "committed" would drown the map).
func committedOverlay(ctx context.Context, r gitx.Runner, dir, baseSha, head string) (map[string]model.ChangeEntry, error) {
	out := map[string]model.ChangeEntry{}
	if head == "" || baseSha == "" || head == baseSha {
		return out, nil
	}
	mb, err := gitx.MergeBase(ctx, r, dir, baseSha, head)
	if err != nil {
		return nil, err
	}
	if mb == "" || mb == head {
		return out, nil
	}
	changes, err := gitx.DiffNameStatus(ctx, r, dir, mb, head)
	if err != nil {
		return nil, err
	}
	if len(changes) == 0 {
		return out, nil
	}
	files, err := gitx.LsTree(ctx, r, dir, head)
	if err != nil {
		return nil, err
	}
	sizes := make(map[string]int64, len(files))
	for _, f := range files {
		sizes[f.Path] = f.Size
	}
	for _, c := range changes {
		e := model.ChangeEntry{Path: c.Path, Kind: model.Kind(c.Kind), From: c.From, Stage: model.Committed}
		if c.Kind != gitx.Deleted {
			e.Size = sizes[c.Path]
		}
		out[c.Path] = e
	}
	return out, nil
}

// uncommittedOverlay is `git status` for the worktree at root, with plain
// moves paired into renames and sizes taken from the working tree.
func uncommittedOverlay(ctx context.Context, r gitx.Runner, root string) (map[string]model.ChangeEntry, error) {
	changes, err := gitx.Status(ctx, r, root)
	if err != nil {
		return nil, err
	}
	out := map[string]model.ChangeEntry{}
	for _, c := range gitx.PairMoves(changes) {
		e := model.ChangeEntry{Path: c.Path, Kind: model.Kind(c.Kind), From: c.From, Stage: model.Uncommitted}
		if c.Kind != gitx.Deleted {
			if fi, err := os.Stat(filepath.Join(root, filepath.FromSlash(c.Path))); err == nil {
				e.Size = fi.Size()
			}
		}
		out[c.Path] = e
	}
	return out, nil
}

// mergeOverlays returns a new map: committed entries, overridden by uncommitted ones.
func mergeOverlays(committed, uncommitted map[string]model.ChangeEntry) map[string]model.ChangeEntry {
	out := make(map[string]model.ChangeEntry, len(committed)+len(uncommitted))
	for p, e := range committed {
		out[p] = e
	}
	for p, e := range uncommitted {
		out[p] = e
	}
	return out
}

func (ws *wtState) model(id model.WorktreeID) model.Worktree {
	return model.Worktree{
		ID:          id,
		Path:        ws.g.Path,
		Label:       label(ws.g),
		Branch:      ws.g.Branch,
		Head:        ws.g.Head,
		IsMain:      ws.g.IsMain,
		Locked:      ws.g.Locked,
		ColorIndex:  -1, // the Store assigns colours
		HeadSubject: ws.subject,
	}
}

// buildState assembles a fresh model.State from the engine caches.
func buildState(info model.RepoInfo, tree map[string]int64, wts map[model.WorktreeID]*wtState) model.State {
	st := model.State{Repo: info, Tree: tree, Overlays: map[model.WorktreeID]map[string]model.ChangeEntry{}}
	for id, ws := range wts {
		st.Worktrees = append(st.Worktrees, ws.model(id))
		if m := mergeOverlays(ws.committed, ws.uncommitted); len(m) > 0 {
			st.Overlays[id] = m
		}
	}
	sort.Slice(st.Worktrees, func(i, j int) bool {
		a, b := st.Worktrees[i], st.Worktrees[j]
		if a.IsMain != b.IsMain {
			return a.IsMain
		}
		return a.Path < b.Path
	})
	return st
}
