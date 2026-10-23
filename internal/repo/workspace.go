package repo

import (
	"cmp"
	"context"
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
)

// activityLimit matches the Store's: a snapshot carries at most this many rows.
const activityLimit = 200

// OpenAll opens the repo containing each path, in order. A path in a repo
// that is already open (e.g. a linked worktree of one) is skipped and
// returned in dups.
func OpenAll(ctx context.Context, paths []string, baseOverride string, r gitx.Runner) (engines []*Engine, dups []string, err error) {
	seen := map[string]bool{}
	for _, p := range paths {
		abs, err := filepath.Abs(p)
		if err != nil {
			return nil, nil, err
		}
		if common, err := gitx.CommonDir(ctx, r, abs); err == nil {
			if seen[canon(common)] {
				dups = append(dups, p)
				continue
			}
		}
		e, err := Open(ctx, p, baseOverride, r)
		if err != nil {
			return nil, nil, err
		}
		seen[e.commonDir] = true
		engines = append(engines, e)
	}
	return engines, dups, nil
}

// member is one repo of a Workspace: its engine, its key (the path prefix
// in the combined tree) and a copy of its engine's state as of seq, kept in
// step by applying the engine's patches.
type member struct {
	eng      *Engine
	key      string
	info     model.RepoInfo
	wts      []model.Worktree
	tree     map[string]model.File
	overlays map[model.WorktreeID]map[string]model.ChangeEntry
	activity []model.Activity
	seq      uint64
	ch       <-chan model.Patch
	unsub    func()
}

// Workspace serves several repos as one: it merges its engines' snapshots
// and patches into a single tree with one top-level folder per repo. Each
// engine patch becomes one Workspace patch, restamped with the Workspace's
// own seq.
type Workspace struct {
	name    string
	members []*member

	mu      sync.Mutex // guards everything below and every member's state
	seq     uint64
	colors  map[model.WorktreeID]int // global colour of each non-main worktree
	used    [paletteSize]bool        // colours ever handed out
	rr      int
	subs    map[int]chan model.Patch
	nextSub int
}

// paletteSize is the number of worktree colours; 0 is every main worktree's.
const paletteSize = 10

// NewWorkspace combines engines (at least two, in display order) under the
// project name; an empty name defaults to DefaultName of the repo keys.
func NewWorkspace(name string, engines []*Engine) *Workspace {
	roots := make([]string, len(engines))
	for i, e := range engines {
		roots[i] = e.mainRoot
	}
	keys := RepoKeys(roots)
	if name == "" {
		name = DefaultName(keys)
	}
	w := &Workspace{name: name, colors: map[model.WorktreeID]int{}, subs: map[int]chan model.Patch{}}
	for i, e := range engines {
		e.logName = keys[i]
		m := &member{eng: e, key: keys[i]}
		m.load()
		w.members = append(w.members, m)
	}
	return w
}

// Name is the project name.
func (w *Workspace) Name() string { return w.name }

// Keys are the repo keys, in display order.
func (w *Workspace) Keys() []string {
	keys := make([]string, len(w.members))
	for i, m := range w.members {
		keys[i] = m.key
	}
	return keys
}

// RepoKeys names each repo root by its base name, prepending parent
// directories to the ones that collide until every key is unique.
func RepoKeys(roots []string) []string {
	depth := make([]int, len(roots))
	keys := make([]string, len(roots))
	for {
		for i, r := range roots {
			keys[i] = tail(r, depth[i]+1)
		}
		count := map[string]int{}
		for _, k := range keys {
			count[k]++
		}
		grew := false
		for i, k := range keys {
			if count[k] > 1 && tail(roots[i], depth[i]+2) != k {
				depth[i]++
				grew = true
			}
		}
		if !grew {
			return keys
		}
	}
}

// tail returns the last n elements of path p, joined by "/".
func tail(p string, n int) string {
	parts := strings.Split(strings.Trim(filepath.ToSlash(p), "/"), "/")
	return strings.Join(parts[max(0, len(parts)-n):], "/")
}

// DefaultName is the keys' longest common prefix without trailing "-", "_"
// or ".", or the keys joined by " + " when that leaves nothing.
func DefaultName(keys []string) string {
	prefix := keys[0]
	for _, k := range keys[1:] {
		for !strings.HasPrefix(k, prefix) {
			_, n := utf8.DecodeLastRuneInString(prefix) // whole runes, so a name never ends mid-character
			prefix = prefix[:len(prefix)-n]
		}
	}
	if prefix = strings.TrimRight(prefix, "-_."); prefix == "" {
		return strings.Join(keys, " + ")
	}
	return prefix
}

