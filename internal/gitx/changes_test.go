package gitx

import (
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/olliejudge/orion/internal/testrepo"
)

func sorted(cs []Change) []Change {
	out := slices.Clone(cs)
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func assertChanges(t *testing.T, got, want []Change) {
	t.Helper()
	got, want = sorted(got), sorted(want)
	if !slices.Equal(got, want) {
		t.Fatalf("changes mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestDiffNameStatus(t *testing.T) {
	r := testrepo.New(t)
	r.Write("keep.txt", "keep")
	r.Write("edit.txt", "v1")
	r.Write("gone.txt", "bye")
	r.Write("old/name.txt", "a file that will be renamed, long enough to match")
	r.Add()
	base := r.Commit("base")

	r.Write("edit.txt", "v2")
	r.Remove("gone.txt")
	r.GitMv("old/name.txt", "new/name.txt")
	r.Write("added.txt", "new")
	r.Add()
	head := r.Commit("changes")

	got, err := DiffNameStatus(ctx, Runner{}, r.Path(), base, head)
	if err != nil {
		t.Fatal(err)
	}
	assertChanges(t, got, []Change{
		{Path: "edit.txt", Kind: Modified},
		{Path: "gone.txt", Kind: Deleted},
		{Path: "new/name.txt", From: "old/name.txt", Kind: Renamed},
		{Path: "added.txt", Kind: Added},
	})

	// from == "" diffs against the empty tree: everything is added.
	got, err = DiffNameStatus(ctx, Runner{}, r.Path(), "", base)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("diff from empty tree = %q", got)
	}
	for _, c := range got {
		if c.Kind != Added {
			t.Fatalf("diff from empty tree: %q is %s, want added", c.Path, c.Kind)
		}
	}
}

func TestParseNameStatus(t *testing.T) {
	raw := "M\x00a.txt\x00T\x00link\x00R087\x00from x\x00to\ny\x00C100\x00src.go\x00copy.go\x00D\x00-dash\x00A\x00ünï\x00U\x00conflict\x00"
	assertChanges(t, parseNameStatus([]byte(raw)), []Change{
		{Path: "a.txt", Kind: Modified},
		{Path: "link", Kind: Modified},
		{Path: "to\ny", From: "from x", Kind: Renamed},
		{Path: "copy.go", Kind: Added},
		{Path: "-dash", Kind: Deleted},
		{Path: "ünï", Kind: Added},
		{Path: "conflict", Kind: Modified},
	})
}

func TestStatus(t *testing.T) {
	r := testrepo.New(t)
	r.Write("staged-mod.txt", "v1")
	r.Write("unstaged-mod.txt", "v1")
	r.Write("deleted.txt", "bye")
	r.Write("staged-del.txt", "bye")
	r.Write("rename-me.txt", "same content for rename detection")
	r.Add()
	r.Commit("base")

	r.Write("staged-mod.txt", "v2")
	r.Add("staged-mod.txt")
	r.Write("unstaged-mod.txt", "v2")
	r.Remove("deleted.txt")
	r.Git("rm", "--quiet", "staged-del.txt")
	r.GitMv("rename-me.txt", "renamed.txt")
	r.Write("staged-new.txt", "n")
	r.Add("staged-new.txt")
	r.Write("untracked/deep/file.txt", "u")
	r.Write("added-then-deleted.txt", "x")
	r.Add("added-then-deleted.txt")
	r.Remove("added-then-deleted.txt")
	r.Write("intent-to-add.txt", "i")
	r.Git("add", "-N", "intent-to-add.txt")

	got, err := Status(ctx, Runner{}, r.Path())
	if err != nil {
		t.Fatal(err)
	}
	assertChanges(t, got, []Change{
		{Path: "staged-mod.txt", Kind: Modified},
		{Path: "unstaged-mod.txt", Kind: Modified},
		{Path: "deleted.txt", Kind: Deleted},
		{Path: "staged-del.txt", Kind: Deleted},
		{Path: "renamed.txt", From: "rename-me.txt", Kind: Renamed},
		{Path: "staged-new.txt", Kind: Added},
		{Path: "untracked/deep/file.txt", Kind: Added},
		{Path: "intent-to-add.txt", Kind: Added},
	})
}

func TestStatusUnmergedIsModified(t *testing.T) {
	r := testrepo.New(t)
	r.Write("f.txt", "base\n")
	r.Add()
	r.Commit("base")
	r.Branch("other")
	r.Write("f.txt", "main\n")
	r.Add()
	r.Commit("main side")
	r.Checkout("other")
	r.Write("f.txt", "other\n")
	r.Add()
	r.Commit("other side")
	r.Checkout("main")
	if _, err := (Runner{}).Run(ctx, r.Path(), "-c", "user.name=T", "-c", "user.email=t@example.com", "merge", "other"); err == nil {
		t.Fatal("expected a merge conflict")
	}
	got, err := Status(ctx, Runner{}, r.Path())
	if err != nil {
		t.Fatal(err)
	}
	assertChanges(t, got, []Change{{Path: "f.txt", Kind: Modified}})
}

func TestParseStatusCaptured(t *testing.T) {
	sha := strings.Repeat("a", 40)
	zero := strings.Repeat("0", 40)
	raw := strings.Join([]string{
		"# branch.oid " + sha,
		"# branch.head main",
		"1 .M N... 100644 100644 100644 " + sha + " " + sha + " mod with space.txt",
		"1 A. N... 000000 100644 100644 " + sha + " " + sha + " new\nline.txt",
		"1 .D N... 100644 100644 000000 " + sha + " " + sha + " gone.txt",
		"1 AD N... 000000 100644 000000 " + sha + " " + sha + " transient.txt",
		"1 .A N... 000000 000000 100644 " + zero + " " + zero + " intent.txt",
		"2 R. N... 100644 100644 100644 " + sha + " " + sha + " R100 to dir/b.txt",
		"from a.txt",
		"2 RD N... 100644 100644 000000 " + sha + " " + sha + " R100 moved-then-deleted.txt",
		"orig.txt",
		"u UU N... 100644 100644 100644 100644 " + sha + " " + sha + " " + sha + " conflict.txt",
		"u DU N... 100644 000000 100644 100644 " + sha + " " + zero + " " + sha + " deleted-by-us.txt",
		"u DD N... 100644 000000 000000 000000 " + sha + " " + zero + " " + zero + " both-deleted.txt",
		"? untracked/-dash.txt",
		"? nested/worktree/",
		"! ignored.log",
		"",
	}, "\x00")
	assertChanges(t, parseStatus([]byte(raw)), []Change{
		{Path: "mod with space.txt", Kind: Modified},
		{Path: "new\nline.txt", Kind: Added},
		{Path: "gone.txt", Kind: Deleted},
		{Path: "to dir/b.txt", From: "from a.txt", Kind: Renamed},
		{Path: "orig.txt", Kind: Deleted},
		{Path: "conflict.txt", Kind: Modified},
		{Path: "intent.txt", Kind: Added},
		{Path: "deleted-by-us.txt", Kind: Added},
		{Path: "both-deleted.txt", Kind: Modified},
		{Path: "untracked/-dash.txt", Kind: Added},
	})
}

// A malformed rename record must still consume its origPath field, or that
// path is parsed as the next record.
func TestParseStatusMalformedRenameStaysInSync(t *testing.T) {
	sha := strings.Repeat("a", 40)
	raw := strings.Join([]string{
		"2 R. N... truncated",
		"1 .M N... 100644 100644 100644 " + sha + " " + sha + " orig-looks-like-a-record.txt",
		"? real.txt",
		"",
	}, "\x00")
	assertChanges(t, parseStatus([]byte(raw)), []Change{{Path: "real.txt", Kind: Added}})
}

func TestStatusDropsNestedWorktreeDir(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	r.Commit("base")
	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")
	nested.Write("agent-file.txt", "work in progress")
	nested.Write("a.txt", "edited by agent")
	r.Write(".claude/settings.json", "{}") // a real untracked file next to the worktrees dir

	mainChanges, err := Status(ctx, Runner{}, r.Path())
	if err != nil {
		t.Fatal(err)
	}
	assertChanges(t, mainChanges, []Change{{Path: ".claude/settings.json", Kind: Added}})

	nestedChanges, err := Status(ctx, Runner{}, nested.Path())
	if err != nil {
		t.Fatal(err)
	}
	assertChanges(t, nestedChanges, []Change{
		{Path: "agent-file.txt", Kind: Added},
		{Path: "a.txt", Kind: Modified},
	})
}

func TestStatusAwkwardPaths(t *testing.T) {
	r := testrepo.New(t)
	r.Write("tracked one.txt", "rename me please, enough content to match")
	r.Write(`edit "me".txt`, "v1")
	r.Add()
	r.Commit("base")

	r.GitMv("tracked one.txt", "renamed\nnew line ✓.txt")
	r.Write(`edit "me".txt`, "v2")
	want := []Change{
		{Path: "renamed\nnew line ✓.txt", From: "tracked one.txt", Kind: Renamed},
		{Path: `edit "me".txt`, Kind: Modified},
	}
	for _, name := range awkwardNames {
		r.Write(name, "x")
		want = append(want, Change{Path: name, Kind: Added})
	}

	got, err := Status(ctx, Runner{}, r.Path())
	if err != nil {
		t.Fatal(err)
	}
	assertChanges(t, got, want)
}

func TestPairMoves(t *testing.T) {
	tests := []struct {
		name string
		in   []Change
		want []Change
	}{
		{
			name: "plain mv becomes rename at the added position",
			in: []Change{
				{Path: "a.txt", Kind: Modified},
				{Path: "src/old/util.go", Kind: Deleted},
				{Path: "src/new/util.go", Kind: Added},
			},
			want: []Change{
				{Path: "a.txt", Kind: Modified},
				{Path: "src/new/util.go", From: "src/old/util.go", Kind: Renamed},
			},
		},
		{
			name: "rename replaces the added entry, not the deleted one",
			in: []Change{
				{Path: "x/u.go", Kind: Deleted},
				{Path: "m.txt", Kind: Modified},
				{Path: "y/u.go", Kind: Added},
			},
			want: []Change{
				{Path: "m.txt", Kind: Modified},
				{Path: "y/u.go", From: "x/u.go", Kind: Renamed},
			},
		},
		{
			name: "two moves with distinct basenames pair independently",
			in: []Change{
				{Path: "a/one.go", Kind: Deleted},
				{Path: "a/two.go", Kind: Deleted},
				{Path: "b/two.go", Kind: Added},
				{Path: "b/one.go", Kind: Added},
			},
			want: []Change{
				{Path: "b/two.go", From: "a/two.go", Kind: Renamed},
				{Path: "b/one.go", From: "a/one.go", Kind: Renamed},
			},
		},
		{
			name: "ambiguous basenames stay unpaired",
			in: []Change{
				{Path: "a/index.ts", Kind: Deleted},
				{Path: "b/index.ts", Kind: Deleted},
				{Path: "c/index.ts", Kind: Added},
			},
			want: []Change{
				{Path: "a/index.ts", Kind: Deleted},
				{Path: "b/index.ts", Kind: Deleted},
				{Path: "c/index.ts", Kind: Added},
			},
		},
		{
			name: "different basenames stay unpaired",
			in: []Change{
				{Path: "x.txt", Kind: Deleted},
				{Path: "y.txt", Kind: Added},
			},
			want: []Change{
				{Path: "x.txt", Kind: Deleted},
				{Path: "y.txt", Kind: Added},
			},
		},
		{
			name: "existing renames and modifications untouched",
			in: []Change{
				{Path: "n.txt", From: "o.txt", Kind: Renamed},
				{Path: "m.txt", Kind: Modified},
			},
			want: []Change{
				{Path: "n.txt", From: "o.txt", Kind: Renamed},
				{Path: "m.txt", Kind: Modified},
			},
		},
		{name: "empty", in: nil, want: []Change{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := PairMoves(tt.in)
			if !slices.Equal(got, tt.want) {
				t.Fatalf("PairMoves = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPairMovesWithRealPlainMv(t *testing.T) {
	r := testrepo.New(t)
	r.Write("docs/guide.md", "guide")
	r.Add()
	r.Commit("base")
	r.Move("docs/guide.md", filepath.Join("handbook", "guide.md"))

	raw, err := Status(ctx, Runner{}, r.Path())
	if err != nil {
		t.Fatal(err)
	}
	assertChanges(t, raw, []Change{
		{Path: "docs/guide.md", Kind: Deleted},
		{Path: "handbook/guide.md", Kind: Added},
	})
	assertChanges(t, PairMoves(raw), []Change{
		{Path: "handbook/guide.md", From: "docs/guide.md", Kind: Renamed},
	})
}
