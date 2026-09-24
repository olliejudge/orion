package gitx

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
)

// Worktree is one entry of `git worktree list --porcelain`.
type Worktree struct {
	Path     string // absolute
	Head     string // sha, "" if unborn
	Branch   string // short name, "" if detached
	Detached bool
	Locked   bool
	Prunable bool // directory missing
	IsMain   bool // first entry
}

// ListWorktrees lists the repo's worktrees, main first. Bare entries are
// skipped. Paths are symlink-resolved when the directory exists; a missing
// directory marks the entry Prunable. The main entry's path is the working
// tree (see MainRoot), never the git dir.
func ListWorktrees(ctx context.Context, r Runner, dir string) ([]Worktree, error) {
	// -z needs git 2.36; fall back to newline-separated output on older git.
	out, err := r.Run(ctx, dir, "worktree", "list", "--porcelain", "-z")
	sep := byte(0)
	if err != nil {
		var err2 error
		out, err2 = r.Run(ctx, dir, "worktree", "list", "--porcelain")
		if err2 != nil {
			return nil, err
		}
		sep = '\n'
	}
	wts, _ := parseWorktrees(out, sep)
	// git reports the git dir as the main worktree of submodules and
	// --separate-git-dir repos. A real working tree has a .git entry.
	if len(wts) > 0 && wts[0].IsMain {
		if _, err := os.Lstat(filepath.Join(wts[0].Path, ".git")); err != nil {
			root, err := MainRoot(ctx, r, dir)
			if err != nil {
				return nil, err
			}
			wts[0].Path = root
		}
	}
	for i := range wts {
		if _, err := os.Stat(wts[i].Path); err != nil {
			wts[i].Prunable = true
			continue
		}
		wts[i].Path = realPath(wts[i].Path)
	}
	return wts, nil
}

// parseWorktrees parses porcelain records separated by sep, each ending with
// an empty field. It reports whether the first record was a bare repo.
func parseWorktrees(out []byte, sep byte) ([]Worktree, bool) {
	var (
		wts      []Worktree
		cur      Worktree
		inEntry  bool
		isBare   bool
		index    int
		bareRepo bool
	)
	flush := func() {
		if inEntry {
			if isBare {
				if index == 0 {
					bareRepo = true
				}
			} else {
				cur.IsMain = index == 0
				wts = append(wts, cur)
			}
			index++
		}
		cur, inEntry, isBare = Worktree{}, false, false
	}
	for _, field := range bytes.Split(out, []byte{sep}) {
		line := string(field)
		key, val, _ := strings.Cut(line, " ")
		switch key {
		case "":
			flush()
		case "worktree":
			flush()
			cur.Path = filepath.Clean(val)
			inEntry = true
		case "HEAD":
			if strings.Trim(val, "0") != "" {
				cur.Head = val
			}
		case "branch":
			cur.Branch = strings.TrimPrefix(val, "refs/heads/")
		case "detached":
			cur.Detached = true
		case "locked":
			cur.Locked = true
		case "prunable":
			cur.Prunable = true
		case "bare":
			isBare = true
		}
	}
	flush()
	return wts, bareRepo
}
