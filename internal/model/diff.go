package model

import (
	"cmp"
	"maps"
	"slices"
	"sync"
	"time"
)

const (
	activityLimit  = 200
	coalesceWindow = 5 * time.Second
)

type pathKey struct {
	wt   WorktreeID
	path string
}

// Store owns the current State, the patch sequence number, the activity
// ring, colour assignment and the coalescing index. It is safe for
// concurrent use.
type Store struct {
	mu       sync.Mutex
	state    State
	seq      uint64
	activity []Activity
	colors   *colorAssigner
	lastRow  map[pathKey]time.Time // last file activity per worktree+path
}

// NewStore starts at seq 1 with initial as the current state. The main
// worktree gets colour 0; other worktrees with a non-empty overlay get
// colours in list order. The initial state produces no activity.
func NewStore(initial State, _ time.Time) *Store {
	s := &Store{seq: 1, colors: newColorAssigner(), lastRow: map[pathKey]time.Time{}, activity: []Activity{}}
	initial = normalize(initial)
	s.assignColors(initial, nil)
	initial.Worktrees = s.withColors(initial.Worktrees)
	s.state = initial
	return s
}

// Apply diffs next against the current state, records next as current and
// returns the patch. It returns false (and does not advance seq) when
// nothing visible changed.
func (s *Store) Apply(next State, now time.Time) (Patch, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	prev := s.state
	next = normalize(next)
	p := Patch{
		Base:     diffBase(prev, next),
		Overlays: diffOverlays(prev.Overlays, next.Overlays),
		Activity: s.deriveActivity(prev, next, now),
	}
	s.assignColors(next, p.Activity)
	next.Worktrees = s.withColors(next.Worktrees)
	if !sameWorktrees(prev.Worktrees, next.Worktrees) {
		p.Worktrees = slices.Clone(next.Worktrees)
	}
	s.state = next

	if p.Worktrees == nil && p.Base == nil && p.Overlays == nil && p.Activity == nil {
		return Patch{}, false
	}
	s.seq++
	p.Type, p.Seq = "patch", s.seq
	s.activity = append(s.activity, p.Activity...)
	if over := len(s.activity) - activityLimit; over > 0 {
		s.activity = slices.Clone(s.activity[over:])
	}
	return p, true
}

// Snapshot returns the full current state in wire form, deterministically sorted.
func (s *Store) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	tree := make([]File, 0, len(s.state.Tree))
	for _, path := range slices.Sorted(maps.Keys(s.state.Tree)) {
		tree = append(tree, File{Path: path, Size: s.state.Tree[path]})
	}
	overlays := map[WorktreeID][]ChangeEntry{}
	for id, m := range s.state.Overlays {
		if len(m) == 0 {
			continue
		}
		es := make([]ChangeEntry, 0, len(m))
		for _, path := range slices.Sorted(maps.Keys(m)) {
			es = append(es, m[path])
		}
		overlays[id] = es
	}
	wts := slices.Clone(s.state.Worktrees)
	if wts == nil {
		wts = []Worktree{}
	}
	return Snapshot{
		Type:      "snapshot",
		Seq:       s.seq,
		Repo:      s.state.Repo,
		Worktrees: wts,
		Tree:      tree,
		Overlays:  overlays,
		Activity:  slices.Clone(s.activity),
	}
}

// State returns the current state (with colours filled in). Its maps are
// shared: callers must not mutate them.
func (s *Store) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.state
	st.Worktrees = slices.Clone(st.Worktrees)
	return st
}

// normalize copies and sorts the worktree list (main first, then by path)
// and replaces nil maps with empty ones. It never mutates the caller's data.
func normalize(st State) State {
	st.Worktrees = slices.Clone(st.Worktrees)
	slices.SortStableFunc(st.Worktrees, func(a, b Worktree) int {
		if a.IsMain != b.IsMain {
			if a.IsMain {
				return -1
			}
			return 1
		}
		return cmp.Compare(a.Path, b.Path)
	})
	if st.Tree == nil {
		st.Tree = map[string]int64{}
	}
	if st.Overlays == nil {
		st.Overlays = map[WorktreeID]map[string]ChangeEntry{}
	}
	return st
}

func sameWorktrees(a, b []Worktree) bool {
	return slices.EqualFunc(a, b, func(x, y Worktree) bool {
		x.HeadSubject, y.HeadSubject = "", "" // not on the wire
		return x == y
	})
}

func diffBase(prev, next State) *BasePatch {
	bp := &BasePatch{Sha: next.Repo.BaseSha, Upsert: []File{}, Remove: []string{}}
	for path, size := range next.Tree {
		if old, ok := prev.Tree[path]; !ok || old != size {
			bp.Upsert = append(bp.Upsert, File{Path: path, Size: size})
		}
	}
	for path := range prev.Tree {
		if _, ok := next.Tree[path]; !ok {
			bp.Remove = append(bp.Remove, path)
		}
	}
	if len(bp.Upsert) == 0 && len(bp.Remove) == 0 && prev.Repo.BaseSha == next.Repo.BaseSha {
		return nil
	}
	slices.SortFunc(bp.Upsert, func(a, b File) int { return cmp.Compare(a.Path, b.Path) })
	slices.Sort(bp.Remove)
	return bp
}

