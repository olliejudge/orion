package gitx

import (
	"strings"
	"testing"

	"github.com/olliejudge/orion/internal/testrepo"
)

// awkwardNames are file names that break naive, newline-separated parsing.
var awkwardNames = []string{
	"with space.txt",
	"ünïcødé ✓.md",
	`quote"d.txt`,
	"'single'.txt",
	"-leading-dash.txt",
	"new\nline.txt",
	"tab\tname.txt",
	`back\slash.txt`,
	"dir with space/nested file.txt",
}

func TestLsTree(t *testing.T) {
	r := testrepo.New(t)
	r.Write("README.md", "hello\n")
	r.Write("src/app/main.go", strings.Repeat("x", 1234))
	r.Write("empty.txt", "")
	r.Add()
	sub := r.Commit("files")
	// A submodule is a "commit" entry in the tree; it has no blob size.
	r.Git("update-index", "--add", "--cacheinfo", "160000,"+sub+",vendor/lib")
	head := r.Commit("add submodule entry")

	got, err := LsTree(ctx, Runner{}, r.Path(), head)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{"README.md": 6, "src/app/main.go": 1234, "empty.txt": 0, "vendor/lib": 0}
	assertEntries(t, got, want)
}

func TestLsTreeFromSubdirListsWholeTree(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Write("sub/b.txt", "bb")
	r.Add()
	head := r.Commit("files")
	got, err := LsTree(ctx, Runner{}, r.Path()+"/sub", head)
	if err != nil {
		t.Fatal(err)
	}
	assertEntries(t, got, map[string]int64{"a.txt": 1, "sub/b.txt": 2})
}

func TestLsTreeEmptyRev(t *testing.T) {
	got, err := LsTree(ctx, Runner{}, t.TempDir(), "")
	if err != nil || got != nil {
		t.Fatalf("LsTree(\"\") = %v, %v; want nil, nil", got, err)
	}
}

func TestLsTreeAwkwardPaths(t *testing.T) {
	r := testrepo.New(t)
	want := map[string]int64{}
	for i, name := range awkwardNames {
		content := strings.Repeat("z", i+1)
		r.Write(name, content)
		want[name] = int64(len(content))
	}
	r.Add()
	head := r.Commit("awkward names")
	got, err := LsTree(ctx, Runner{}, r.Path(), head)
	if err != nil {
		t.Fatal(err)
	}
	assertEntries(t, got, want)
}

func assertEntries(t *testing.T, got []FileEntry, want map[string]int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d entries %+v, want %d", len(got), got, len(want))
	}
	for _, e := range got {
		size, ok := want[e.Path]
		if !ok {
			t.Errorf("unexpected path %q", e.Path)
			continue
		}
		if e.Size != size {
			t.Errorf("%q size = %d, want %d", e.Path, e.Size, size)
		}
	}
}
