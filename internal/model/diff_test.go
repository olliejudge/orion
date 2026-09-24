package model

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)

func at(sec float64) time.Time { return t0.Add(time.Duration(sec * float64(time.Second))) }

var (
	mainWT  = Worktree{ID: IDFor("/repo"), Path: "/repo", Label: "main", Branch: "main", Head: "h1", IsMain: true}
	agentWT = Worktree{ID: IDFor("/repo/.claude/worktrees/a"), Path: "/repo/.claude/worktrees/a", Label: "agent-a", Branch: "agent-a", Head: "h1"}
	mainID  = mainWT.ID
	agentID = agentWT.ID
)

type overlays = map[WorktreeID]map[string]ChangeEntry

func unc(path string, kind Kind, size int64) ChangeEntry {
	return ChangeEntry{Path: path, Kind: kind, Stage: Uncommitted, Size: size}
}

func com(path string, kind Kind, size int64) ChangeEntry {
	return ChangeEntry{Path: path, Kind: kind, Stage: Committed, Size: size}
}

func entries(es ...ChangeEntry) map[string]ChangeEntry {
	m := map[string]ChangeEntry{}
	for _, e := range es {
		m[e.Path] = e
	}
	return m
}

func st(baseSha string, tree map[string]int64, wts []Worktree, ov overlays) State {
	return State{Repo: RepoInfo{Name: "repo", Base: "main", BaseSha: baseSha}, Worktrees: wts, Tree: tree, Overlays: ov}
}

func withHead(w Worktree, head, subject string) Worktree {
	w.Head, w.HeadSubject = head, subject
	return w
}

func TestNewStoreSnapshot(t *testing.T) {
	idle := Worktree{ID: IDFor("/idle"), Path: "/idle", Label: "idle", Branch: "idle", Head: "h1"}
	s := NewStore(st("b1", map[string]int64{"z.go": 3, "a.go": 1, "m/k.go": 2},
		[]Worktree{idle, agentWT, mainWT},
		overlays{agentID: entries(unc("z.go", Modified, 4), unc("b.go", Added, 1)), idle.ID: {}}), t0)

	snap := s.Snapshot()
	if snap.Type != "snapshot" || snap.Seq != 1 {
		t.Fatalf("type/seq = %q/%d, want snapshot/1", snap.Type, snap.Seq)
	}
	gotPaths := []string{}
	for _, w := range snap.Worktrees {
		gotPaths = append(gotPaths, fmt.Sprintf("%s:%d", w.Path, w.ColorIndex))
	}
	if want := []string{"/repo:0", "/idle:-1", "/repo/.claude/worktrees/a:1"}; !reflect.DeepEqual(gotPaths, want) {
		t.Fatalf("worktrees = %v, want %v (main first, then by path; colours)", gotPaths, want)
	}
	if want := []File{{"a.go", 1}, {"m/k.go", 2}, {"z.go", 3}}; !reflect.DeepEqual(snap.Tree, want) {
		t.Fatalf("tree = %v, want %v", snap.Tree, want)
	}
	if len(snap.Overlays) != 1 {
		t.Fatalf("overlays = %v, want only the non-empty agent overlay", snap.Overlays)
	}
	if got := snap.Overlays[agentID]; len(got) != 2 || got[0].Path != "b.go" || got[1].Path != "z.go" {
		t.Fatalf("agent overlay not sorted by path: %v", got)
	}
	if snap.Activity == nil || len(snap.Activity) != 0 {
		t.Fatalf("activity = %#v, want empty non-nil", snap.Activity)
	}
}

func TestApplyNoChange(t *testing.T) {
	s0 := st("b1", map[string]int64{"a.go": 1}, []Worktree{mainWT}, overlays{mainID: entries(unc("a.go", Modified, 2))})
	s := NewStore(s0, t0)
	if p, changed := s.Apply(s0, at(1)); changed {
		t.Fatalf("identical state produced a patch: %+v", p)
	}
	if s.Snapshot().Seq != 1 {
		t.Fatal("seq advanced without a change")
	}
	next := st("b1", map[string]int64{"a.go": 1}, []Worktree{mainWT}, overlays{mainID: entries(unc("a.go", Modified, 3))})
	p, changed := s.Apply(next, at(2))
	if !changed || p.Type != "patch" || p.Seq != 2 {
		t.Fatalf("patch = %+v changed=%v, want type patch seq 2", p, changed)
	}
	if s.Snapshot().Seq != 2 {
		t.Fatal("snapshot seq did not follow the patch")
	}
}

