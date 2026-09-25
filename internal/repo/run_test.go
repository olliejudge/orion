package repo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
	"github.com/olliejudge/orion/internal/watch"
)

// patchLog records every patch an engine broadcasts.
type patchLog struct {
	mu      sync.Mutex
	patches []model.Patch
}

func (l *patchLog) collect(ch <-chan model.Patch) {
	for p := range ch {
		l.mu.Lock()
		l.patches = append(l.patches, p)
		l.mu.Unlock()
	}
}

// caughtUp reports whether the log holds every patch up to seq. By the time
// a Snapshot shows a patch's effect, the patch is in the subscriber channel,
// but collect may not have appended it yet: a test that waits on the
// Snapshot must also wait for caughtUp(snap.Seq) before it inspects patches.
func (l *patchLog) caughtUp(seq uint64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := len(l.patches)
	return seq == 0 || n > 0 && l.patches[n-1].Seq >= seq
}

func (l *patchLog) len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.patches)
}

func (l *patchLog) any(pred func(model.Patch) bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, p := range l.patches {
		if pred(p) {
			return true
		}
	}
	return false
}

func (l *patchLog) activity(pred func(model.Activity) bool) bool {
	return l.any(func(p model.Patch) bool {
		for _, a := range p.Activity {
			if pred(a) {
				return true
			}
		}
		return false
	})
}

// startEngine opens path, subscribes, runs the engine and waits until its
// watchers are live. Everything is torn down at test end.
func startEngine(t *testing.T, path string) (*Engine, *patchLog) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	e, err := Open(ctx, path, "", gitx.Runner{})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	ch, unsub := e.Subscribe()
	pl := &patchLog{}
	go pl.collect(ch)
	done := make(chan error, 1)
	go func() { done <- e.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Run: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Error("Run did not return after cancel")
		}
		unsub()
	})
	select {
	case <-e.ready:
	case err := <-done:
		t.Fatalf("Run exited early: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("engine not ready")
	}
	return e, pl
}

func upserted(p model.Patch, id model.WorktreeID, want func(model.ChangeEntry) bool) bool {
	for _, u := range p.Overlays[id].Upsert {
		if want(u) {
			return true
		}
	}
	return false
}

func snapEntry(e *Engine, id model.WorktreeID, path string) (model.ChangeEntry, bool) {
	for _, c := range e.Snapshot().Overlays[id] {
		if c.Path == path {
			return c, true
		}
	}
	return model.ChangeEntry{}, false
}

func TestEngineLifecycle(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	e, pl := startEngine(t, r.Path())
	id := wtID(wt.Path())

	// 1. uncommitted: a ghost appears
	wt.Write("feature.txt", "hello\n")
	waitFor(t, 10*time.Second, func() bool {
		return pl.any(func(p model.Patch) bool {
			return upserted(p, id, func(c model.ChangeEntry) bool {
				return c.Path == "feature.txt" && c.Kind == model.Added && c.Stage == model.Uncommitted && c.Size == 6
			})
		})
	})

	// 2. committed on the branch
	wt.Add("feature.txt")
	sha := wt.Commit("add feature")
	waitFor(t, 10*time.Second, func() bool {
		return pl.any(func(p model.Patch) bool {
			return upserted(p, id, func(c model.ChangeEntry) bool {
				return c.Path == "feature.txt" && c.Stage == model.Committed
			})
		}) && pl.activity(func(a model.Activity) bool {
			return a.Kind == "commit" && a.Worktree == id && a.Sha == sha && a.Subject == "add feature"
		})
	})

	// 3. merged into base from the main worktree
	r.Merge("feature")
	waitFor(t, 10*time.Second, func() bool {
		removed := pl.any(func(p model.Patch) bool {
			for _, path := range p.Overlays[id].Remove {
				if path == "feature.txt" {
					return true
				}
			}
			return false
		})
		based := pl.any(func(p model.Patch) bool {
			if p.Base == nil {
				return false
			}
			for _, f := range p.Base.Upsert {
				if f.Path == "feature.txt" {
					return true
				}
			}
			return false
		})
		merged := pl.activity(func(a model.Activity) bool { return a.Kind == "merge" && a.Worktree == id })
		return removed && based && merged
	})
	snap := e.Snapshot()
	if len(snap.Overlays[id]) != 0 {
		t.Errorf("feature overlay after merge = %+v, want empty", snap.Overlays[id])
	}
	if len(snap.Overlays[wtID(r.Path())]) != 0 {
		t.Errorf("main overlay after merge = %+v, want empty", snap.Overlays[wtID(r.Path())])
	}
}

