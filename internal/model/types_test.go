package model

import (
	"encoding/json"
	"regexp"
	"testing"
)

func TestIDFor(t *testing.T) {
	a := IDFor("/repo")
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(string(a)) {
		t.Fatalf("IDFor = %q, want 16 lowercase hex chars", a)
	}
	if IDFor("/repo") != a {
		t.Fatal("IDFor is not stable")
	}
	if IDFor("/repo/.claude/worktrees/x") == a {
		t.Fatal("different paths gave the same id")
	}
	// Pinned: `printf /repo | shasum -a 256 | cut -c1-16`. Ids must never silently change.
	if want := WorktreeID("816fc349d3faebf8"); a != want {
		t.Fatalf("IDFor(/repo) = %s, want %s", a, want)
	}
}

func TestPatchJSONGolden(t *testing.T) {
	id := WorktreeID("00112233aabbccdd")
	p := Patch{
		Type: "patch",
		Seq:  7,
		Worktrees: []Worktree{{
			ID: id, Path: "/repo", Label: "main", Branch: "main", Head: "abc",
			IsMain: true, ColorIndex: 0, HeadSubject: "never on the wire",
		}},
		Base: &BasePatch{Sha: "def", Upsert: []File{{Path: "a.go", Size: 10}}, Remove: []string{"b.go"}},
		Overlays: map[WorktreeID]OverlayPatch{id: {
			Upsert: []ChangeEntry{{Path: "n.go", Kind: Renamed, From: "o.go", Stage: Uncommitted, Size: 3}},
			Remove: []string{"x.go"},
		}},
		Activity: []Activity{{TS: 1700000000000, Worktree: id, Kind: "commit", Sha: "abc", Subject: "feat: x", Files: 2}},
	}
	want := `{"type":"patch","seq":7,` +
		`"worktrees":[{"id":"00112233aabbccdd","path":"/repo","label":"main","branch":"main","head":"abc","isMain":true,"locked":false,"colorIndex":0}],` +
		`"base":{"sha":"def","upsert":[{"path":"a.go","size":10}],"remove":["b.go"]},` +
		`"overlays":{"00112233aabbccdd":{"upsert":[{"path":"n.go","kind":"renamed","from":"o.go","stage":"uncommitted","size":3}],"remove":["x.go"]}},` +
		`"activity":[{"ts":1700000000000,"worktree":"00112233aabbccdd","kind":"commit","sha":"abc","subject":"feat: x","files":2}]}`
	assertJSON(t, p, want)
	assertJSON(t, Patch{Type: "patch", Seq: 2}, `{"type":"patch","seq":2}`)
}

func TestSnapshotJSONGolden(t *testing.T) {
	s := Snapshot{
		Type:      "snapshot",
		Seq:       1,
		Repo:      RepoInfo{Name: "demo", Base: "main", BaseSha: ""},
		Worktrees: []Worktree{{ID: "aa", Path: "/r", Label: "feature", Head: "", ColorIndex: -1}},
		Tree:      []File{},
		Overlays:  map[WorktreeID][]ChangeEntry{},
		Activity:  []Activity{},
	}
	want := `{"type":"snapshot","seq":1,"repo":{"name":"demo","base":"main","baseSha":""},` +
		`"worktrees":[{"id":"aa","path":"/r","label":"feature","head":"","isMain":false,"locked":false,"colorIndex":-1}],` +
		`"tree":[],"overlays":{},"activity":[]}`
	assertJSON(t, s, want)
}

func assertJSON(t *testing.T, v any, want string) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != want {
		t.Fatalf("JSON mismatch\n got: %s\nwant: %s", b, want)
	}
}
