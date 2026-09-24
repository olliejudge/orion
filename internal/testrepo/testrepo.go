// Package testrepo builds throwaway git repositories for tests. Every repo
// lives in t.TempDir(), uses deterministic author/committer identities and
// dates, ignores the user's global git config, and starts on branch main.
package testrepo

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Repo is a git working tree (the main one or a linked worktree).
type Repo struct {
	t     testing.TB
	root  string // absolute, symlinks resolved
	home  string // empty HOME/XDG_CONFIG_HOME, shared with linked worktrees
	clock *int   // shared commit counter so dates increase across worktrees
}

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// New creates an empty repository on branch main.
func New(t testing.TB) *Repo {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("testrepo: resolve temp dir: %v", err)
	}
	r := &Repo{t: t, root: root, home: t.TempDir(), clock: new(int)}
	r.Git("init", "--quiet", "--initial-branch=main")
	r.Git("config", "commit.gpgsign", "false")
	r.Git("config", "tag.gpgsign", "false")
	r.Git("config", "core.autocrlf", "false")
	return r
}

// Path returns the absolute, symlink-resolved root of this working tree.
func (r *Repo) Path() string { return r.root }

func (r *Repo) abs(rel string) string {
	if filepath.IsAbs(rel) {
		return rel
	}
	return filepath.Join(r.root, filepath.FromSlash(rel))
}

// Write creates or overwrites rel (slash-separated, relative to Path) with
// content, creating parent directories as needed.
func (r *Repo) Write(rel, content string) {
	r.t.Helper()
	p := r.abs(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		r.t.Fatalf("testrepo: mkdir for %q: %v", rel, err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		r.t.Fatalf("testrepo: write %q: %v", rel, err)
	}
}

// Remove deletes rel from the working tree (not from the index).
func (r *Repo) Remove(rel string) {
	r.t.Helper()
	if err := os.RemoveAll(r.abs(rel)); err != nil {
		r.t.Fatalf("testrepo: remove %q: %v", rel, err)
	}
}

// Move renames a file on disk only, like a plain `mv` (git sees delete + add).
func (r *Repo) Move(from, to string) {
	r.t.Helper()
	dst := r.abs(to)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		r.t.Fatalf("testrepo: mkdir for %q: %v", to, err)
	}
	if err := os.Rename(r.abs(from), dst); err != nil {
		r.t.Fatalf("testrepo: move %q -> %q: %v", from, to, err)
	}
}

// GitMv renames with `git mv`, staging the rename.
func (r *Repo) GitMv(from, to string) {
	r.t.Helper()
	if err := os.MkdirAll(filepath.Dir(r.abs(to)), 0o755); err != nil {
		r.t.Fatalf("testrepo: mkdir for %q: %v", to, err)
	}
	r.Git("mv", "--", from, to)
}

// Add stages the given paths, or everything (`git add -A`) when none are given.
func (r *Repo) Add(paths ...string) {
	r.t.Helper()
	if len(paths) == 0 {
		r.Git("add", "-A")
		return
	}
	r.Git(append([]string{"add", "--"}, paths...)...)
}

// Commit commits the index with msg and returns the new HEAD sha.
func (r *Repo) Commit(msg string) string {
	r.t.Helper()
	r.Git("commit", "--quiet", "--no-verify", "-m", msg)
	return r.Git("rev-parse", "HEAD")
}

// Branch creates a branch at HEAD without switching to it.
func (r *Repo) Branch(name string) {
	r.t.Helper()
	r.Git("branch", "--", name)
}

// Checkout switches this working tree to an existing branch.
func (r *Repo) Checkout(name string) {
	r.t.Helper()
	r.Git("checkout", "--quiet", name, "--")
}

// Merge merges branch into the current branch with a merge commit and
// returns the new HEAD sha.
func (r *Repo) Merge(branch string) string {
	r.t.Helper()
	r.Git("merge", "--no-ff", "--quiet", "-m", "Merge "+branch, branch)
	return r.Git("rev-parse", "HEAD")
}

// WorktreeAdd adds a linked worktree at path (relative to this Repo's root,
// or absolute) on branch, creating the branch from HEAD if it does not exist.
func (r *Repo) WorktreeAdd(path, branch string) *Repo {
	r.t.Helper()
	dst := r.abs(path)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		r.t.Fatalf("testrepo: mkdir for worktree %q: %v", path, err)
	}
	if r.hasBranch(branch) {
		r.Git("worktree", "add", "--quiet", dst, branch)
	} else {
		r.Git("worktree", "add", "--quiet", "-b", branch, dst)
	}
	real, err := filepath.EvalSymlinks(dst)
	if err != nil {
		r.t.Fatalf("testrepo: resolve worktree %q: %v", path, err)
	}
	return &Repo{t: r.t, root: real, home: r.home, clock: r.clock}
}

// WorktreeRemove force-removes the linked worktree at path (relative or absolute).
func (r *Repo) WorktreeRemove(path string) {
	r.t.Helper()
	r.Git("worktree", "remove", "--force", r.abs(path))
}

func (r *Repo) hasBranch(name string) bool {
	cmd := exec.Command("git", "rev-parse", "--verify", "--quiet", "refs/heads/"+name)
	cmd.Dir = r.root
	cmd.Env = r.env()
	return cmd.Run() == nil
}

// Git runs git in this working tree and returns stdout with trailing
// newlines removed. It fails the test on error.
func (r *Repo) Git(args ...string) string {
	r.t.Helper()
	if len(args) > 0 && (args[0] == "commit" || args[0] == "merge") {
		*r.clock++
	}
	cmd := exec.Command("git", args...)
	cmd.Dir = r.root
	cmd.Env = r.env()
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		r.t.Fatalf("testrepo: git %s: %v\n%s", strings.Join(args, " "), err, stderr.String())
	}
	return strings.TrimRight(stdout.String(), "\n")
}

// env returns the caller's environment minus any inherited GIT_* variables
// (e.g. GIT_DIR or GIT_INDEX_FILE set by an enclosing git hook), plus a fixed
// set that isolates git from the user's config. HOME and XDG_CONFIG_HOME point
// at an empty directory because git < 2.32 ignores GIT_CONFIG_GLOBAL.
func (r *Repo) env() []string {
	date := epoch.Add(time.Duration(*r.clock) * time.Minute).Format(time.RFC3339)
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "GIT_") || strings.HasPrefix(kv, "HOME=") || strings.HasPrefix(kv, "XDG_CONFIG_HOME=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env,
		"HOME="+r.home,
		"XDG_CONFIG_HOME="+r.home,
		"GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=Test",
		"GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test",
		"GIT_COMMITTER_EMAIL=test@example.com",
		fmt.Sprintf("GIT_AUTHOR_DATE=%s", date),
		fmt.Sprintf("GIT_COMMITTER_DATE=%s", date),
	)
}