func TestEngineNestedWorktree(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")
	e, pl := startEngine(t, r.Path())
	mainID, nid := wtID(r.Path()), wtID(nested.Path())

	nested.Write("src/agent.go", "package agent\n")
	waitFor(t, 10*time.Second, func() bool {
		c, ok := snapEntry(e, nid, "src/agent.go")
		return ok && c.Stage == model.Uncommitted && c.Kind == model.Added
	})
	r.Write("notes.md", "main work\n") // proves main was recomputed after the nested write
	waitFor(t, 10*time.Second, func() bool {
		snap := e.Snapshot()
		for _, c := range snap.Overlays[mainID] {
			if c.Path == "notes.md" {
				return pl.caughtUp(snap.Seq)
			}
		}
		return false
	})

	for _, c := range e.Snapshot().Overlays[mainID] {
		if strings.HasPrefix(c.Path, ".claude/") {
			t.Errorf("main overlay contains nested worktree path %q", c.Path)
		}
	}
	if pl.any(func(p model.Patch) bool {
		return upserted(p, mainID, func(c model.ChangeEntry) bool { return strings.HasPrefix(c.Path, ".claude/") })
	}) {
		t.Error("a patch attributed a nested worktree file to the main worktree")
	}
}

func TestEngineWorktreeRemoved(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "gone"), "gone")
	wt.Write("gone.txt", "bye\n")
	wt.Add("gone.txt")
	wt.Commit("wip")
	e, pl := startEngine(t, r.Path())
	id := wtID(wt.Path())
	if _, ok := snapEntry(e, id, "gone.txt"); !ok {
		t.Fatal("gone.txt missing from the initial overlay")
	}

	r.WorktreeRemove(wt.Path())
	waitFor(t, 10*time.Second, func() bool {
		snap := e.Snapshot()
		for _, w := range snap.Worktrees {
			if w.ID == id {
				return false
			}
		}
		_, has := snap.Overlays[id]
		return !has && pl.caughtUp(snap.Seq)
	})
	if !pl.any(func(p model.Patch) bool {
		if p.Worktrees == nil {
			return false
		}
		for _, w := range p.Worktrees {
			if w.ID == id {
				return false
			}
		}
		return true
	}) {
		t.Error("no patch carried the shrunken worktree list")
	}
	if !pl.any(func(p model.Patch) bool {
		for _, path := range p.Overlays[id].Remove {
			if path == "gone.txt" {
				return true
			}
		}
		return false
	}) {
		t.Error("no patch removed the worktree's overlay entries")
	}
}

func TestEngineWorktreeDirDeleted(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "rm-rf"), "rm-rf")
	wt.Write("x.txt", "x\n")
	e, _ := startEngine(t, r.Path())
	id := wtID(wt.Path())
	if err := os.RemoveAll(wt.Path()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 10*time.Second, func() bool {
		for _, w := range e.Snapshot().Worktrees {
			if w.ID == id {
				return false
			}
		}
		return true
	})
}

// A worktree removed and re-added at the same path within one debounce: on
// linux the old root's watch died with its directory and must be restored.
func TestEngineWorktreeRecreated(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	p := filepath.Join(t.TempDir(), "again")
	wt := r.WorktreeAdd(p, "again")
	e, _ := startEngine(t, r.Path())
	id := wtID(wt.Path())
	r.WorktreeRemove(p)
	r.Git("worktree", "add", "--quiet", p, "again")
	// Let the engine settle, so the write below can only be seen through the
	// restored watch (scenario setup, not synchronisation).
	time.Sleep(2 * (debounce + minInterval))
	wt.Write("late.txt", "x\n")
	waitFor(t, 10*time.Second, func() bool { _, ok := snapEntry(e, id, "late.txt"); return ok })
}

// darwin reports the root itself when its metadata changes (`touch .`); that
// must not cost the main worktree its watch.
func TestEngineRootTouched(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, _ := startEngine(t, r.Path())
	id := wtID(r.Path())
	now := time.Now()
	if err := os.Chtimes(r.Path(), now, now); err != nil {
		t.Fatal(err)
	}
	r.Write("first.txt", "1\n")
	waitFor(t, 10*time.Second, func() bool { _, ok := snapEntry(e, id, "first.txt"); return ok })
	time.Sleep(time.Second) // a later write must still be watched (scenario setup, not synchronisation)
	r.Write("second.txt", "2\n")
	waitFor(t, 10*time.Second, func() bool { _, ok := snapEntry(e, id, "second.txt"); return ok })
}