func TestApplyBaseDiff(t *testing.T) {
	s := NewStore(st("b1", map[string]int64{"a.go": 1, "b.go": 2, "c.go": 3}, []Worktree{mainWT}, nil), t0)
	p, changed := s.Apply(st("b2", map[string]int64{"a.go": 1, "b.go": 5, "d.go": 4}, []Worktree{mainWT}, nil), at(1))
	if !changed || p.Base == nil {
		t.Fatalf("want a base patch, got %+v", p)
	}
	want := &BasePatch{Sha: "b2", Upsert: []File{{"b.go", 5}, {"d.go", 4}}, Remove: []string{"c.go"}}
	if !reflect.DeepEqual(p.Base, want) {
		t.Fatalf("base = %+v, want %+v", p.Base, want)
	}

	// A new base sha with an identical tree still announces the sha.
	p, changed = s.Apply(st("b3", map[string]int64{"a.go": 1, "b.go": 5, "d.go": 4}, []Worktree{mainWT}, nil), at(2))
	want = &BasePatch{Sha: "b3", Upsert: []File{}, Remove: []string{}}
	if !changed || !reflect.DeepEqual(p.Base, want) {
		t.Fatalf("base = %+v, want %+v", p.Base, want)
	}
	if p.Overlays != nil || p.Worktrees != nil {
		t.Fatalf("unexpected extra fields: %+v", p)
	}
}

func TestApplyOverlayDiff(t *testing.T) {
	wts := []Worktree{mainWT, agentWT}
	s := NewStore(st("b1", nil, wts, overlays{
		agentID: entries(unc("x.go", Added, 1), unc("y.go", Modified, 2)),
		mainID:  entries(unc("m.go", Modified, 1)),
	}), t0)

	p, _ := s.Apply(st("b1", nil, wts, overlays{
		agentID: entries(unc("x.go", Added, 3), unc("z.go", Deleted, 0)),
		mainID:  entries(unc("m.go", Modified, 1)),
	}), at(1))
	want := map[WorktreeID]OverlayPatch{agentID: {
		Upsert: []ChangeEntry{unc("x.go", Added, 3), unc("z.go", Deleted, 0)},
		Remove: []string{"y.go"},
	}}
	if !reflect.DeepEqual(p.Overlays, want) {
		t.Fatalf("overlays = %+v, want %+v", p.Overlays, want)
	}

	// The agent worktree disappears: all its paths are removed and the list is resent.
	p, _ = s.Apply(st("b1", nil, []Worktree{mainWT}, overlays{mainID: entries(unc("m.go", Modified, 1))}), at(2))
	want = map[WorktreeID]OverlayPatch{agentID: {Upsert: []ChangeEntry{}, Remove: []string{"x.go", "z.go"}}}
	if !reflect.DeepEqual(p.Overlays, want) {
		t.Fatalf("overlays after removal = %+v, want %+v", p.Overlays, want)
	}
	if len(p.Worktrees) != 1 || p.Worktrees[0].ID != mainID {
		t.Fatalf("worktrees = %+v, want only main", p.Worktrees)
	}
	b, _ := json.Marshal(p)
	if !strings.Contains(string(b), `"upsert":[]`) {
		t.Fatalf("empty upsert must marshal as [], got %s", b)
	}
}

func TestApplyWorktreesDiff(t *testing.T) {
	s := NewStore(st("b1", nil, []Worktree{mainWT, agentWT}, nil), t0)

	locked := agentWT
	locked.Locked = true
	p, changed := s.Apply(st("b1", nil, []Worktree{mainWT, locked}, nil), at(1))
	if !changed || len(p.Worktrees) != 2 || !p.Worktrees[1].Locked {
		t.Fatalf("lock change: patch = %+v", p)
	}

	// HeadSubject is not on the wire, so it alone never produces a patch.
	quiet := locked
	quiet.HeadSubject = "something"
	if p, changed := s.Apply(st("b1", nil, []Worktree{mainWT, quiet}, nil), at(2)); changed {
		t.Fatalf("HeadSubject-only change produced %+v", p)
	}

	// Becoming active assigns a colour, which changes the list.
	p, _ = s.Apply(st("b1", nil, []Worktree{mainWT, quiet}, overlays{agentID: entries(unc("f.go", Added, 1))}), at(3))
	if len(p.Worktrees) != 2 || p.Worktrees[1].ColorIndex != 1 {
		t.Fatalf("colour assignment not sent: %+v", p.Worktrees)
	}
}

