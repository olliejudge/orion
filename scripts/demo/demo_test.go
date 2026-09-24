package main

import (
	"bytes"
	"context"
	"io"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
}

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := git(dir, nil, args...)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

type wt struct{ path, branch string }

func worktrees(t *testing.T, root string) []wt {
	t.Helper()
	var res []wt
	for _, block := range strings.Split(strings.TrimSpace(mustGit(t, root, "worktree", "list", "--porcelain")), "\n\n") {
		var w wt
		for _, ln := range strings.Split(block, "\n") {
			if p, ok := strings.CutPrefix(ln, "worktree "); ok {
				w.path = p
			}
			if b, ok := strings.CutPrefix(ln, "branch refs/heads/"); ok {
				w.branch = b
			}
		}
		res = append(res, w)
	}
	return res
}

func TestOnceBuildsRepoWithNestedAndOutsideWorktrees(t *testing.T) {
	requireGit(t)
	dir := filepath.Join(t.TempDir(), "nebula")
	var out bytes.Buffer
	cfg := config{Dir: dir, Agents: 3, Seed: 7, Speed: 1, Once: true, Steps: 40}
	if err := run(context.Background(), cfg, &out); err != nil {
		t.Fatalf("run: %v\n%s", err, out.String())
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}

	wts := worktrees(t, root)
	if len(wts) != 4 {
		t.Fatalf("want 4 worktrees (main + 3 agents), got %d: %+v", len(wts), wts)
	}
	if wts[0].path != root || wts[0].branch != "main" {
		t.Fatalf("first worktree = %+v, want %s on main", wts[0], root)
	}
	nested, outside := 0, 0
	branches := map[string]bool{}
	for _, w := range wts[1:] {
		if !strings.HasPrefix(w.branch, "agent/") {
			t.Errorf("worktree %s is on %q, want an agent/* branch", w.path, w.branch)
		}
		branches[w.branch] = true
		switch {
		case strings.HasPrefix(w.path, filepath.Join(root, ".claude", "worktrees", "agent-")):
			nested++
		case !strings.HasPrefix(w.path, root+string(filepath.Separator)):
			outside++
		}
		if st := mustGit(t, w.path, "status", "--porcelain"); st == "" {
			t.Errorf("worktree %s has no uncommitted changes", w.path)
		}
		ahead, _ := strconv.Atoi(strings.TrimSpace(mustGit(t, root, "rev-list", "--count", "main.."+w.branch)))
		if ahead == 0 {
			t.Errorf("branch %s has no commits ahead of main", w.branch)
		}
	}
	if nested == 0 || outside == 0 {
		t.Errorf("want >=1 nested and >=1 outside worktree, got nested=%d outside=%d", nested, outside)
	}
	if len(branches) != 3 {
		t.Errorf("want 3 distinct agent branches, got %v", branches)
	}
	if st := mustGit(t, root, "status", "--porcelain"); st == "" {
		t.Error("main worktree has no uncommitted changes")
	}
	if st := mustGit(t, root, "status", "--porcelain", "--untracked-files=all"); strings.Contains(st, ".claude/") {
		t.Errorf("nested worktrees leak into main's status:\n%s", st)
	}
	commits, _ := strconv.Atoi(strings.TrimSpace(mustGit(t, root, "rev-list", "--count", "main")))
	if commits < historyCommits {
		t.Errorf("main has %d commits, want >= %d", commits, historyCommits)
	}
	files := strings.Count(mustGit(t, root, "ls-tree", "-r", "--name-only", "main"), "\n")
	if files < 150 || files > 300 {
		t.Errorf("main has %d files, want 150..300", files)
	}
	if !strings.Contains(out.String(), "orion "+root) {
		t.Errorf("output does not tell the user how to run orion:\n%s", out.String())
	}
}

func TestBuildRepoIsDeterministic(t *testing.T) {
	requireGit(t)
	head := func(seed uint64) string {
		root := t.TempDir()
		rng := rand.New(rand.NewPCG(seed, 0x6f72696f6e))
		if err := buildRepo(root, rng, newNamer(rng), &logger{w: io.Discard}); err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(mustGit(t, root, "rev-parse", "HEAD"))
	}
	a, b, c := head(3), head(3), head(4)
	if a != b {
		t.Errorf("same seed gave different HEADs: %s vs %s", a, b)
	}
	if a == c {
		t.Errorf("different seeds gave the same HEAD %s", a)
	}
}

