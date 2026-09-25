package repo

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
	"github.com/olliejudge/orion/internal/testrepo"
)

// TestMain silences the engine's log output: tests provoke git failures and
// base fallbacks on purpose, and assert on the resulting state instead.
func TestMain(m *testing.M) {
	log.SetOutput(io.Discard)
	os.Exit(m.Run())
}

// initRepo returns a repo with one commit (testrepo starts on branch main).
func initRepo(t *testing.T, files map[string]string) *testrepo.Repo {
	t.Helper()
	r := testrepo.New(t)
	var paths []string
	for p, c := range files {
		r.Write(p, c)
		paths = append(paths, p)
	}
	r.Add(paths...)
	r.Commit("init")
	return r
}

func wtID(p string) model.WorktreeID { return model.IDFor(canon(p)) }

// commitTimeMs returns sha's committer time in unix ms, straight from git.
func commitTimeMs(t *testing.T, r *testrepo.Repo, sha string) int64 {
	t.Helper()
	out := r.Git("log", "-1", "--format=%ct", sha)
	n, err := strconv.ParseInt(out, 10, 64)
	if err != nil {
		t.Fatalf("parse committer time %q: %v", out, err)
	}
	return n * 1000
}

func openState(t *testing.T, path, base string) model.State {
	t.Helper()
	e, err := Open(context.Background(), path, base, gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	return e.store.State()
}

func TestOpenBuildsBaseTreeAndOverlays(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n", "old.txt": "old\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	wt.Write("lib.go", "package lib\n")
	wt.Write("README.md", "# demo v2\n")
	wt.Remove("old.txt")
	wt.Add("lib.go", "README.md", "old.txt")
	featureSha := wt.Commit("feature work")
	wt.Write("README.md", "# demo v3, uncommitted\n") // uncommitted overrides committed
	wt.Write("new.txt", "brand new\n")

	st := openState(t, r.Path(), "")

	if len(st.Tree) != 2 || st.Tree["README.md"].Size != 7 || st.Tree["old.txt"].Size != 4 {
		t.Fatalf("Tree = %v", st.Tree)
	}
	if st.Tree["README.md"].Touched == 0 || st.Tree["old.txt"].Touched == 0 {
		t.Fatalf("Tree = %+v, want non-zero Touched on every base file", st.Tree)
	}
	id := wtID(wt.Path())
	want := map[string]model.ChangeEntry{
		"lib.go":    {Path: "lib.go", Kind: model.Added, Stage: model.Committed, Size: 12},
		"old.txt":   {Path: "old.txt", Kind: model.Deleted, Stage: model.Committed, Size: 0},
		"README.md": {Path: "README.md", Kind: model.Modified, Stage: model.Uncommitted, Size: 23},
		"new.txt":   {Path: "new.txt", Kind: model.Added, Stage: model.Uncommitted, Size: 10},
	}
	got := st.Overlays[id]
	if len(got) != len(want) {
		t.Fatalf("overlay = %+v, want %+v", got, want)
	}
	for p, w := range want {
		g := got[p]
		touched := g.Touched
		g.Touched = 0
		if g != w {
			t.Errorf("overlay[%q] = %+v, want %+v", p, got[p], w)
		}
		if touched == 0 {
			t.Errorf("overlay[%q].Touched = 0, want non-zero", p)
		}
	}
	// The committed entries' Touched is the feature commit's committer time;
	// the uncommitted ones' is the working-tree mtime, which is not that sha's.
	featureMs := commitTimeMs(t, wt, featureSha)
	if got["lib.go"].Touched != featureMs || got["old.txt"].Touched != featureMs {
		t.Errorf("committed Touched = %d/%d, want the feature commit's time %d",
			got["lib.go"].Touched, got["old.txt"].Touched, featureMs)
	}
	if len(st.Overlays[wtID(r.Path())]) != 0 {
		t.Errorf("main overlay = %v, want empty", st.Overlays[wtID(r.Path())])
	}
	if len(st.Worktrees) != 2 || !st.Worktrees[0].IsMain || st.Worktrees[0].Label != "main" {
		t.Fatalf("Worktrees = %+v, want main first", st.Worktrees)
	}
	if w := st.Worktrees[1]; w.ID != id || w.Label != "feature" || w.Branch != "feature" || w.HeadSubject != "feature work" {
		t.Errorf("feature worktree = %+v", w)
	}
	if st.Repo.Name != filepath.Base(canon(r.Path())) || st.Repo.BaseSha == "" {
		t.Errorf("Repo = %+v", st.Repo)
	}
}

// A base file's Touched is the latest commit that touched it, not simply the
// tip's commit time: a.txt is touched again after b.txt, so a.txt ends up
// newer even though b.txt's own commit is more recent than a.txt's first one.
func TestOpenBaseFileTouchedIsLatestCommit(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "v1")
	r.Add()
	r.Commit("c1")
	r.Write("b.txt", "v1")
	r.Add()
	c2 := r.Commit("c2")
	r.Write("a.txt", "v2")
	r.Add()
	c3 := r.Commit("c3")

	st := openState(t, r.Path(), "")
	wantA, wantB := commitTimeMs(t, r, c3), commitTimeMs(t, r, c2)
	if st.Tree["a.txt"].Touched != wantA {
		t.Errorf("a.txt touched = %d, want %d (c3)", st.Tree["a.txt"].Touched, wantA)
	}
	if st.Tree["b.txt"].Touched != wantB {
		t.Errorf("b.txt touched = %d, want %d (c2)", st.Tree["b.txt"].Touched, wantB)
	}
}

