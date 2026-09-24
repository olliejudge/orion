package gitx

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func trimOut(b []byte) string { return strings.TrimRight(string(b), "\r\n") }

// realPath makes p absolute and resolves symlinks when p exists, so paths
// compare equal to what the file watcher reports (e.g. /private/var on macOS).
func realPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	return abs
}

func refuseOption(rev string) error {
	if rev == "" || strings.HasPrefix(rev, "-") {
		return fmt.Errorf("invalid revision %q", rev)
	}
	return nil
}

// CommonDir returns the absolute git common dir (the main repo's .git) for dir.
func CommonDir(ctx context.Context, r Runner, dir string) (string, error) {
	// --path-format=absolute needs git 2.31; resolve relative output ourselves.
	out, err := r.Run(ctx, dir, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", err
	}
	p := trimOut(out)
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	return realPath(p), nil
}

// MainRoot returns the absolute top level of the MAIN worktree, even when dir
// is inside a linked worktree. Bare repositories are an error. git's own
// answer (worktree list, or the common dir minus "/.git") is the git dir
// itself for submodules and --separate-git-dir repos, so:
//   - in the main worktree (git dir == common dir), use --show-toplevel;
//   - elsewhere, use core.worktree from the common config if set (submodules);
//   - else the common dir's parent when it is named ".git";
//   - else fail: a separate git dir does not record its main worktree.
func MainRoot(ctx context.Context, r Runner, dir string) (string, error) {
	// --path-format=absolute needs git 2.31; resolve relative output ourselves.
	out, err := r.Run(ctx, dir, "rev-parse", "--is-bare-repository", "--git-dir", "--git-common-dir")
	if err != nil {
		return "", err
	}
	lines := strings.Split(trimOut(out), "\n")
	if len(lines) != 3 {
		return "", fmt.Errorf("unexpected rev-parse output %q", out)
	}
	abs := func(p string) string {
		if !filepath.IsAbs(p) {
			p = filepath.Join(dir, p)
		}
		return realPath(p)
	}
	gitDir, common := abs(lines[1]), abs(lines[2])
	if lines[0] == "true" {
		return "", fmt.Errorf("%s is a bare repository; run orion inside a worktree", common)
	}
	if gitDir == common {
		out, err := r.Run(ctx, dir, "rev-parse", "--show-toplevel")
		if err != nil {
			return "", err
		}
		return realPath(trimOut(out)), nil
	}
	out, err = r.Run(ctx, dir, "config", "--file", filepath.Join(common, "config"), "--get", "core.worktree")
	if err == nil {
		wt := trimOut(out)
		if !filepath.IsAbs(wt) {
			wt = filepath.Join(common, wt)
		}
		return realPath(wt), nil
	}
	if filepath.Base(common) == ".git" {
		return filepath.Dir(common), nil
	}
	return "", fmt.Errorf("cannot locate the main worktree of %s from a linked worktree; run orion in the main worktree", common)
}

// RevParse resolves rev to a full commit sha. It errors when rev is missing.
func RevParse(ctx context.Context, r Runner, dir, rev string) (string, error) {
	if err := refuseOption(rev); err != nil {
		return "", err
	}
	out, err := r.Run(ctx, dir, "rev-parse", "--verify", "--quiet", rev+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("revision %q not found: %w", rev, err)
	}
	return trimOut(out), nil
}

// MergeBase returns the best common ancestor of a and b, or "" with a nil
// error when they share no history.
func MergeBase(ctx context.Context, r Runner, dir, a, b string) (string, error) {
	if err := refuseOption(a); err != nil {
		return "", err
	}
	if err := refuseOption(b); err != nil {
		return "", err
	}
	out, err := r.Run(ctx, dir, "merge-base", a, b)
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 && len(out) == 0 {
			return "", nil
		}
		return "", err
	}
	return trimOut(out), nil
}

// ResolveBase picks the base branch (spec §2): the override if given, else
// origin/HEAD's target, else local main, else master, else the main
// worktree's current branch (short sha when detached). A repo with no
// commits yields "", "", nil.
func ResolveBase(ctx context.Context, r Runner, dir, override string) (ref, sha string, err error) {
	if override != "" {
		sha, err := RevParse(ctx, r, dir, override)
		if err != nil {
			return "", "", fmt.Errorf("base branch %q: %w", override, err)
		}
		return override, sha, nil
	}
	if out, err := r.Run(ctx, dir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"); err == nil {
		full := trimOut(out)
		if sha, err := RevParse(ctx, r, dir, full); err == nil {
			return strings.TrimPrefix(full, "refs/remotes/"), sha, nil
		}
	}
	for _, name := range []string{"main", "master"} {
		if sha, err := RevParse(ctx, r, dir, "refs/heads/"+name); err == nil {
			return name, sha, nil
		}
	}
	wts, err := ListWorktrees(ctx, r, dir)
	if err != nil {
		return "", "", err
	}
	if len(wts) == 0 || !wts[0].IsMain || wts[0].Head == "" {
		return "", "", nil
	}
	main := wts[0]
	if main.Branch != "" {
		return main.Branch, main.Head, nil
	}
	return main.Head[:7], main.Head, nil
}

// CommitSubject returns the first line of the commit message of sha.
func CommitSubject(ctx context.Context, r Runner, dir, sha string) (string, error) {
	if err := refuseOption(sha); err != nil {
		return "", err
	}
	out, err := r.Run(ctx, dir, "log", "-1", "--no-show-signature", "--format=%s", sha, "--")
	if err != nil {
		return "", err
	}
	return trimOut(out), nil
}

// WorktreeAdminDir returns the git admin dir of a worktree: <wt>/.git for the
// main worktree, or the "gitdir:" target of <wt>/.git for a linked one
// (normally <common>/worktrees/<name>).
func WorktreeAdminDir(wtPath string) (string, error) {
	dotgit := filepath.Join(wtPath, ".git")
	fi, err := os.Stat(dotgit)
	if err != nil {
		return "", fmt.Errorf("%s is not a git worktree: %w", wtPath, err)
	}
	if fi.IsDir() {
		return realPath(dotgit), nil
	}
	b, err := os.ReadFile(dotgit)
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(b))
	target, ok := strings.CutPrefix(line, "gitdir: ")
	if !ok {
		return "", fmt.Errorf("%s: unexpected .git file contents %q", wtPath, line)
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(wtPath, target)
	}
	return realPath(target), nil
}
