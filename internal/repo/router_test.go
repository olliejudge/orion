package repo

import (
	"path/filepath"
	"testing"

	"github.com/olliejudge/orion/internal/model"
)

// Synthetic layout used by every router test:
//
//	/r                          main worktree root (ID "main")
//	/r/.git                     common dir (and main's admin dir)
//	/r/.claude/worktrees/agent  nested linked worktree (ID "nested"), admin /r/.git/worktrees/agent
//	/r2                         sibling linked worktree (ID "sib"), admin /r/.git/worktrees/r2
func testRouter() *Router {
	return NewRouter("/r/.git", []RouteTarget{
		{ID: "main", Root: "/r", AdminDir: "/r/.git"},
		{ID: "nested", Root: "/r/.claude/worktrees/agent", AdminDir: "/r/.git/worktrees/agent"},
		{ID: "sib", Root: "/r2", AdminDir: "/r/.git/worktrees/r2"},
	})
}

func TestRouterNestedWorktree(t *testing.T) {
	r := testRouter()
	cases := []struct {
		path string
		want Route
	}{
		{"/r/.claude/worktrees/agent/src/x.go", Route{FileEvent, "nested"}},
		{"/r/.claude/worktrees/agent", Route{FileEvent, "nested"}},
		{"/r/.claude/worktrees/agent/.git", Route{Ignore, ""}},
		{"/r/.claude/worktrees/agentx/y.go", Route{FileEvent, "main"}}, // not a separator boundary
		{"/r/.claude/worktrees/other.txt", Route{FileEvent, "main"}},
		{"/r/.claude/notes.md", Route{FileEvent, "main"}},
	}
	for _, c := range cases {
		if got := r.Route(filepath.FromSlash(c.path)); got != c.want {
			t.Errorf("Route(%q) = %+v, want %+v", c.path, got, c.want)
		}
	}
}

func TestRouterGitDir(t *testing.T) {
	r := testRouter()
	cases := []struct {
		path string
		want Route
	}{
		// main worktree's own state files
		{"/r/.git/HEAD", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/index", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/ORIG_HEAD", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/MERGE_HEAD", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/rebase-merge/done", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/index.lock", Route{Ignore, ""}},
		// refs
		{"/r/.git/refs/heads/feature", Route{RefsEvent, ""}},
		{"/r/.git/refs/remotes/origin/main", Route{RefsEvent, ""}},
		{"/r/.git/refs", Route{RefsEvent, ""}},
		{"/r/.git/packed-refs", Route{RefsEvent, ""}},
		// linked worktree admin dirs
		{"/r/.git/worktrees/agent/HEAD", Route{WorktreeRefEvent, "nested"}},
		{"/r/.git/worktrees/agent/index", Route{WorktreeRefEvent, "nested"}},
		{"/r/.git/worktrees/agent/REBASE_HEAD", Route{WorktreeRefEvent, "nested"}},
		{"/r/.git/worktrees/agent/rebase-apply/0001", Route{WorktreeRefEvent, "nested"}},
		{"/r/.git/worktrees/r2/HEAD", Route{WorktreeRefEvent, "sib"}},
		{"/r/.git/worktrees/r2/logs/HEAD", Route{Ignore, ""}},
		{"/r/.git/worktrees/r2/index.lock", Route{Ignore, ""}},
		{"/r/.git/worktrees/r2/locked", Route{WorktreesChanged, ""}},
		{"/r/.git/worktrees/r2/gitdir", Route{WorktreesChanged, ""}}, // `git worktree move`
		// worktree set changes
		{"/r/.git/worktrees", Route{WorktreesChanged, ""}},
		{"/r/.git/worktrees/agent", Route{WorktreesChanged, ""}},
		{"/r/.git/worktrees/new-one", Route{WorktreesChanged, ""}},
		{"/r/.git/worktrees/new-one/HEAD", Route{WorktreesChanged, ""}},
		// everything else in the common dir
		{"/r/.git/objects/ab/cdef", Route{Ignore, ""}},
		{"/r/.git/logs/HEAD", Route{Ignore, ""}},
		{"/r/.git/config", Route{Ignore, ""}},
		{"/r/.git", Route{Ignore, ""}},
	}
	for _, c := range cases {
		if got := r.Route(filepath.FromSlash(c.path)); got != c.want {
			t.Errorf("Route(%q) = %+v, want %+v", c.path, got, c.want)
		}
	}
}

func TestRouterFiles(t *testing.T) {
	r := testRouter()
	cases := []struct {
		path string
		want Route
	}{
		{"/r/README.md", Route{FileEvent, "main"}},
		{"/r", Route{FileEvent, "main"}},
		{"/r2/a/b.txt", Route{FileEvent, "sib"}},
		{"/r2/.git", Route{Ignore, ""}},
		{"/r/sub/.git/HEAD", Route{Ignore, ""}}, // a nested plain repo's git dir
		{"/r/sub/.gitignore", Route{FileEvent, "main"}},
		{"/r20/x", Route{Ignore, ""}},
		{"/elsewhere/x", Route{Ignore, ""}},
		{"/", Route{Ignore, ""}},
	}
	for _, c := range cases {
		if got := r.Route(filepath.FromSlash(c.path)); got != c.want {
			t.Errorf("Route(%q) = %+v, want %+v", c.path, got, c.want)
		}
	}
}

func TestRouterSeparateGitDir(t *testing.T) {
	// Main worktree created with --separate-git-dir: common dir outside the root,
	// and <root>/.git is a gitfile.
	r := NewRouter("/store/r.git", []RouteTarget{
		{ID: "main", Root: "/r", AdminDir: "/store/r.git"},
	})
	if got := r.Route("/store/r.git/HEAD"); got != (Route{WorktreeRefEvent, "main"}) {
		t.Errorf("HEAD: %+v", got)
	}
	if got := r.Route("/r/.git"); got != (Route{Ignore, ""}) {
		t.Errorf("gitfile: %+v", got)
	}
	if got := r.Route("/r/a.txt"); got != (Route{FileEvent, "main"}) {
		t.Errorf("file: %+v", got)
	}
}

func TestRouterIDs(t *testing.T) {
	got := testRouter().ids()
	want := []model.WorktreeID{"main", "nested", "sib"}
	if len(got) != len(want) {
		t.Fatalf("ids() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ids() = %v, want %v", got, want)
		}
	}
}

func TestRouterTargetWithoutAdminDir(t *testing.T) {
	r := NewRouter("/r/.git", []RouteTarget{
		{ID: "main", Root: "/r", AdminDir: "/r/.git"},
		{ID: "odd", Root: "/o"}, // admin dir could not be read
	})
	if got := r.Route("/o/a.txt"); got != (Route{FileEvent, "odd"}) {
		t.Errorf("file: %+v", got)
	}
	if got := r.Route("/r/.git/HEAD"); got != (Route{WorktreeRefEvent, "main"}) {
		t.Errorf("main HEAD: %+v", got)
	}
}