func TestOpenEmptyRepo(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "abc")
	st := openState(t, r.Path(), "")
	if len(st.Tree) != 0 || st.Repo.BaseSha != "" {
		t.Fatalf("Tree = %v, BaseSha = %q; want empty", st.Tree, st.Repo.BaseSha)
	}
	e := st.Overlays[wtID(r.Path())]["a.txt"]
	touched := e.Touched
	e.Touched = 0
	if e != (model.ChangeEntry{Path: "a.txt", Kind: model.Added, Stage: model.Uncommitted, Size: 3}) || touched == 0 {
		t.Fatalf("a.txt entry = %+v (touched %d)", e, touched)
	}
}

func TestOpenDetachedWorktreeLabel(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	dir := filepath.Join(t.TempDir(), "detached")
	r.Git("worktree", "add", "--detach", dir)
	head := r.Git("rev-parse", "HEAD")
	st := openState(t, r.Path(), "")
	for _, w := range st.Worktrees {
		if w.ID == wtID(dir) {
			if w.Label != head[:7] || w.Branch != "" {
				t.Fatalf("detached worktree = %+v, want label %q", w, head[:7])
			}
			return
		}
	}
	t.Fatalf("detached worktree missing from %+v", st.Worktrees)
}

func TestOpenSkipsPrunableWorktree(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "gone"), "gone")
	if err := os.RemoveAll(wt.Path()); err != nil {
		t.Fatal(err)
	}
	st := openState(t, r.Path(), "")
	if len(st.Worktrees) != 1 || !st.Worktrees[0].IsMain {
		t.Fatalf("Worktrees = %+v, want only main", st.Worktrees)
	}
}

func TestOpenUnknownBaseFallsBack(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	r.Branch("work")
	r.Checkout("work")
	r.Write("b.txt", "b")
	r.Add("b.txt")
	head := r.Commit("work")
	st := openState(t, r.Path(), "no-such-branch")
	// spec §8: fall back to the main worktree's HEAD (not the default order, which would pick main)
	if st.Repo.BaseSha != head || st.Repo.Base != "work" {
		t.Fatalf("Repo = %+v, want base work at %s", st.Repo, head)
	}
}

func TestOpenNotARepo(t *testing.T) {
	if _, err := Open(context.Background(), t.TempDir(), "", gitx.Runner{}); err == nil {
		t.Fatal("Open outside a repo: want error")
	}
}

func TestEngineDropsSlowSubscriber(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	e, err := Open(context.Background(), r.Path(), "", gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	ch, unsub := e.Subscribe()
	defer unsub()
	for i := 0; i < subBuffer+10; i++ {
		st := e.state()
		tree := map[string]model.File{"a.txt": {Path: "a.txt", Size: 1}}
		p := fmt.Sprintf("gen/%d", i)
		tree[p] = model.File{Path: p, Size: int64(i)}
		st.Tree = tree
		e.publish(st)
	}
	n := 0
	for range ch { // must terminate: the engine closed the channel
		n++
	}
	if n != subBuffer {
		t.Fatalf("received %d patches before the drop, want %d", n, subBuffer)
	}
	unsub() // safe after a drop
}

func TestOpenUnrelatedHistoryHasNoCommittedOverlay(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "lonely"), "lonely")
	wt.Git("checkout", "--quiet", "--orphan", "orphan")
	wt.Git("rm", "-rf", "--quiet", ".")
	wt.Write("b.txt", "b")
	wt.Add("b.txt")
	wt.Commit("orphan root")
	st := openState(t, r.Path(), "")
	if got := st.Overlays[wtID(wt.Path())]; len(got) != 0 {
		t.Fatalf("orphan worktree overlay = %+v, want empty", got)
	}
}

func TestEngineUnsubscribeTwice(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	e, err := Open(context.Background(), r.Path(), "", gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	ch, unsub := e.Subscribe()
	unsub()
	unsub() // must not close the channel twice
	if _, open := <-ch; open {
		t.Fatal("channel still open after unsubscribe")
	}
	st := e.state()
	st.Tree = map[string]model.File{"a.txt": {Path: "a.txt", Size: 1}, "b.txt": {Path: "b.txt", Size: 2}}
	e.publish(st) // must not send on the closed channel
}