// load (re)subscribes to the engine and replaces the member's state with a
// fresh snapshot. Subscribing first means no patch after the snapshot is
// missed; patches it already covers are skipped by seq.
func (m *member) load() {
	if m.unsub != nil {
		m.unsub()
	}
	m.ch, m.unsub = m.eng.Subscribe()
	s := m.eng.Snapshot()
	m.info, m.wts, m.seq = s.Repo, s.Worktrees, s.Seq
	m.info.Key = m.key
	m.tree = make(map[string]model.File, len(s.Tree))
	for _, f := range s.Tree {
		m.tree[f.Path] = f
	}
	m.overlays = map[model.WorktreeID]map[string]model.ChangeEntry{}
	for id, entries := range s.Overlays {
		if len(entries) == 0 {
			continue
		}
		o := make(map[string]model.ChangeEntry, len(entries))
		for _, e := range entries {
			o[e.Path] = e
		}
		m.overlays[id] = o
	}
	m.activity = slices.Clone(s.Activity)
}

// apply brings the member's state up to p.
func (m *member) apply(p model.Patch) {
	m.seq = p.Seq
	if p.Worktrees != nil {
		m.wts = p.Worktrees
	}
	if p.Base != nil {
		m.info.BaseSha = p.Base.Sha
		for _, f := range p.Base.Upsert {
			m.tree[f.Path] = f
		}
		for _, path := range p.Base.Remove {
			delete(m.tree, path)
		}
	}
	for id, op := range p.Overlays {
		o := m.overlays[id]
		if o == nil {
			o = map[string]model.ChangeEntry{}
		}
		for _, path := range op.Remove {
			delete(o, path)
		}
		for _, e := range op.Upsert {
			o[e.Path] = e
		}
		if len(o) == 0 {
			delete(m.overlays, id)
		} else {
			m.overlays[id] = o
		}
	}
	present := map[model.WorktreeID]bool{}
	for _, wt := range m.wts {
		present[wt.ID] = true
	}
	for id := range m.overlays {
		if !present[id] {
			delete(m.overlays, id)
		}
	}
	m.activity = append(m.activity, p.Activity...)
	if over := len(m.activity) - activityLimit; over > 0 {
		m.activity = slices.Clone(m.activity[over:])
	}
}

func (m *member) prefix(path string) string {
	if path == "" {
		return ""
	}
	return m.key + "/" + path
}

func (m *member) entry(e model.ChangeEntry) model.ChangeEntry {
	e.Path, e.From = m.prefix(e.Path), m.prefix(e.From)
	return e
}

// Snapshot returns the combined state as of the Workspace's latest patch.
func (w *Workspace) Snapshot() model.Snapshot {
	w.mu.Lock()
	defer w.mu.Unlock()
	s := model.Snapshot{
		Type:      "snapshot",
		Seq:       w.seq,
		Repo:      model.RepoInfo{Name: w.name},
		Repos:     w.repos(),
		Worktrees: w.worktrees(),
		Tree:      []model.File{},
		Overlays:  map[model.WorktreeID][]model.ChangeEntry{},
		Activity:  []model.Activity{},
	}
	for _, m := range w.members {
		for _, path := range slices.Sorted(maps.Keys(m.tree)) {
			f := m.tree[path]
			f.Path = m.prefix(f.Path)
			s.Tree = append(s.Tree, f)
		}
		for id, o := range m.overlays {
			entries := make([]model.ChangeEntry, 0, len(o))
			for _, path := range slices.Sorted(maps.Keys(o)) {
				entries = append(entries, m.entry(o[path]))
			}
			s.Overlays[id] = entries
		}
		for _, a := range m.activity {
			s.Activity = append(s.Activity, m.activityRow(a))
		}
	}
	slices.SortStableFunc(s.Activity, func(a, b model.Activity) int { return cmp.Compare(a.TS, b.TS) })
	if over := len(s.Activity) - activityLimit; over > 0 {
		s.Activity = s.Activity[over:]
	}
	return s
}

func (m *member) activityRow(a model.Activity) model.Activity {
	a.Path, a.From = m.prefix(a.Path), m.prefix(a.From)
	return a
}

func (w *Workspace) repos() []model.RepoInfo {
	out := make([]model.RepoInfo, len(w.members))
	for i, m := range w.members {
		out[i] = m.info
	}
	return out
}

// worktrees is every repo's worktrees in repo order, tagged with the repo's
// key, with non-main colours remapped so no two repos share one.
func (w *Workspace) worktrees() []model.Worktree {
	present := map[model.WorktreeID]bool{}
	for _, m := range w.members {
		for _, wt := range m.wts {
			present[wt.ID] = true
		}
	}
	var out []model.Worktree
	for _, m := range w.members {
		for _, wt := range m.wts {
			wt.Repo = m.key
			if wt.ColorIndex > 0 {
				wt.ColorIndex = w.color(wt.ID, present)
			}
			out = append(out, wt)
		}
	}
	return out
}