func TestEngineCheckoutStorm(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	r.Branch("storm")
	r.Checkout("storm")
	var paths []string
	for i := 0; i < 300; i++ {
		p := fmt.Sprintf("gen/d%02d/f%03d.txt", i%10, i)
		r.Write(p, fmt.Sprintf("file %d\n", i))
		paths = append(paths, p)
	}
	r.Add(paths...)
	r.Commit("storm")
	r.Checkout("main")

	e, pl := startEngine(t, r.Path())
	time.Sleep(debounce + minInterval) // let the startup rescan settle so it is not counted
	before := pl.len()
	start := time.Now()
	r.Checkout("storm")
	fresh, err := Open(context.Background(), r.Path(), "", gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	want := comparable(fresh.Snapshot())
	if n := len(want.Overlays[wtID(r.Path())]); n != 300 {
		t.Fatalf("fresh snapshot has %d overlay entries, want 300", n)
	}
	waitFor(t, 3*time.Second, func() bool { return reflect.DeepEqual(comparable(e.Snapshot()), want) })

	time.Sleep(time.Until(start.Add(3 * time.Second))) // measurement window, not synchronisation
	t.Logf("patches: %d", pl.len()-before)
	if n := pl.len() - before; n > 10 {
		t.Errorf("%d patches within 3s of the checkout, want ≤ 10", n)
	}
	if got := comparable(e.Snapshot()); !reflect.DeepEqual(got, want) {
		t.Errorf("state drifted after settling:\n got %+v\nwant %+v", got.Worktrees, want.Worktrees)
	}
}

// comparable strips the fields that legitimately differ between a live engine
// and a freshly opened one (seq, activity).
func comparable(s model.Snapshot) model.Snapshot {
	s.Seq, s.Activity = 0, nil
	return s
}

func TestEngineUnstagedMove(t *testing.T) {
	r := initRepo(t, map[string]string{"docs/guide.md": "# guide\n", "notes/keep.md": "keep\n"})
	e, _ := startEngine(t, r.Path())
	id := wtID(r.Path())
	r.Move("docs/guide.md", "notes/guide.md")
	waitFor(t, 10*time.Second, func() bool {
		c, ok := snapEntry(e, id, "notes/guide.md")
		_, stale := snapEntry(e, id, "docs/guide.md")
		return ok && !stale && c.Kind == model.Renamed && c.From == "docs/guide.md" && c.Stage == model.Uncommitted
	})
}

// fakeWatcher is a watch.Watcher the test drives by hand.
type fakeWatcher struct {
	events  chan watch.Event
	errs    chan error
	addErr  error // returned by every Add when set
	mu      sync.Mutex
	added   []string
	removed []string
}

func (f *fakeWatcher) Events() <-chan watch.Event { return f.events }
func (f *fakeWatcher) Errors() <-chan error       { return f.errs }
func (f *fakeWatcher) Close() error               { return nil }
func (f *fakeWatcher) Add(root string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.addErr != nil {
		return f.addErr
	}
	f.added = append(f.added, root)
	return nil
}

func (f *fakeWatcher) Remove(root string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, root)
	return nil
}

func (f *fakeWatcher) removes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.removed...)
}

func (f *fakeWatcher) roots() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.added...)
}

func useFakeWatcher(t *testing.T) *fakeWatcher {
	t.Helper()
	fw := &fakeWatcher{events: make(chan watch.Event, 16), errs: make(chan error, 16)}
	orig := newWatcher
	newWatcher = func() (watch.Watcher, error) { return fw, nil }
	t.Cleanup(func() { newWatcher = orig })
	return fw
}

func TestRunWatchesMainAndOutsideRoots(t *testing.T) {
	fw := useFakeWatcher(t)
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	outside := r.WorktreeAdd(filepath.Join(t.TempDir(), "outside"), "outside")
	r.WorktreeAdd(".claude/worktrees/nested", "nested")
	startEngine(t, r.Path())
	time.Sleep(2 * (debounce + minInterval)) // let the startup rescan's fires run: they must not re-add or remove

	got := fw.roots()
	want := []string{canon(r.Path()), canon(outside.Path())}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("watched roots = %v, want %v (nested worktree covered by main)", got, want)
	}
	if rm := fw.removes(); len(rm) != 0 {
		t.Fatalf("removed roots = %v, want none", rm)
	}
}

// Only an event naming an outside worktree root itself may make Run touch
// that root's watch; events for the main root, the git dir or ordinary files
// must never re-add or remove anything.
func TestRunEventsLeaveWatchesAlone(t *testing.T) {
	fw := useFakeWatcher(t)
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	outside := r.WorktreeAdd(filepath.Join(t.TempDir(), "outside"), "outside")
	e, _ := startEngine(t, r.Path())
	main, out := canon(r.Path()), canon(outside.Path())
	time.Sleep(debounce + minInterval) // let the startup rescan run first

	for _, p := range []string{main, filepath.Join(main, "README.md"), filepath.Join(main, ".git"),
		filepath.Join(main, ".git", "HEAD"), filepath.Join(out, "README.md")} {
		fw.events <- watch.Event{Path: p}
	}
	r.Write("sentinel.txt", "s\n")
	fw.events <- watch.Event{Path: filepath.Join(main, "sentinel.txt")}
	waitFor(t, 5*time.Second, func() bool { _, ok := snapEntry(e, wtID(r.Path()), "sentinel.txt"); return ok })

	if rm := fw.removes(); len(rm) != 0 {
		t.Errorf("removed roots = %v, want none", rm)
	}
	if got := fw.roots(); len(got) != 2 {
		t.Errorf("added roots = %v, want only the two initial ones", got)
	}
}

