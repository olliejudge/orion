package gitx

import (
	"strconv"
	"testing"

	"github.com/olliejudge/orion/internal/testrepo"
)

// commitTime returns the unix seconds of sha's committer date, straight from
// git, so tests don't hardcode the testrepo clock's epoch or step.
func commitTime(t *testing.T, r *testrepo.Repo, sha string) int64 {
	t.Helper()
	out := r.Git("log", "-1", "--format=%ct", sha)
	n, err := strconv.ParseInt(out, 10, 64)
	if err != nil {
		t.Fatalf("parse committer time %q: %v", out, err)
	}
	return n
}

func TestLogTouchedLatestPerPath(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a1")
	r.Write("b.txt", "b1")
	r.Add()
	c1 := r.Commit("c1")

	r.Write("a.txt", "a2") // a.txt touched again, more recently than b.txt
	r.Add()
	c2 := r.Commit("c2")

	got, err := LogTouched(ctx, Runner{}, r.Path(), "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{"a.txt": commitTime(t, r, c2), "b.txt": commitTime(t, r, c1)}
	assertTouched(t, got, want)
}

func TestLogTouchedRange(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a1")
	r.Add()
	old := r.Commit("c1")

	r.Write("b.txt", "b1")
	r.Add()
	c2 := r.Commit("c2")
	r.Write("a.txt", "a2")
	r.Add()
	c3 := r.Commit("c3")

	got, err := LogTouched(ctx, Runner{}, r.Path(), old+"..HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{"a.txt": commitTime(t, r, c3), "b.txt": commitTime(t, r, c2)}
	assertTouched(t, got, want)
}

func TestLogTouchedNoRenameTracking(t *testing.T) {
	r := testrepo.New(t)
	r.Write("old.txt", "content")
	r.Add()
	r.Commit("add old")
	r.GitMv("old.txt", "new.txt")
	c2 := r.Commit("rename")

	got, err := LogTouched(ctx, Runner{}, r.Path(), "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	// --no-renames: the rename commit touches new.txt only; old.txt keeps its
	// own (earlier) time under its own name.
	if _, ok := got["old.txt"]; !ok {
		t.Fatalf("got %v, want old.txt still present under its old name", got)
	}
	want := commitTime(t, r, c2)
	if got["new.txt"] != want {
		t.Fatalf("new.txt = %d, want %d", got["new.txt"], want)
	}
}

func TestLogTouchedStopsOnceWantIsSatisfied(t *testing.T) {
	r := testrepo.New(t)
	for i := 0; i < 50; i++ {
		r.Write("noise.txt", string(rune('a'+i%26)))
		r.Add()
		r.Commit("noise")
	}
	r.Write("a.txt", "a") // touched by the newest commit: an early stop reads none of the noise
	r.Add()
	head := r.Commit("c-last")

	got, err := LogTouched(ctx, Runner{}, r.Path(), "HEAD", map[string]bool{"a.txt": true})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{"a.txt": commitTime(t, r, head)}
	assertTouched(t, got, want)
}

func TestLogTouchedEmptyWantSkipsTheWalk(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	r.Commit("c1")

	got, err := LogTouched(ctx, Runner{}, r.Path(), "HEAD", map[string]bool{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestLogTouchedMergeCommitTouchesNoPaths(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	r.Commit("c1")
	r.Branch("feature")
	r.Checkout("feature")
	r.Write("b.txt", "b")
	r.Add()
	r.Commit("c2")
	r.Checkout("main")
	r.Merge("feature")

	got, err := LogTouched(ctx, Runner{}, r.Path(), "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got["a.txt"]; !ok {
		t.Fatalf("got %v, want a.txt present", got)
	}
	if _, ok := got["b.txt"]; !ok {
		t.Fatalf("got %v, want b.txt present", got)
	}
}

func assertTouched(t *testing.T, got, want map[string]int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for p, ts := range want {
		if got[p] != ts {
			t.Errorf("%q = %d, want %d", p, got[p], ts)
		}
	}
}
