package testrepo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewRepoIsEmptyOnMain(t *testing.T) {
	r := New(t)
	if !filepath.IsAbs(r.Path()) {
		t.Fatalf("Path() = %q, want absolute", r.Path())
	}
	if got := r.Git("symbolic-ref", "--short", "HEAD"); got != "main" {
		t.Fatalf("HEAD -> %q, want main", got)
	}
	if got := r.Git("config", "commit.gpgsign"); got != "false" {
		t.Fatalf("commit.gpgsign = %q, want false", got)
	}
}

func TestCommitIsDeterministic(t *testing.T) {
	build := func() string {
		r := New(t)
		r.Write("a.txt", "hello\n")
		r.Write("dir/b.txt", "world\n")
		r.Add()
		return r.Commit("initial")
	}
	first, second := build(), build()
	if first != second {
		t.Fatalf("same operations gave different shas: %s vs %s", first, second)
	}
	if len(first) != 40 {
		t.Fatalf("sha %q is not 40 hex chars", first)
	}
}

func TestFileOps(t *testing.T) {
	r := New(t)
	r.Write("a.txt", "1")
	r.Write("b.txt", "2")
	r.Add("a.txt", "b.txt")
	r.Commit("two files")

	r.Move("a.txt", "moved/a.txt")
	if _, err := os.Stat(filepath.Join(r.Path(), "moved", "a.txt")); err != nil {
		t.Fatalf("Move did not create destination: %v", err)
	}
	r.GitMv("b.txt", "c.txt")
	r.Remove("moved/a.txt")
	status := r.Git("status", "--porcelain")
	for _, want := range []string{"R  b.txt -> c.txt", " D a.txt"} {
		if !strings.Contains(status, want) {
			t.Fatalf("status %q missing %q", status, want)
		}
	}
}

func TestBranchCheckoutMerge(t *testing.T) {
	r := New(t)
	r.Write("a.txt", "1")
	r.Add()
	base := r.Commit("base")
	r.Branch("feature")
	r.Checkout("feature")
	r.Write("f.txt", "feature")
	r.Add()
	feat := r.Commit("feature work")
	r.Checkout("main")
	merge := r.Merge("feature")
	if merge == base || merge == feat {
		t.Fatalf("Merge returned %s, want a new merge commit", merge)
	}
	if parents := strings.Fields(r.Git("rev-list", "--parents", "-n1", "HEAD")); len(parents) != 3 {
		t.Fatalf("HEAD is not a merge commit: %v", parents)
	}
}

func TestWorktreesNestedAndOutside(t *testing.T) {
	r := New(t)
	r.Write("a.txt", "1")
	r.Add()
	r.Commit("base")

	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")
	if want := filepath.Join(r.Path(), ".claude", "worktrees", "agent-x"); nested.Path() != want {
		t.Fatalf("nested Path() = %q, want %q", nested.Path(), want)
	}
	outside := r.WorktreeAdd(filepath.Join(t.TempDir(), "wt-out"), "outside")
	if strings.HasPrefix(outside.Path(), r.Path()) {
		t.Fatalf("outside worktree %q is inside the main root", outside.Path())
	}

	nested.Write("n.txt", "nested")
	nested.Add()
	nested.Commit("nested work")
	if got := nested.Git("rev-parse", "--abbrev-ref", "HEAD"); got != "agent-x" {
		t.Fatalf("nested branch = %q", got)
	}

	list := r.Git("worktree", "list", "--porcelain")
	for _, p := range []string{nested.Path(), outside.Path()} {
		if !strings.Contains(list, "worktree "+p) {
			t.Fatalf("worktree list missing %q:\n%s", p, list)
		}
	}

	r.WorktreeRemove(outside.Path())
	if strings.Contains(r.Git("worktree", "list", "--porcelain"), outside.Path()) {
		t.Fatal("WorktreeRemove left the worktree registered")
	}
	// Re-adding an existing branch checks it out instead of creating it.
	again := r.WorktreeAdd(filepath.Join(t.TempDir(), "again"), "outside")
	if got := again.Git("rev-parse", "--abbrev-ref", "HEAD"); got != "outside" {
		t.Fatalf("re-added branch = %q", got)
	}
}