func diffOverlays(prev, next map[WorktreeID]map[string]ChangeEntry) map[WorktreeID]OverlayPatch {
	out := map[WorktreeID]OverlayPatch{}
	ids := map[WorktreeID]bool{}
	for id := range prev {
		ids[id] = true
	}
	for id := range next {
		ids[id] = true
	}
	for id := range ids {
		before, after := prev[id], next[id]
		op := OverlayPatch{Upsert: []ChangeEntry{}, Remove: []string{}}
		for path, e := range after {
			if old, ok := before[path]; !ok || old != e {
				op.Upsert = append(op.Upsert, e)
			}
		}
		for path := range before {
			if _, ok := after[path]; !ok {
				op.Remove = append(op.Remove, path)
			}
		}
		if len(op.Upsert) == 0 && len(op.Remove) == 0 {
			continue
		}
		slices.SortFunc(op.Upsert, func(a, b ChangeEntry) int { return cmp.Compare(a.Path, b.Path) })
		slices.Sort(op.Remove)
		out[id] = op
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// deriveActivity implements spec §5 for every worktree present in next, in
// list order: file rows (by path), then at most one commit row, then at most
// one merge row.
func (s *Store) deriveActivity(prev, next State, now time.Time) []Activity {
	for k, t := range s.lastRow {
		if now.Sub(t) >= coalesceWindow {
			delete(s.lastRow, k)
		}
	}
	prevWT := map[WorktreeID]Worktree{}
	for _, w := range prev.Worktrees {
		prevWT[w.ID] = w
	}
	baseMoved := prev.Repo.BaseSha != next.Repo.BaseSha
	ts := now.UnixMilli()
	var acts []Activity

	for _, wt := range next.Worktrees {
		before, after := prev.Overlays[wt.ID], next.Overlays[wt.ID]
		old, existed := prevWT[wt.ID]
		// A commit moves HEAD but keeps the branch; a checkout changes the branch.
		headMoved := existed && old.Head != wt.Head && old.Branch == wt.Branch
		committed := 0

		for _, path := range slices.Sorted(maps.Keys(after)) {
			e := after[path]
			o, had := before[path]
			switch e.Stage {
			case Uncommitted:
				if had && o == e {
					continue
				}
				kind := string(e.Kind)
				if had && o.Stage == Uncommitted && o.Kind == e.Kind && o.From == e.From {
					kind = string(Modified) // same change, new content: an edit
				}
				key := pathKey{wt.ID, path}
				if last, ok := s.lastRow[key]; ok && kind == string(Modified) && now.Sub(last) < coalesceWindow {
					continue
				}
				s.lastRow[key] = now
				acts = append(acts, Activity{TS: ts, Worktree: wt.ID, Kind: kind, Path: path, From: e.From})
			case Committed:
				if headMoved && (!had || o.Stage == Uncommitted) {
					committed++
				}
			}
		}
		// The worktree is the base branch advancing by its own commit (e.g.
		// base is local main with no remote): its entries leave the overlay
		// because they were committed, not merged.
		ownBase := headMoved && old.Head == prev.Repo.BaseSha && wt.Head == next.Repo.BaseSha
		merged := 0
		if baseMoved {
			for path := range before {
				if _, ok := after[path]; !ok {
					merged++
				}
			}
		}
		if ownBase {
			committed += merged
			merged = 0
		}
		if committed > 0 {
			acts = append(acts, Activity{TS: ts, Worktree: wt.ID, Kind: "commit", Sha: wt.Head, Subject: wt.HeadSubject, Files: committed})
		}
		if merged > 0 {
			acts = append(acts, Activity{TS: ts, Worktree: wt.ID, Kind: "merge", Sha: next.Repo.BaseSha, Files: merged})
		}
	}
	return acts
}

func (s *Store) assignColors(st State, acts []Activity) {
	active := map[WorktreeID]bool{}
	for _, a := range acts {
		active[a.Worktree] = true
	}
	present := map[WorktreeID]bool{}
	for _, wt := range st.Worktrees {
		present[wt.ID] = true
	}
	for _, wt := range st.Worktrees {
		switch {
		case wt.IsMain:
			s.colors.setMain(wt.ID)
		case len(st.Overlays[wt.ID]) > 0 || active[wt.ID]:
			s.colors.assign(wt.ID, present)
		}
	}
}

func (s *Store) withColors(wts []Worktree) []Worktree {
	out := slices.Clone(wts)
	for i := range out {
		out[i].ColorIndex = s.colors.get(out[i].ID)
	}
	return out
}