func TestRunRescanEventRecomputesEverything(t *testing.T) {
	fw := useFakeWatcher(t)
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, _ := startEngine(t, r.Path())
	time.Sleep(debounce + minInterval) // let the startup rescan run first
	r.Write("dropped.txt", "the watcher overflowed before reporting this\n")
	fw.events <- watch.Event{Rescan: true}
	waitFor(t, 5*time.Second, func() bool { _, ok := snapEntry(e, wtID(r.Path()), "dropped.txt"); return ok })
}

func TestRunFallsBackToPollingOnWatcherError(t *testing.T) {
	fw := useFakeWatcher(t)
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, _ := startEngine(t, r.Path())
	time.Sleep(debounce + minInterval) // let the startup rescan run first
	fw.errs <- &fs.PathError{Op: "watch", Path: filepath.Join(canon(r.Path()), "deep"), Err: errors.New("too many open files")}
	r.Write("polled.txt", "found by polling\n") // no event will ever report this
	waitFor(t, pollInterval+3*time.Second, func() bool { _, ok := snapEntry(e, wtID(r.Path()), "polled.txt"); return ok })
}

func TestRunPollsWhenAddFails(t *testing.T) {
	fw := useFakeWatcher(t)
	fw.addErr = errors.New("no space left on device") // e.g. the inotify watch limit
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, _ := startEngine(t, r.Path())
	time.Sleep(debounce + minInterval) // let the startup rescan run first
	r.Write("polled.txt", "found by polling\n")
	waitFor(t, pollInterval+3*time.Second, func() bool { _, ok := snapEntry(e, wtID(r.Path()), "polled.txt"); return ok })
}

// On linux a deleted or renamed root silently loses its inotify watch, and the
// root's parent is not watched, so recreating it goes unseen. The only sign is
// an event naming the root itself.
func TestRunRewatchesRecreatedRoot(t *testing.T) {
	fw := useFakeWatcher(t)
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	p := filepath.Join(t.TempDir(), "again")
	wt := r.WorktreeAdd(p, "again")
	e, _ := startEngine(t, r.Path())
	root, id := canon(wt.Path()), wtID(wt.Path())
	time.Sleep(debounce + minInterval) // let the startup rescan run first

	r.WorktreeRemove(p)
	r.Git("worktree", "add", "--quiet", p, "again") // same path, new directory
	wt.Write("late.txt", "written before the watch was restored\n")
	fw.events <- watch.Event{Path: root} // what inotify reports when the old root went away
	waitFor(t, 5*time.Second, func() bool {
		n := 0
		for _, a := range fw.roots() {
			if a == root {
				n++
			}
		}
		return n == 2
	})
	waitFor(t, 5*time.Second, func() bool { _, ok := snapEntry(e, id, "late.txt"); return ok })
}

// If the watcher cannot be created at all (e.g. linux's inotify instance
// limit), Run must not fail: it logs and polls every worktree instead.
func TestRunPollsWhenWatcherCannotStart(t *testing.T) {
	orig := newWatcher
	newWatcher = func() (watch.Watcher, error) { return nil, errors.New("too many open files") }
	t.Cleanup(func() { newWatcher = orig })
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	_, pl := startEngine(t, r.Path())  // its cleanup fails the test if Run returns an error
	time.Sleep(debounce + minInterval) // let the startup rescan run first
	r.Write("polled.txt", "found by polling\n")
	id := wtID(r.Path())
	waitFor(t, pollInterval+3*time.Second, func() bool {
		return pl.any(func(p model.Patch) bool {
			return upserted(p, id, func(c model.ChangeEntry) bool { return c.Path == "polled.txt" })
		})
	})
}

// Without a watcher, worktrees added later are found by polling too.
func TestRunPollingDiscoversNewWorktrees(t *testing.T) {
	orig := newWatcher
	newWatcher = func() (watch.Watcher, error) { return nil, errors.New("too many open files") }
	t.Cleanup(func() { newWatcher = orig })
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, _ := startEngine(t, r.Path())
	time.Sleep(debounce + minInterval) // let the startup rescan run first
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "later"), "later")
	id := wtID(wt.Path())
	waitFor(t, pollInterval+3*time.Second, func() bool {
		for _, w := range e.Snapshot().Worktrees {
			if w.ID == id {
				return true
			}
		}
		return false
	})
}
