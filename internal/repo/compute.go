package repo

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
)

// wtState is the engine's cached view of one worktree. Maps are replaced,
// never mutated, because model.Store keeps references to published States.
// Each cached value carries a stamp of the inputs it was computed from,
// recorded only when the computation succeeded, so a value left stale by a
// git failure is recomputed on the next refresh.
type wtState struct {
	g            gitx.Worktree // g.Path is canonical (symlinks resolved)
	subject      string        // subject of g.Head
	subjectFor   stamp         // head only
	committed    map[string]model.ChangeEntry
	committedFor stamp // base and head
	uncommitted  map[string]model.ChangeEntry
	statusFor    stamp // head only (the one status saw): redone when HEAD moves
}

// stamp names the inputs a cached value was computed from; the zero stamp
// matches nothing.
type stamp struct {
	ok         bool
	base, head string
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

// baseTree lists the files of sha (Touched left unset: the caller fills it in
// from the engine's touched-time cache). An empty sha (no commits) is an
// empty tree.
func baseTree(ctx context.Context, r gitx.Runner, dir, sha string) (map[string]model.File, error) {
	tree := map[string]model.File{}
	if sha == "" {
		return tree, nil
	}
	files, err := gitx.LsTree(ctx, r, dir, sha)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		tree[f.Path] = model.File{Path: f.Path, Size: f.Size}
	}
	return tree, nil
}

// treeWant is the set of paths in tree, for bounding a LogTouched walk.
func treeWant(tree map[string]model.File) map[string]bool {
	want := make(map[string]bool, len(tree))
	for p := range tree {
		want[p] = true
	}
	return want
}

// applyTouched fills in the Touched field (unix ms) of every entry in tree
// whose path has a time in times (unix seconds); paths absent from times keep
// Touched 0 ("unknown").
func applyTouched(tree map[string]model.File, times map[string]int64) {
	for p, f := range tree {
		if t, ok := times[p]; ok {
			f.Touched = t * 1000
			tree[p] = f
		}
	}
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
	want := make(map[string]bool, len(changes))
	for _, c := range changes {
		want[c.Path] = true
	}
	times, err := gitx.LogTouched(ctx, r, dir, mb+".."+head, want)
	if err != nil {
		return nil, err
	}
	for _, c := range changes {
		e := model.ChangeEntry{Path: c.Path, Kind: model.Kind(c.Kind), From: c.From, Stage: model.Committed}
		if c.Kind != gitx.Deleted {
			e.Size = sizes[c.Path]
		}
		if t, ok := times[c.Path]; ok {
			e.Touched = t * 1000
		}
		out[c.Path] = e
	}
	return out, nil
}

// uncommittedOverlay is `git status` for the worktree at root, with plain
// moves paired into renames and sizes taken from the working tree, plus the
// HEAD that status compared against. Touched is the file's mtime, except for
// a deleted path, which has no mtime: its Touched is carried forward from
// prev (the worktree's previous uncommitted overlay) if prev already flagged
// it deleted, so the "first observed" time stays stable across recomputes;
// otherwise it is now, the moment the deletion is first seen.
func uncommittedOverlay(ctx context.Context, r gitx.Runner, root string, prev map[string]model.ChangeEntry, now time.Time) (map[string]model.ChangeEntry, string, error) {
	changes, head, err := gitx.StatusWithHead(ctx, r, root)
	if err != nil {
		return nil, "", err
	}
	out := map[string]model.ChangeEntry{}
	for _, c := range gitx.PairMoves(changes) {
		e := model.ChangeEntry{Path: c.Path, Kind: model.Kind(c.Kind), From: c.From, Stage: model.Uncommitted}
		if c.Kind != gitx.Deleted {
			if fi, err := os.Stat(filepath.Join(root, filepath.FromSlash(c.Path))); err == nil {
				e.Size = fi.Size()
				e.Touched = fi.ModTime().UnixMilli()
			}
		} else if p, ok := prev[c.Path]; ok && p.Stage == model.Uncommitted && p.Kind == model.Deleted && p.Touched != 0 {
			e.Touched = p.Touched
		} else {
			e.Touched = now.UnixMilli()
		}
		out[c.Path] = e
	}
	return out, head, nil
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
func buildState(info model.RepoInfo, tree map[string]model.File, wts map[model.WorktreeID]*wtState) model.State {
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
