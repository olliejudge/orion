package gitx

import (
	"bytes"
	"context"
	"os"
	"path"
	"strings"
)

// ChangeKind is how a path differs from the comparison point.
type ChangeKind string

const (
	Added    ChangeKind = "added"
	Modified ChangeKind = "modified"
	Deleted  ChangeKind = "deleted"
	Renamed  ChangeKind = "renamed"
)

// Change is one changed path. From is set only for Renamed.
type Change struct {
	Path string
	From string
	Kind ChangeKind
}

// DiffNameStatus lists changes between two commits with rename detection.
// Copies are reported as Added. from == "" means the empty tree.
func DiffNameStatus(ctx context.Context, r Runner, dir, from, to string) ([]Change, error) {
	if from == "" {
		empty, err := r.Run(ctx, dir, "hash-object", "-t", "tree", os.DevNull)
		if err != nil {
			return nil, err
		}
		from = trimOut(empty)
	}
	if err := refuseOption(from); err != nil {
		return nil, err
	}
	if err := refuseOption(to); err != nil {
		return nil, err
	}
	// diff-tree is plumbing: unlike `git diff` it ignores diff.* user config
	// (diff.relative, external drivers, colour) and always prints root-relative paths.
	out, err := r.Run(ctx, dir, "diff-tree", "-r", "-z", "-M", "--name-status", "--no-commit-id", from, to)
	if err != nil {
		return nil, err
	}
	return parseNameStatus(out), nil
}

func parseNameStatus(out []byte) []Change {
	fields := strings.Split(string(out), "\x00")
	var changes []Change
	for i := 0; i < len(fields); i++ {
		status := fields[i]
		if status == "" {
			continue
		}
		switch status[0] {
		case 'R', 'C':
			if i+2 >= len(fields) {
				return changes
			}
			from, to := fields[i+1], fields[i+2]
			i += 2
			if status[0] == 'R' {
				changes = append(changes, Change{Path: to, From: from, Kind: Renamed})
			} else {
				changes = append(changes, Change{Path: to, Kind: Added})
			}
		default:
			if i+1 >= len(fields) {
				return changes
			}
			p := fields[i+1]
			i++
			switch status[0] {
			case 'A':
				changes = append(changes, Change{Path: p, Kind: Added})
			case 'D':
				changes = append(changes, Change{Path: p, Kind: Deleted})
			case 'M', 'T', 'U':
				changes = append(changes, Change{Path: p, Kind: Modified})
			}
		}
	}
	return changes
}

// Status lists the uncommitted changes of the worktree at wtDir (staged,
// unstaged and untracked, with staged renames). Untracked directory entries
// (trailing "/", i.e. nested repos or nested worktrees) are dropped.
func Status(ctx context.Context, r Runner, wtDir string) ([]Change, error) {
	out, err := r.Run(ctx, wtDir, "status", "--porcelain=v2", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	return parseStatus(out), nil
}

func parseStatus(out []byte) []Change {
	fields := bytes.Split(out, []byte{0})
	var changes []Change
	for i := 0; i < len(fields); i++ {
		line := string(fields[i])
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case '1': // 1 XY sub mH mI mW hH hI path
			parts := strings.SplitN(line, " ", 9)
			if len(parts) != 9 {
				continue
			}
			if kind, ok := kindForXY(parts[1][0], parts[1][1]); ok {
				changes = append(changes, Change{Path: parts[8], Kind: kind})
			}
		case '2': // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
			parts := strings.SplitN(line, " ", 10)
			if len(parts) != 10 || i+1 >= len(fields) {
				continue
			}
			orig := string(fields[i+1])
			i++
			x, y := parts[1][0], parts[1][1]
			switch {
			case y == 'D':
				changes = append(changes, Change{Path: orig, Kind: Deleted})
			case x == 'C':
				changes = append(changes, Change{Path: parts[9], Kind: Added})
			default:
				changes = append(changes, Change{Path: parts[9], From: orig, Kind: Renamed})
			}
		case 'u': // u XY sub m1 m2 m3 mW h1 h2 h3 path
			parts := strings.SplitN(line, " ", 11)
			if len(parts) == 11 {
				changes = append(changes, Change{Path: parts[10], Kind: Modified})
			}
		case '?':
			p := line[2:]
			if !strings.HasSuffix(p, "/") {
				changes = append(changes, Change{Path: p, Kind: Added})
			}
		}
	}
	return changes
}

func kindForXY(x, y byte) (ChangeKind, bool) {
	switch {
	case x == 'A' && y == 'D':
		return "", false // added to the index, then deleted: nothing left
	case x == 'D' || y == 'D':
		return Deleted, true
	case x == 'A':
		return Added, true
	default:
		return Modified, true
	}
}

// PairMoves turns a Deleted + Added pair whose basenames match (and are
// unique among deletions and additions) into one Renamed{Path: added, From:
// deleted}, placed where the Added entry was. Other entries keep their order.
func PairMoves(changes []Change) []Change {
	deleted := map[string][]int{}
	added := map[string][]int{}
	for i, c := range changes {
		switch c.Kind {
		case Deleted:
			deleted[path.Base(c.Path)] = append(deleted[path.Base(c.Path)], i)
		case Added:
			added[path.Base(c.Path)] = append(added[path.Base(c.Path)], i)
		}
	}
	drop := map[int]bool{}
	replace := map[int]Change{}
	for name, ds := range deleted {
		as := added[name]
		if len(ds) == 1 && len(as) == 1 {
			drop[ds[0]] = true
			replace[as[0]] = Change{Path: changes[as[0]].Path, From: changes[ds[0]].Path, Kind: Renamed}
		}
	}
	out := make([]Change, 0, len(changes)-len(drop))
	for i, c := range changes {
		if drop[i] {
			continue
		}
		if rc, ok := replace[i]; ok {
			c = rc
		}
		out = append(out, c)
	}
	return out
}