// color returns id's global colour, picking one the first time: the lowest
// never-used index, else the lowest held by no present worktree, else
// round-robin (as the Store does for one repo).
func (w *Workspace) color(id model.WorktreeID, present map[model.WorktreeID]bool) int {
	if c, ok := w.colors[id]; ok {
		return c
	}
	c := 0
	for i := 1; i < paletteSize && c == 0; i++ {
		if !w.used[i] {
			c = i
		}
	}
	if c == 0 {
		var held [paletteSize]bool
		for other, i := range w.colors {
			if present[other] {
				held[i] = true
			}
		}
		for i := 1; i < paletteSize && c == 0; i++ {
			if !held[i] {
				c = i
			}
		}
	}
	if c == 0 {
		c = 1 + w.rr%(paletteSize-1)
		w.rr++
	}
	w.used[c] = true
	w.colors[id] = c
	return c
}

// Subscribe returns a channel of every future patch, with the Engine's
// semantics: a full buffer closes the channel and the subscriber must
// Subscribe again and take a fresh Snapshot.
func (w *Workspace) Subscribe() (<-chan model.Patch, func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	id := w.nextSub
	w.nextSub++
	ch := make(chan model.Patch, subBuffer)
	w.subs[id] = ch
	return ch, func() {
		w.mu.Lock()
		defer w.mu.Unlock()
		if c, ok := w.subs[id]; ok {
			delete(w.subs, id)
			close(c)
		}
	}
}

// Run runs every engine and forwards their patches until ctx is done or an
// engine fails.
func (w *Workspace) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errs := make(chan error, 2*len(w.members))
	var wg sync.WaitGroup
	for _, m := range w.members {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if err := m.eng.Run(ctx); err != nil {
				errs <- fmt.Errorf("%s: %w", m.key, err)
			}
		}()
		go func() {
			defer wg.Done()
			w.pump(ctx, m)
		}()
	}
	var err error
	select {
	case <-ctx.Done():
	case err = <-errs:
	}
	cancel()
	wg.Wait()
	w.mu.Lock()
	for _, m := range w.members {
		m.unsub()
	}
	w.mu.Unlock()
	return err
}

// pump forwards m's engine patches. When the engine drops the Workspace as
// a slow subscriber, it reloads m and drops every client, so each resyncs
// from a fresh Snapshot.
func (w *Workspace) pump(ctx context.Context, m *member) {
	for {
		w.mu.Lock()
		ch := m.ch
		w.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case p, ok := <-ch:
			w.mu.Lock()
			if !ok {
				m.load()
				w.seq++
				w.dropSubs()
			} else if p.Seq > m.seq {
				w.forward(m, p)
			}
			w.mu.Unlock()
		}
	}
}

// forward applies an engine patch to m and fans out its combined form. w.mu
// must be held.
func (w *Workspace) forward(m *member, p model.Patch) {
	m.apply(p)
	w.seq++
	out := model.Patch{Type: "patch", Seq: w.seq}
	if p.Worktrees != nil {
		out.Worktrees = w.worktrees()
	}
	if p.Base != nil {
		b := &model.BasePatch{Upsert: make([]model.File, len(p.Base.Upsert)), Remove: make([]string, len(p.Base.Remove))}
		for i, f := range p.Base.Upsert {
			f.Path = m.prefix(f.Path)
			b.Upsert[i] = f
		}
		for i, path := range p.Base.Remove {
			b.Remove[i] = m.prefix(path)
		}
		out.Base, out.Repos = b, w.repos()
	}
	if p.Overlays != nil {
		out.Overlays = make(map[model.WorktreeID]model.OverlayPatch, len(p.Overlays))
		for id, op := range p.Overlays {
			o := model.OverlayPatch{Upsert: make([]model.ChangeEntry, len(op.Upsert)), Remove: make([]string, len(op.Remove))}
			for i, e := range op.Upsert {
				o.Upsert[i] = m.entry(e)
			}
			for i, path := range op.Remove {
				o.Remove[i] = m.prefix(path)
			}
			out.Overlays[id] = o
		}
	}
	for _, a := range p.Activity {
		out.Activity = append(out.Activity, m.activityRow(a))
	}
	for id, ch := range w.subs {
		select {
		case ch <- out:
		default:
			delete(w.subs, id)
			close(ch)
		}
	}
}

// dropSubs closes every subscriber's channel. w.mu must be held.
func (w *Workspace) dropSubs() {
	for id, ch := range w.subs {
		delete(w.subs, id)
		close(ch)
	}
}