func TestMergeRespawnsAgentInSameSlot(t *testing.T) {
	requireGit(t)
	dir := filepath.Join(t.TempDir(), "nebula")
	if err := prepareDir(dir); err != nil {
		t.Fatal(err)
	}
	root, _ := filepath.EvalSymlinks(dir)
	rng := rand.New(rand.NewPCG(1, 2))
	nm := newNamer(rng)
	log := &logger{w: io.Discard}
	if err := buildRepo(root, rng, nm, log); err != nil {
		t.Fatal(err)
	}
	s := newSim(config{Agents: 2, Speed: 1}, root, rng, nm, log)
	if err := s.spawnInitialAgents(); err != nil {
		t.Fatal(err)
	}
	a := s.agents[0]
	for i := 0; i < 4; i++ {
		if _, err := s.agentAction(a); err != nil {
			t.Fatal(err)
		}
	}
	created := s.nm.next(a.Theme.Dir, ".tsx", s.exists(a))
	if err := writeFile(a.Dir, created, []byte("export {};\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.humanAction(); err != nil {
		t.Fatal(err)
	}
	s.you.Pending = 1

	if err := s.mergeAndRespawn(a); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(created))); err != nil {
		t.Errorf("merged file %s missing from main worktree: %v", created, err)
	}
	if n := strings.TrimSpace(mustGit(t, root, "rev-list", "--merges", "--count", "main")); n != "1" {
		t.Errorf("want 1 merge commit on main, got %s", n)
	}
	br := mustGit(t, root, "branch", "--list", "agent/*", "--format=%(refname:short)")
	if strings.Contains(br, "agent/ui\n") || !strings.Contains(br, "agent/ui-2\n") {
		t.Errorf("want agent/ui replaced by agent/ui-2, branches:\n%s", br)
	}
	if s.agents[0].Name != "agent-ui-2" || !s.agents[0].Nested {
		t.Errorf("respawned agent = %+v, want nested agent-ui-2", s.agents[0])
	}
	if got := len(worktrees(t, root)); got != 3 {
		t.Errorf("want 3 worktrees after respawn, got %d", got)
	}
}

func TestRefusesToOverwriteForeignDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "precious.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := run(context.Background(), config{Dir: dir, Agents: 1, Speed: 1, Once: true}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("want refusal, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "precious.txt")); err != nil {
		t.Fatalf("foreign file was touched: %v", err)
	}
}

func TestRerunReplacesPreviousDemo(t *testing.T) {
	requireGit(t)
	dir := filepath.Join(t.TempDir(), "nebula")
	cfg := config{Dir: dir, Agents: 2, Seed: 1, Speed: 1, Once: true, Steps: 5}
	for i := 0; i < 2; i++ {
		if err := run(context.Background(), cfg, io.Discard); err != nil {
			t.Fatalf("run %d: %v", i+1, err)
		}
	}
}

func TestValidateRejectsBadFlags(t *testing.T) {
	for _, c := range []config{
		{Dir: "x", Agents: 0, Speed: 1},
		{Dir: "x", Agents: maxAgents + 1, Speed: 1},
		{Dir: "x", Agents: 1, Speed: 0},
		{Dir: "x", Agents: 1, Speed: 1, Steps: -1},
		{Dir: "", Agents: 1, Speed: 1},
	} {
		if err := c.validate(); err == nil {
			t.Errorf("validate(%+v) = nil, want error", c)
		}
	}
}

func TestNamerNeverRunsOutOfNames(t *testing.T) {
	const calls = 5000 // well past the 45*44 = 1980 word pairs per folder
	for _, ext := range []string{".go", ".css", ".md"} {
		done := make(chan []string, 1)
		go func() {
			nm := newNamer(rand.New(rand.NewPCG(1, 2)))
			names := make([]string, 0, calls)
			for range calls {
				names = append(names, nm.next("some/dir", ext, nil))
			}
			done <- names
		}()
		select {
		case names := <-done:
			seen := map[string]bool{}
			for _, n := range names {
				if seen[n] {
					t.Fatalf("%s: duplicate name %s", ext, n)
				}
				seen[n] = true
				if !strings.HasPrefix(n, "some/dir/") || !strings.HasSuffix(n, ext) {
					t.Fatalf("%s: bad name %s", ext, n)
				}
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("%s: namer.next did not return %d names within 10s", ext, calls)
		}
	}
}
