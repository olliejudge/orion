package repo

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/olliejudge/orion/internal/gitx"
)

func TestRepoKeys(t *testing.T) {
	for _, tc := range []struct{ roots, want []string }{
		{[]string{"/a/api", "/a/web"}, []string{"api", "web"}},
		{[]string{"/a/x/api", "/b/y/api", "/c/web"}, []string{"x/api", "y/api", "web"}},
		{[]string{"/a/s/api", "/b/s/api"}, []string{"a/s/api", "b/s/api"}},
	} {
		if got := RepoKeys(tc.roots); !slices.Equal(got, tc.want) {
			t.Errorf("RepoKeys(%q) = %q, want %q", tc.roots, got, tc.want)
		}
	}
}

func TestDefaultName(t *testing.T) {
	for _, tc := range []struct {
		keys []string
		want string
	}{
		{[]string{"acme-api", "acme-web"}, "acme"},
		{[]string{"acme_api", "acme.web", "acme-game"}, "acme"},
		{[]string{"api", "web"}, "api + web"},
		{[]string{"app", "apple"}, "app"},
	} {
		if got := DefaultName(tc.keys); got != tc.want {
			t.Errorf("DefaultName(%q) = %q, want %q", tc.keys, got, tc.want)
		}
	}
}

// twoRepos returns two repos, each with a linked worktree holding an
// uncommitted file, so each engine gives its linked worktree colour 1.
func twoRepos(t *testing.T) (api, web string) {
	t.Helper()
	for i, name := range []string{"api", "web"} {
		r := initRepo(t, map[string]string{"README.md": "# " + name + "\n"})
		wt := r.WorktreeAdd(filepath.Join(t.TempDir(), name+"-agent"), "agent")
		wt.Write("todo.md", "x\n")
		if i == 0 {
			api = r.Path()
		} else {
			web = r.Path()
		}
	}
	return api, web
}

func openWorkspace(t *testing.T, paths ...string) *Workspace {
	t.Helper()
	engines, dups, err := OpenAll(context.Background(), paths, "", gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	if len(dups) > 0 {
		t.Fatalf("dups = %q", dups)
	}
	return NewWorkspace("acme", engines)
}

func TestWorkspaceSnapshot(t *testing.T) {
	api, web := twoRepos(t)
	w := openWorkspace(t, api, web)
	s := w.Snapshot()
	apiKey, webKey := filepath.Base(api), filepath.Base(web)
	if s.Repo.Name != "acme" || s.Repo.Base != "" {
		t.Errorf("Repo = %+v, want the project name and no base", s.Repo)
	}
	if len(s.Repos) != 2 || s.Repos[0].Key != apiKey || s.Repos[1].Key != webKey || s.Repos[0].Base != "main" {
		t.Errorf("Repos = %+v", s.Repos)
	}
	var paths []string
	for _, f := range s.Tree {
		paths = append(paths, f.Path)
	}
	if want := []string{apiKey + "/README.md", webKey + "/README.md"}; !slices.Equal(paths, want) {
		t.Errorf("tree = %q, want %q", paths, want)
	}
	if len(s.Worktrees) != 4 {
		t.Fatalf("worktrees = %+v, want 4", s.Worktrees)
	}
	colors := map[int]int{}
	for i, wt := range s.Worktrees {
		wantRepo := apiKey
		if i >= 2 {
			wantRepo = webKey
		}
		if wt.Repo != wantRepo {
			t.Errorf("worktree %d repo = %q, want %q", i, wt.Repo, wantRepo)
		}
		if wt.IsMain && wt.ColorIndex != 0 {
			t.Errorf("main %s colour %d, want 0", wt.Path, wt.ColorIndex)
		}
		if !wt.IsMain {
			colors[wt.ColorIndex]++
			for _, e := range s.Overlays[wt.ID] {
				if e.Path != wt.Repo+"/todo.md" {
					t.Errorf("overlay path %q, want %s/todo.md", e.Path, wt.Repo)
				}
			}
		}
	}
	if len(colors) != 2 || colors[0] != 0 || colors[-1] != 0 {
		t.Errorf("linked worktree colours %v, want two distinct non-main colours", colors)
	}
}

func TestOpenAllSkipsSameRepo(t *testing.T) {
	r := initRepo(t, map[string]string{"a": "1"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "wt"), "b")
	engines, dups, err := OpenAll(context.Background(), []string{r.Path(), wt.Path()}, "", gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	if len(engines) != 1 || !slices.Equal(dups, []string{wt.Path()}) {
		t.Fatalf("engines %d, dups %q; want 1 and the linked worktree", len(engines), dups)
	}
}

// runWorkspace runs w until the test ends and waits for every engine's
// watchers.
func runWorkspace(t *testing.T, w *Workspace) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Run: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Error("Run did not return after cancel")
		}
	})
	for _, m := range w.members {
		select {
		case <-m.eng.ready:
		case <-time.After(5 * time.Second):
			t.Fatal("engine not ready")
		}
	}
}

func TestWorkspaceForwardsPatches(t *testing.T) {
	api, web := twoRepos(t)
	w := openWorkspace(t, api, web)
	seq := w.Snapshot().Seq
	ch, unsub := w.Subscribe()
	defer unsub()
	runWorkspace(t, w)

	webKey := filepath.Base(web)
	if err := os.WriteFile(filepath.Join(web, "app.js"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(15 * time.Second)
	for {
		select {
		case p, ok := <-ch:
			if !ok {
				t.Fatal("subscription dropped")
			}
			if p.Seq != seq+1 {
				t.Fatalf("seq %d after %d", p.Seq, seq)
			}
			seq = p.Seq
			for _, e := range p.Overlays[wtID(web)].Upsert {
				if e.Path == webKey+"/app.js" {
					if s := w.Snapshot(); s.Seq != seq {
						t.Errorf("snapshot seq %d, want %d", s.Seq, seq)
					}
					return
				}
			}
		case <-deadline:
			t.Fatal("no patch for app.js")
		}
	}
}

func TestWorkspaceResyncsClientsWhenEngineDropsIt(t *testing.T) {
	api, web := twoRepos(t)
	w := openWorkspace(t, api, web)
	ch, unsub := w.Subscribe()
	defer unsub()
	runWorkspace(t, w)

	w.mu.Lock()
	w.members[0].unsub() // what the engine does to a slow subscriber
	w.mu.Unlock()
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("got a patch, want the subscription closed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("subscription not closed")
	}
	if s := w.Snapshot(); len(s.Tree) != 2 {
		t.Errorf("tree after reload = %+v", s.Tree)
	}
	ch2, unsub2 := w.Subscribe()
	defer unsub2()
	if err := os.WriteFile(filepath.Join(api, "new.txt"), []byte("y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case p := <-ch2:
		if p.Seq <= 1 {
			t.Errorf("seq %d", p.Seq)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no patch after the reload")
	}
}