func TestApplyDoesNotMutateInput(t *testing.T) {
	s := NewStore(st("b1", nil, []Worktree{mainWT}, nil), t0)
	wts := []Worktree{agentWT, mainWT}
	s.Apply(st("b1", nil, wts, overlays{agentID: entries(unc("f.go", Added, 1))}), at(1))
	if wts[0].ID != agentID || wts[0].ColorIndex != 0 {
		t.Fatalf("caller's slice was reordered or mutated: %+v", wts)
	}
}

func TestActivity(t *testing.T) {
	agentH2 := withHead(agentWT, "h2", "feat: add parser")
	tests := []struct {
		name       string
		prev, next State
		want       []Activity
	}{
		{
			name: "uncommitted added, deleted, renamed",
			prev: st("b1", nil, []Worktree{mainWT, agentWT}, nil),
			next: st("b1", nil, []Worktree{mainWT, agentWT}, overlays{agentID: entries(
				unc("new.go", Added, 5),
				unc("old.go", Deleted, 0),
				ChangeEntry{Path: "to.go", From: "from.go", Kind: Renamed, Stage: Uncommitted, Size: 2},
			)}),
			want: []Activity{
				{Worktree: agentID, Kind: "added", Path: "new.go"},
				{Worktree: agentID, Kind: "deleted", Path: "old.go"},
				{Worktree: agentID, Kind: "renamed", Path: "to.go", From: "from.go"},
			},
		},
		{
			name: "size change of a modified file",
			prev: st("b1", nil, []Worktree{mainWT}, overlays{mainID: entries(unc("a.go", Modified, 1))}),
			next: st("b1", nil, []Worktree{mainWT}, overlays{mainID: entries(unc("a.go", Modified, 9))}),
			want: []Activity{{Worktree: mainID, Kind: "modified", Path: "a.go"}},
		},
		{
			name: "editing an untracked file reads as modified",
			prev: st("b1", nil, []Worktree{mainWT}, overlays{mainID: entries(unc("n.go", Added, 1))}),
			next: st("b1", nil, []Worktree{mainWT}, overlays{mainID: entries(unc("n.go", Added, 7))}),
			want: []Activity{{Worktree: mainID, Kind: "modified", Path: "n.go"}},
		},
		{
			name: "unchanged entries are quiet",
			prev: st("b1", nil, []Worktree{mainWT}, overlays{mainID: entries(unc("a.go", Modified, 1))}),
			next: st("b1", map[string]int64{"x": 1}, []Worktree{mainWT}, overlays{mainID: entries(unc("a.go", Modified, 1))}),
			want: nil,
		},
		{
			name: "commit turns uncommitted entries committed",
			prev: st("b1", nil, []Worktree{mainWT, agentWT}, overlays{agentID: entries(
				unc("a.go", Modified, 1), unc("b.go", Added, 2), unc("wip.go", Added, 3))}),
			next: st("b1", nil, []Worktree{mainWT, agentH2}, overlays{agentID: entries(
				com("a.go", Modified, 1), com("b.go", Added, 2), unc("wip.go", Added, 3))}),
			want: []Activity{{Worktree: agentID, Kind: "commit", Sha: "h2", Subject: "feat: add parser", Files: 2}},
		},
		{
			name: "commit counts committed entries that are new to the overlay",
			prev: st("b1", nil, []Worktree{mainWT, agentWT}, nil),
			next: st("b1", nil, []Worktree{mainWT, agentH2}, overlays{agentID: entries(com("c.go", Added, 2))}),
			want: []Activity{{Worktree: agentID, Kind: "commit", Sha: "h2", Subject: "feat: add parser", Files: 1}},
		},
		{
			name: "checkout of another branch is not a commit",
			prev: st("b1", nil, []Worktree{mainWT, agentWT}, nil),
			next: st("b1", nil, []Worktree{mainWT, func() Worktree { w := agentH2; w.Branch, w.Label = "other", "other"; return w }()},
				overlays{agentID: entries(com("c.go", Added, 2))}),
			want: nil,
		},
		{
			name: "a newly discovered worktree with committed work is not a commit",
			prev: st("b1", nil, []Worktree{mainWT}, nil),
			next: st("b1", nil, []Worktree{mainWT, agentH2}, overlays{agentID: entries(com("c.go", Added, 2))}),
			want: nil,
		},
		{
			name: "base advancing past committed work is a merge",
			prev: st("b1", nil, []Worktree{mainWT, agentH2}, overlays{agentID: entries(
				com("a.go", Modified, 1), com("b.go", Added, 2))}),
			next: st("b2", map[string]int64{"a.go": 1, "b.go": 2}, []Worktree{mainWT, agentH2}, nil),
			want: []Activity{{Worktree: agentID, Kind: "merge", Sha: "b2", Files: 2}},
		},
		{
			// No remote: base is local main, so committing in the main
			// worktree advances the base itself. That is a commit, not a merge.
			name: "a commit in the base branch's own worktree is a commit",
			prev: st("h1", nil, []Worktree{mainWT, agentWT}, overlays{mainID: entries(
				unc("a.go", Modified, 1), unc("b.go", Added, 2), unc("wip.go", Added, 3))}),
			next: st("h2", map[string]int64{"a.go": 1, "b.go": 2}, []Worktree{withHead(mainWT, "h2", "fix: tidy"), agentWT},
				overlays{mainID: entries(unc("wip.go", Added, 3))}),
			want: []Activity{{Worktree: mainID, Kind: "commit", Sha: "h2", Subject: "fix: tidy", Files: 2}},
		},
		{
			name: "merging a branch in the base branch's worktree is a merge for the branch",
			prev: st("h1", nil, []Worktree{mainWT, agentH2}, overlays{agentID: entries(
				com("a.go", Modified, 1), com("b.go", Added, 2))}),
			next: st("h3", map[string]int64{"a.go": 1, "b.go": 2},
				[]Worktree{withHead(mainWT, "h3", "Merge branch 'agent-a'"), agentH2}, nil),
			want: []Activity{{Worktree: agentID, Kind: "merge", Sha: "h3", Files: 2}},
		},
		{
			name: "entries vanishing without a base change are quiet",
			prev: st("b1", nil, []Worktree{mainWT}, overlays{mainID: entries(unc("tmp.go", Added, 1))}),
			next: st("b1", nil, []Worktree{mainWT}, nil),
			want: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewStore(tt.prev, t0)
			p, _ := s.Apply(tt.next, at(1))
			for i := range tt.want {
				tt.want[i].TS = at(1).UnixMilli()
			}
			if !reflect.DeepEqual(p.Activity, tt.want) {
				t.Fatalf("activity\n got: %+v\nwant: %+v", p.Activity, tt.want)
			}
		})
	}
}

