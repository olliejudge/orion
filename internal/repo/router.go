// Package repo connects watch → gitx → model: it routes filesystem events,
// schedules recomputes and owns the live model.Store.
package repo

import (
	"path/filepath"
	"sort"
	"strings"

	"github.com/olliejudge/orion/internal/model"
)

// Class says what a filesystem event means for the repo.
type Class int

const (
	Ignore           Class = iota // nothing to do
	FileEvent                     // a working-tree file of Route.Worktree changed
	WorktreeRefEvent              // HEAD/index/merge/rebase state of Route.Worktree changed
	RefsEvent                     // refs/** or packed-refs changed (base or any branch may have moved)
	WorktreesChanged              // the set of linked worktrees (or their lock state) changed
)

// Route is the classification of one event path.
type Route struct {
	Class    Class
	Worktree model.WorktreeID
}

// RouteTarget describes one worktree. Root and AdminDir are absolute, clean,
// symlink-resolved paths. For the main worktree AdminDir equals the common dir.
type RouteTarget struct {
	ID       model.WorktreeID
	Root     string
	AdminDir string
}

// Router classifies absolute event paths. It is immutable; build a new one
// when the set of worktrees changes.
type Router struct {
	commonDir string
	main      model.WorktreeID
	hasMain   bool
	linked    map[string]model.WorktreeID // admin dir → ID, for linked worktrees only
	byRoot    []RouteTarget               // sorted by len(Root) descending → first match is the longest prefix
	order     []model.WorktreeID
}

// stateFiles are the per-worktree git files whose change means HEAD, the index
// or an in-progress merge/rebase changed.
var stateFiles = map[string]bool{
	"HEAD": true, "index": true, "ORIG_HEAD": true, "MERGE_HEAD": true, "REBASE_HEAD": true,
}

// NewRouter builds a Router for the given common dir and worktrees.
func NewRouter(commonDir string, targets []RouteTarget) *Router {
	r := &Router{commonDir: filepath.Clean(commonDir), linked: map[string]model.WorktreeID{}}
	for _, t := range targets {
		t.Root = filepath.Clean(t.Root)
		r.order = append(r.order, t.ID)
		r.byRoot = append(r.byRoot, t)
		switch admin := filepath.Clean(t.AdminDir); {
		case t.AdminDir == "":
			// admin dir unknown: file events only
		case admin == r.commonDir:
			r.main, r.hasMain = t.ID, true
		default:
			r.linked[admin] = t.ID
		}
	}
	sort.SliceStable(r.byRoot, func(i, j int) bool { return len(r.byRoot[i].Root) > len(r.byRoot[j].Root) })
	return r
}

// ids returns the IDs of every target, in the order given to NewRouter.
func (r *Router) ids() []model.WorktreeID {
	return append([]model.WorktreeID(nil), r.order...)
}

// Route classifies one absolute path.
func (r *Router) Route(absPath string) Route {
	p := filepath.Clean(absPath)
	if rel, ok := under(p, r.commonDir); ok {
		return r.routeGit(rel)
	}
	for _, t := range r.byRoot {
		rel, ok := under(p, t.Root)
		if !ok {
			continue
		}
		for _, part := range strings.Split(rel, "/") {
			if part == ".git" {
				return Route{Class: Ignore}
			}
		}
		return Route{Class: FileEvent, Worktree: t.ID}
	}
	return Route{Class: Ignore}
}

// routeGit classifies rel, a slash-separated path relative to the common dir
// ("" for the common dir itself).
func (r *Router) routeGit(rel string) Route {
	switch {
	case rel == "worktrees":
		return Route{Class: WorktreesChanged}
	case strings.HasPrefix(rel, "worktrees/"):
		rest := strings.TrimPrefix(rel, "worktrees/")
		name, inner, _ := strings.Cut(rest, "/")
		if inner == "" {
			return Route{Class: WorktreesChanged} // <name> dir created or removed
		}
		id, known := r.linked[filepath.Join(r.commonDir, "worktrees", name)]
		switch {
		case !known:
			return Route{Class: WorktreesChanged} // an admin dir we do not know yet: a worktree is being added
		case inner == "locked":
			return Route{Class: WorktreesChanged} // `git worktree lock/unlock`
		case inner == "gitdir":
			return Route{Class: WorktreesChanged} // `git worktree move` rewrites it: the root changed
		case isStateFile(inner):
			return Route{Class: WorktreeRefEvent, Worktree: id}
		}
		return Route{Class: Ignore}
	case rel == "refs" || strings.HasPrefix(rel, "refs/") || rel == "packed-refs":
		return Route{Class: RefsEvent}
	case isStateFile(rel):
		if r.hasMain {
			return Route{Class: WorktreeRefEvent, Worktree: r.main}
		}
	}
	return Route{Class: Ignore}
}

func isStateFile(rel string) bool {
	if stateFiles[rel] {
		return true
	}
	for _, d := range []string{"rebase-merge", "rebase-apply"} {
		if rel == d || strings.HasPrefix(rel, d+"/") {
			return true
		}
	}
	return false
}

// under reports whether p is root or inside it, and returns the slash-separated
// remainder ("" when p == root). The match must end at a separator boundary.
func under(p, root string) (string, bool) {
	if p == root {
		return "", true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	if !strings.HasPrefix(p, prefix) {
		return "", false
	}
	return filepath.ToSlash(p[len(prefix):]), true
}
