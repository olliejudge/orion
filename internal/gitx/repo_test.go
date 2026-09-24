package gitx

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/olliejudge/orion/internal/testrepo"
)

var ctx = context.Background()

func TestCommonDirAndMainRootFromEverywhere(t *testing.T) {
	r := testrepo.New(t)
	r.Write("sub/dir/a.txt", "a")
	r.Add()
	r.Commit("base")
	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")
	outside := r.WorktreeAdd(filepath.Join(t.TempDir(), "outside"), "outside")

	for name, dir := range map[string]string{
		"root":    r.Path(),
		"subdir":  filepath.Join(r.Path(), "sub", "dir"),
		"nested":  nested.Path(),
		"outside": outside.Path(),
	} {
		common, err := CommonDir(ctx, Runner{}, dir)
		if err != nil {
			t.Fatalf("%s: CommonDir: %v", name, err)
		}
		if want := filepath.Join(r.Path(), ".git"); common != want {
			t.Errorf("%s: CommonDir = %q, want %q", name, common, want)
		}
		root, err := MainRoot(ctx, Runner{}, dir)
		if err != nil {
			t.Fatalf("%s: MainRoot: %v", name, err)
		}
		if root != r.Path() {
			t.Errorf("%s: MainRoot = %q, want %q", name, root, r.Path())
		}
	}
}

func TestMainRootErrors(t *testing.T) {
	if _, err := MainRoot(ctx, Runner{}, t.TempDir()); err == nil {
		t.Error("MainRoot outside a repo: want error")
	}
	bare := t.TempDir()
	if _, err := (Runner{}).Run(ctx, bare, "init", "--bare", "--quiet"); err != nil {
		t.Fatal(err)
	}
	if _, err := MainRoot(ctx, Runner{}, bare); err == nil {
		t.Error("MainRoot in a bare repo: want error")
	}
}

func TestRevParseMergeBaseSubject(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	base := r.Commit("base commit")
	r.Branch("feature")
	r.Checkout("feature")
	r.Write("b.txt", "b")
	r.Add()
	feat := r.Commit("feature: add b")
	r.Checkout("main")
	r.Write("c.txt", "c")
	r.Add()
	r.Commit("main moves on")

	got, err := RevParse(ctx, Runner{}, r.Path(), "feature")
	if err != nil || got != feat {
		t.Fatalf("RevParse(feature) = %q, %v; want %q", got, err, feat)
	}
	if _, err := RevParse(ctx, Runner{}, r.Path(), "no-such-branch"); err == nil {
		t.Error("RevParse(missing) should fail")
	}
	if _, err := RevParse(ctx, Runner{}, r.Path(), "--all"); err == nil {
		t.Error("RevParse must refuse revs that look like options")
	}

	mb, err := MergeBase(ctx, Runner{}, r.Path(), "main", "feature")
	if err != nil || mb != base {
		t.Fatalf("MergeBase = %q, %v; want %q", mb, err, base)
	}

	r.Git("checkout", "--quiet", "--orphan", "island")
	r.Git("rm", "-r", "--quiet", "--cached", ".")
	r.Write("island.txt", "i")
	r.Add("island.txt")
	r.Commit("unrelated root")
	mb, err = MergeBase(ctx, Runner{}, r.Path(), "main", "island")
	if err != nil || mb != "" {
		t.Fatalf("MergeBase of unrelated histories = %q, %v; want \"\", nil", mb, err)
	}

	subj, err := CommitSubject(ctx, Runner{}, r.Path(), feat)
	if err != nil || subj != "feature: add b" {
		t.Fatalf("CommitSubject = %q, %v", subj, err)
	}
}

func TestResolveBase(t *testing.T) {
	commit := func(r *testrepo.Repo, name string) string {
		r.Write(name, name)
		r.Add()
		return r.Commit("add " + name)
	}

	t.Run("unborn repo", func(t *testing.T) {
		r := testrepo.New(t)
		ref, sha, err := ResolveBase(ctx, Runner{}, r.Path(), "")
		if err != nil || ref != "" || sha != "" {
			t.Fatalf("got %q %q %v, want empty and nil", ref, sha, err)
		}
	})

	t.Run("local main", func(t *testing.T) {
		r := testrepo.New(t)
		sha := commit(r, "a")
		r.Branch("other")
		r.Checkout("other")
		commit(r, "b")
		assertBase(t, r.Path(), "", "main", sha)
	})

	t.Run("master when no main", func(t *testing.T) {
		r := testrepo.New(t)
		sha := commit(r, "a")
		r.Git("branch", "-m", "master")
		assertBase(t, r.Path(), "", "master", sha)
	})

	t.Run("current branch of main worktree", func(t *testing.T) {
		r := testrepo.New(t)
		commit(r, "a")
		r.Git("branch", "-m", "trunk")
		sha := commit(r, "b")
		wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "wt"), "side")
		commit(wt, "c")
		// Asked from the linked worktree, the answer is still the MAIN worktree's branch.
		assertBase(t, wt.Path(), "", "trunk", sha)
	})

	t.Run("detached main worktree", func(t *testing.T) {
		r := testrepo.New(t)
		sha := commit(r, "a")
		r.Git("checkout", "--quiet", "--detach")
		r.Git("branch", "-D", "--quiet", "main")
		assertBase(t, r.Path(), "", sha[:7], sha)
	})

	t.Run("origin HEAD wins over local main", func(t *testing.T) {
		remote := testrepo.New(t)
		remoteSha := commit(remote, "remote.txt")
		r := testrepo.New(t)
		commit(r, "local.txt")
		r.Git("remote", "add", "origin", remote.Path())
		r.Git("fetch", "--quiet", "origin")
		r.Git("remote", "set-head", "origin", "main")
		assertBase(t, r.Path(), "", "origin/main", remoteSha)
	})

	t.Run("override wins", func(t *testing.T) {
		r := testrepo.New(t)
		commit(r, "a")
		r.Branch("release")
		r.Checkout("release")
		sha := commit(r, "b")
		assertBase(t, r.Path(), "release", "release", sha)
		if _, _, err := ResolveBase(ctx, Runner{}, r.Path(), "nope"); err == nil {
			t.Fatal("unknown override: want error")
		}
	})
}

