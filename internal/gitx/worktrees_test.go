package gitx

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/olliejudge/orion/internal/testrepo"
)

func TestListWorktrees(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	head := r.Commit("base")
	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")
	outside := r.WorktreeAdd(filepath.Join(t.TempDir(), "outside"), "feature/outside")
	detachedPath := filepath.Join(t.TempDir(), "detached")
	r.Git("worktree", "add", "--quiet", "--detach", detachedPath)
	detachedPath, _ = filepath.EvalSymlinks(detachedPath)

	// Ask from inside a linked worktree: the list is the same.
	wts, err := ListWorktrees(ctx, Runner{}, nested.Path())
	if err != nil {
		t.Fatal(err)
	}
	want := []Worktree{
		{Path: r.Path(), Head: head, Branch: "main", IsMain: true},
		{Path: nested.Path(), Head: head, Branch: "agent-x"},
		{Path: outside.Path(), Head: head, Branch: "feature/outside"},
		{Path: detachedPath, Head: head, Detached: true},
	}
	if len(wts) != len(want) {
		t.Fatalf("got %d worktrees, want %d: %+v", len(wts), len(want), wts)
	}
	byPath := map[string]Worktree{}
	for _, w := range wts {
		byPath[w.Path] = w
	}
	if wts[0] != want[0] {
		t.Errorf("first entry = %+v, want main %+v", wts[0], want[0])
	}
	for _, w := range want[1:] {
		if got := byPath[w.Path]; got != w {
			t.Errorf("worktree %s = %+v, want %+v", w.Path, got, w)
		}
	}
}

func TestListWorktreesPrunable(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	r.Commit("base")
	gone := r.WorktreeAdd(filepath.Join(t.TempDir(), "gone"), "gone")
	locked := r.WorktreeAdd(filepath.Join(t.TempDir(), "locked"), "locked")
	r.Git("worktree", "lock", "--reason", "agent busy", locked.Path())
	if err := os.RemoveAll(gone.Path()); err != nil {
		t.Fatal(err)
	}

	wts, err := ListWorktrees(ctx, Runner{}, r.Path())
	if err != nil {
		t.Fatalf("ListWorktrees with a missing worktree dir: %v", err)
	}
	var sawGone, sawLocked bool
	for _, w := range wts {
		switch w.Path {
		case gone.Path():
			sawGone = true
			if !w.Prunable {
				t.Errorf("missing worktree not marked prunable: %+v", w)
			}
		case locked.Path():
			sawLocked = true
			if !w.Locked || w.Prunable {
				t.Errorf("locked worktree = %+v, want Locked and not Prunable", w)
			}
		}
	}
	if !sawGone || !sawLocked {
		t.Fatalf("missing entries in %+v", wts)
	}
}

func TestListWorktreesUnborn(t *testing.T) {
	r := testrepo.New(t)
	wts, err := ListWorktrees(ctx, Runner{}, r.Path())
	if err != nil {
		t.Fatal(err)
	}
	if len(wts) != 1 || wts[0].Head != "" || wts[0].Branch != "main" || !wts[0].IsMain {
		t.Fatalf("unborn repo worktrees = %+v", wts)
	}
}

func TestParseWorktreesBothSeparators(t *testing.T) {
	const zero = "0000000000000000000000000000000000000000"
	const sha = "1111111111111111111111111111111111111111"
	lines := []string{
		"worktree /repo", "HEAD " + sha, "branch refs/heads/main", "",
		"worktree /repo/.claude/worktrees/a b", "HEAD " + sha, "detached", "locked", "",
		"worktree /elsewhere/new", "HEAD " + zero, "branch refs/heads/new", "locked because\\nreasons", "prunable gitdir file points to non-existent location", "",
	}
	for _, sep := range []byte{0, '\n'} {
		var buf []byte
		for _, l := range lines {
			buf = append(buf, l...)
			buf = append(buf, sep)
		}
		got, bare := parseWorktrees(buf, sep)
		if bare {
			t.Fatalf("sep %q: reported bare", sep)
		}
		want := []Worktree{
			{Path: "/repo", Head: sha, Branch: "main", IsMain: true},
			{Path: "/repo/.claude/worktrees/a b", Head: sha, Detached: true, Locked: true},
			{Path: "/elsewhere/new", Branch: "new", Locked: true, Prunable: true},
		}
		if len(got) != len(want) {
			t.Fatalf("sep %q: got %+v", sep, got)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("sep %q entry %d = %+v, want %+v", sep, i, got[i], want[i])
			}
		}
	}
	got, bare := parseWorktrees([]byte("worktree /x.git\x00bare\x00\x00"), 0)
	if !bare || len(got) != 0 {
		t.Fatalf("bare repo parse = %+v bare=%v", got, bare)
	}
}
