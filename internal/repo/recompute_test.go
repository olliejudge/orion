package repo

import (
	"context"
	"os"
	"os/exec"
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

// failingGit returns a git wrapper that exits 2 whenever an argument equals
// arg, and runs the real git otherwise.
func failingGit(t *testing.T, arg string) string {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "git")
	script := "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = " + arg + " ] && exit 2; done\nexec '" + real + "' \"$@\"\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestFireRepairsCommittedOverlayAfterGitFailure(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	wt.Write("feature.txt", "hello\n")
	wt.Add("feature.txt")
	wt.Commit("add feature")
	e, ch := openEngine(t, r.Path())
	id := wtID(wt.Path())

	r.Merge("feature")
	e.r = gitx.Runner{Git: failingGit(t, "merge-base")} // the committed-overlay step fails
	e.fire(context.Background(), keyRefs, ReasonRefs)
	if p := nextPatch(t, ch); p.Base == nil {
		t.Fatalf("patch = %+v, want the new base tree", p)
	}
	if n := len(e.Snapshot().Overlays[id]); n != 1 {
		t.Fatalf("feature overlay has %d entries, want the last good one kept", n)
	}

	e.r = gitx.Runner{}
	e.fire(context.Background(), string(wtID(r.Path())), ReasonFiles) // an unrelated event
	p := nextPatch(t, ch)
	if rm := p.Overlays[id].Remove; len(rm) != 1 || rm[0] != "feature.txt" {
		t.Fatalf("overlay remove = %v, want [feature.txt] once git works again", rm)
	}
}

func TestFireSeesWorktreesWhenBaseStopsResolving(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	r.Git("branch", "-m", "trunk") // no main or master: base is the main worktree's branch
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	e, ch := openEngine(t, r.Path())
	if b := e.Snapshot().Repo.Base; b != "trunk" {
		t.Fatalf("base = %q, want trunk", b)
	}
	id := wtID(wt.Path())

	r.Git("checkout", "--quiet", "--orphan", "scratch") // main HEAD is unborn: base no longer resolves
	wt.Write("f.txt", "f")
	e.fire(context.Background(), string(id), ReasonFiles|ReasonRef)
	if c, ok := findUpsert(nextPatch(t, ch), id, "f.txt"); !ok || c.Stage != model.Uncommitted {
		t.Fatalf("f.txt = %+v (found %v), want uncommitted", c, ok)
	}

	wt.Add("f.txt")
	sha := wt.Commit("add f")
	e.fire(context.Background(), string(id), ReasonRef)
	p := nextPatch(t, ch)
	if c, ok := findUpsert(p, id, "f.txt"); !ok || c.Stage != model.Committed {
		t.Fatalf("f.txt = %+v (found %v), want committed", c, ok)
	}
	for _, w := range e.Snapshot().Worktrees {
		if w.ID == id && w.Head != sha {
			t.Errorf("head = %s, want %s", w.Head, sha)
		}
	}
}

func TestFireRoutesWorktreeOnceItsGitFileAppears(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "late"), "late")
	// Like `git worktree add` mid-way: the entry is locked and <wt>/.git is not written yet.
	r.Git("worktree", "lock", wt.Path())
	dotgit := filepath.Join(wt.Path(), ".git")
	if err := os.Rename(dotgit, dotgit+".hidden"); err != nil {
		t.Fatal(err)
	}
	e, _ := openEngine(t, r.Path())
	id := wtID(wt.Path())
	if len(e.Snapshot().Worktrees) != 2 {
		t.Fatalf("worktrees = %+v, want main + late", e.Snapshot().Worktrees)
	}
	head := filepath.Join(canon(r.Path()), ".git", "worktrees", "late", "HEAD")
	want := Route{WorktreeRefEvent, id}
	if got := e.router.Load().Route(head); got == want {
		t.Fatalf("route = %+v before .git exists, want no ref routing", got)
	}

	if err := os.Rename(dotgit+".hidden", dotgit); err != nil {
		t.Fatal(err)
	}
	e.fire(context.Background(), keyWorktrees, ReasonWorktrees)
	if got := e.router.Load().Route(head); got != want {
		t.Fatalf("route = %+v, want %+v once .git exists", got, want)
	}
}

// A failed status must be retried by the next fire of any key, not only by
// the next event on that worktree (spec §8).
func TestFireRetriesFailedStatusOnAnyFire(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, ch := openEngine(t, r.Path())
	id := wtID(r.Path())

	r.Write("late.txt", "l\n")
	e.r = gitx.Runner{Git: failingGit(t, "status")}
	e.fire(context.Background(), string(id), ReasonFiles)
	noPatch(t, ch)

	e.r = gitx.Runner{}
	e.fire(context.Background(), keyWorktrees, ReasonWorktrees) // an unrelated fire
	if c, ok := findUpsert(nextPatch(t, ch), id, "late.txt"); !ok || c.Stage != model.Uncommitted {
		t.Fatalf("late.txt = %+v (found %v), want uncommitted once git works again", c, ok)
	}
}

// A commit can land between a worktree's last HEAD read and a files-only
// status: status no longer lists the committed files, and publishing that
// against the old HEAD would briefly drop them. The same fire must pick up
// the new HEAD and move them to committed in one patch.
func TestFireFilesSeesHeadMovedByStatus(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	wt.Write("f.txt", "f\n")
	e, ch := openEngine(t, r.Path())
	id := wtID(wt.Path())
	if c, ok := snapEntry(e, id, "f.txt"); !ok || c.Stage != model.Uncommitted {
		t.Fatalf("f.txt = %+v (found %v), want uncommitted", c, ok)
	}

	wt.Add("f.txt")
	sha := wt.Commit("add f") // no ref event reaches the engine
	e.fire(context.Background(), string(id), ReasonFiles)
	p := nextPatch(t, ch)
	if c, ok := findUpsert(p, id, "f.txt"); !ok || c.Stage != model.Committed {
		t.Fatalf("f.txt = %+v (found %v), want committed in the same patch", c, ok)
	}
	if rm := p.Overlays[id].Remove; len(rm) != 0 {
		t.Fatalf("overlay remove = %v, want none", rm)
	}
	for _, w := range e.Snapshot().Worktrees {
		if w.ID == id && (w.Head != sha || w.HeadSubject != "add f") {
			t.Fatalf("worktree = %+v, want head %s with its subject", w, sha)
		}
	}
	noPatch(t, ch)
}