func TestModifiedCoalescing(t *testing.T) {
	wts := []Worktree{mainWT}
	s := NewStore(st("b1", nil, wts, nil), t0)
	step := func(sec float64, es ...ChangeEntry) []Activity {
		p, _ := s.Apply(st("b1", nil, wts, overlays{mainID: entries(es...)}), at(sec))
		return p.Activity
	}
	kinds := func(as []Activity) string {
		var out []string
		for _, a := range as {
			out = append(out, a.Kind+":"+a.Path)
		}
		return strings.Join(out, ",")
	}

	if got := kinds(step(1, unc("a.go", Modified, 1))); got != "modified:a.go" {
		t.Fatalf("t=1: %q", got)
	}
	if got := kinds(step(3, unc("a.go", Modified, 2))); got != "" {
		t.Fatalf("t=3 within 5s of the last row: %q, want suppressed", got)
	}
	if got := kinds(step(4, unc("a.go", Modified, 3), unc("b.go", Added, 1))); got != "added:b.go" {
		t.Fatalf("t=4: %q, want only b.go", got)
	}
	if got := kinds(step(5, unc("a.go", Modified, 3), unc("b.go", Added, 2))); got != "" {
		t.Fatalf("t=5 edit right after add: %q, want suppressed", got)
	}
	if got := kinds(step(6.5, unc("a.go", Modified, 4), unc("b.go", Added, 2))); got != "modified:a.go" {
		t.Fatalf("t=6.5 (5.5s after the last a.go row): %q", got)
	}
	// Deletions are never coalesced away.
	if got := kinds(step(7, unc("a.go", Deleted, 0), unc("b.go", Added, 2))); got != "deleted:a.go" {
		t.Fatalf("t=7: %q", got)
	}
}

func TestActivityRingLimit(t *testing.T) {
	wts := []Worktree{mainWT}
	s := NewStore(st("b1", nil, wts, nil), t0)
	ov := map[string]ChangeEntry{}
	for i := range 250 {
		p := fmt.Sprintf("f%03d.go", i)
		ov[p] = unc(p, Added, 1)
		next := map[string]ChangeEntry{}
		for k, v := range ov {
			next[k] = v
		}
		s.Apply(st("b1", nil, wts, overlays{mainID: next}), at(float64(i)))
	}
	act := s.Snapshot().Activity
	if len(act) != 200 {
		t.Fatalf("activity length = %d, want 200", len(act))
	}
	if act[0].Path != "f050.go" || act[199].Path != "f249.go" {
		t.Fatalf("ring kept %s..%s, want f050.go..f249.go (oldest first)", act[0].Path, act[199].Path)
	}
}