func assertBase(t *testing.T, dir, override, wantRef, wantSha string) {
	t.Helper()
	ref, sha, err := ResolveBase(ctx, Runner{}, dir, override)
	if err != nil {
		t.Fatalf("ResolveBase: %v", err)
	}
	if ref != wantRef || sha != wantSha {
		t.Fatalf("ResolveBase = %q %q, want %q %q", ref, sha, wantRef, wantSha)
	}
}

func TestWorktreeAdminDir(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	r.Commit("base")
	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")

	got, err := WorktreeAdminDir(r.Path())
	if err != nil || got != filepath.Join(r.Path(), ".git") {
		t.Fatalf("main admin dir = %q, %v", got, err)
	}
	got, err = WorktreeAdminDir(nested.Path())
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(r.Path(), ".git", "worktrees", "agent-x"); got != want {
		t.Fatalf("linked admin dir = %q, want %q", got, want)
	}
	if _, err := os.Stat(filepath.Join(got, "HEAD")); err != nil {
		t.Fatalf("admin dir has no HEAD: %v", err)
	}
	if _, err := WorktreeAdminDir(t.TempDir()); err == nil {
		t.Fatal("WorktreeAdminDir of a non-worktree: want error")
	}
}

// assertMainWorktree checks that MainRoot and the first ListWorktrees entry
// both name want (the working tree), asked from dir.
func assertMainWorktree(t *testing.T, dir, want string) {
	t.Helper()
	root, err := MainRoot(ctx, Runner{}, dir)
	if err != nil || root != want {
		t.Errorf("MainRoot(%s) = %q, %v; want %q", dir, root, err, want)
	}
	wts, err := ListWorktrees(ctx, Runner{}, dir)
	if err != nil {
		t.Fatalf("ListWorktrees(%s): %v", dir, err)
	}
	if len(wts) == 0 || !wts[0].IsMain || wts[0].Path != want || wts[0].Prunable {
		t.Errorf("ListWorktrees(%s)[0] = %+v, want main worktree at %q", dir, wts, want)
	}
}

func TestMainWorktreeOfSubmodule(t *testing.T) {
	lib := testrepo.New(t)
	lib.Write("pkg/lib.txt", "lib")
	lib.Add()
	lib.Commit("lib")
	super := testrepo.New(t)
	super.Write("app.txt", "app")
	super.Add()
	super.Commit("app")
	super.Git("-c", "protocol.file.allow=always", "submodule", "add", "--quiet", lib.Path(), "sm")
	sm := filepath.Join(super.Path(), "sm")

	assertMainWorktree(t, sm, sm)
	assertMainWorktree(t, filepath.Join(sm, "pkg"), sm)

	// A linked worktree of the submodule still finds the submodule's working tree.
	linked := filepath.Join(t.TempDir(), "sm-linked")
	if _, err := (Runner{}).Run(ctx, sm, "worktree", "add", "--quiet", "-b", "side", linked); err != nil {
		t.Fatal(err)
	}
	linked, _ = filepath.EvalSymlinks(linked)
	assertMainWorktree(t, linked, sm)
}

func TestMainWorktreeOfSeparateGitDir(t *testing.T) {
	r := testrepo.New(t)
	r.Write("sub/a.txt", "a")
	r.Add()
	r.Commit("base")
	sep := filepath.Join(t.TempDir(), "sep.git")
	// Re-running init with --separate-git-dir moves .git to sep and leaves a gitfile.
	r.Git("init", "--quiet", "--separate-git-dir", sep)

	assertMainWorktree(t, r.Path(), r.Path())
	assertMainWorktree(t, filepath.Join(r.Path(), "sub"), r.Path())

	// From a linked worktree nothing points back at the main working tree,
	// so MainRoot must fail rather than return the git dir.
	linked := r.WorktreeAdd(filepath.Join(t.TempDir(), "linked"), "linked")
	if root, err := MainRoot(ctx, Runner{}, linked.Path()); err == nil {
		t.Errorf("MainRoot from a linked worktree of a separate-git-dir repo = %q, want error", root)
	}
	if wts, err := ListWorktrees(ctx, Runner{}, linked.Path()); err == nil {
		t.Errorf("ListWorktrees from a linked worktree of a separate-git-dir repo = %+v, want error", wts)
	}
}
