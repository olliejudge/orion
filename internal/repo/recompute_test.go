package repo

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
)

// openEngine opens path and subscribes; Run is NOT started, so tests drive
// recomputes deterministically by calling e.fire.
func openEngine(t *testing.T, path string) (*Engine, <-chan model.Patch) {
	t.Helper()
	e, err := Open(context.Background(), path, "", gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	ch, unsub := e.Subscribe()
	t.Cleanup(unsub)
	return e, ch
}

// nextPatch returns the patch published by the fire that just ran.
func nextPatch(t *testing.T, ch <-chan model.Patch) model.Patch {
	t.Helper()
	select {
	case p := <-ch:
		return p
	case <-time.After(time.Second):
		t.Fatal("no patch published")
		return model.Patch{}
	}
}

func noPatch(t *testing.T, ch <-chan model.Patch) {
	t.Helper()
	select {
	case p := <-ch:
		t.Fatalf("unexpected patch %+v", p)
	default:
	}
}

func findUpsert(p model.Patch, id model.WorktreeID, path string) (model.ChangeEntry, bool) {
	for _, c := range p.Overlays[id].Upsert {
		if c.Path == path {
			return c, true
		}
	}
	return model.ChangeEntry{}, false
}

func hasActivity(p model.Patch, kind string, id model.WorktreeID) bool {
	for _, a := range p.Activity {
		if a.Kind == kind && a.Worktree == id {
			return true
		}
	}
	return false
}

func TestFireFilesRecomputesStatus(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, ch := openEngine(t, r.Path())
	id := wtID(r.Path())

	e.fire(context.Background(), string(id), ReasonFiles)
	noPatch(t, ch) // nothing changed

	r.Write("notes.md", "hi\n")
	e.fire(context.Background(), string(id), ReasonFiles)
	c, ok := findUpsert(nextPatch(t, ch), id, "notes.md")
	if !ok || c.Stage != model.Uncommitted || c.Kind != model.Added || c.Size != 3 {
		t.Fatalf("notes.md = %+v (found %v)", c, ok)
	}
}

func TestFireRefMakesCommitAtomic(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	wt.Write("feature.txt", "hello\n")
	e, ch := openEngine(t, r.Path())
	id := wtID(wt.Path())

	wt.Add("feature.txt")
	sha := wt.Commit("add feature")
	e.fire(context.Background(), string(id), ReasonRef)
	p := nextPatch(t, ch)
	if c, ok := findUpsert(p, id, "feature.txt"); !ok || c.Stage != model.Committed {
		t.Fatalf("feature.txt = %+v (found %v), want committed in the same patch", c, ok)
	}
	if !hasActivity(p, "commit", id) {
		t.Fatalf("activity = %+v, want a commit item", p.Activity)
	}
	for _, w := range p.Worktrees {
		if w.ID == id && w.Head != sha {
			t.Errorf("head = %s, want %s", w.Head, sha)
		}
	}
}

func TestFireRefsBaseMovedMerges(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	wt.Write("feature.txt", "hello\n")
	wt.Add("feature.txt")
	wt.Commit("add feature")
	e, ch := openEngine(t, r.Path())
	id := wtID(wt.Path())

	r.Merge("feature")
	e.fire(context.Background(), keyRefs, ReasonRefs)
	p := nextPatch(t, ch)
	if p.Base == nil || len(p.Base.Upsert) != 1 || p.Base.Upsert[0].Path != "feature.txt" {
		t.Fatalf("base patch = %+v, want feature.txt upserted", p.Base)
	}
	if rm := p.Overlays[id].Remove; len(rm) != 1 || rm[0] != "feature.txt" {
		t.Fatalf("overlay remove = %v, want [feature.txt]", rm)
	}
	if !hasActivity(p, "merge", id) {
		t.Fatalf("activity = %+v, want a merge item", p.Activity)
	}
	if n := len(e.Snapshot().Overlays[wtID(r.Path())]); n != 0 {
		t.Errorf("main overlay has %d entries after a merge into base, want 0", n)
	}
}

func TestFireWorktreesAddedAndRemoved(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, ch := openEngine(t, r.Path())

	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "agent"), "agent")
	wt.Write("a.txt", "a")
	e.fire(context.Background(), keyWorktrees, ReasonWorktrees)
	p := nextPatch(t, ch)
	id := wtID(wt.Path())
	if len(p.Worktrees) != 2 || p.Worktrees[1].ID != id || p.Worktrees[1].Label != "agent" {
		t.Fatalf("worktrees = %+v, want main + agent", p.Worktrees)
	}
	if _, ok := findUpsert(p, id, "a.txt"); !ok {
		t.Fatalf("new worktree's overlay not published: %+v", p.Overlays)
	}
	if got := e.router.Load().Route(filepath.Join(canon(wt.Path()), "a.txt")); got != (Route{FileEvent, id}) {
		t.Fatalf("router not rebuilt: %+v", got)
	}

	r.WorktreeRemove(wt.Path())
	e.fire(context.Background(), keyWorktrees, ReasonWorktrees)
	p = nextPatch(t, ch)
	if len(p.Worktrees) != 1 || !p.Worktrees[0].IsMain {
		t.Fatalf("worktrees = %+v, want only main", p.Worktrees)
	}
	if rm := p.Overlays[id].Remove; len(rm) != 1 || rm[0] != "a.txt" {
		t.Fatalf("overlay remove = %v, want [a.txt]", rm)
	}
}

func TestFireKeepsLastGoodStateWhenGitFails(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, ch := openEngine(t, r.Path())
	before := e.Snapshot()
	e.r = gitx.Runner{Git: filepath.Join(t.TempDir(), "no-such-git")}
	r.Write("x.txt", "x")
	for _, key := range []string{string(wtID(r.Path())), keyRefs, keyWorktrees} {
		e.fire(context.Background(), key, ReasonFiles|ReasonRef|ReasonRefs|ReasonWorktrees)
	}
	noPatch(t, ch)
	if after := e.Snapshot(); after.Seq != before.Seq {
		t.Fatalf("seq moved from %d to %d on git failure", before.Seq, after.Seq)
	}
}
