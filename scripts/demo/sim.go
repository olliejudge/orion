package main

import (
	"context"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// theme is the part of nebula an agent works on. Themes never overlap, so
// merges into main never conflict.
type theme struct {
	Slug string
	Dir  string
}

var themes = []theme{
	{"ui", "web/src/components"},
	{"api", "internal/api"},
	{"guides", "docs/guides"},
	{"store", "internal/store"},
	{"pages", "web/src/pages"},
	{"catalog", "internal/catalog"},
	{"k8s", "deploy/k8s"},
	{"auth", "internal/auth"},
}

const maxAgents = 8 // len(themes)

// actor is one simulated worker: an agent in a linked worktree, or the human
// in the main worktree.
type actor struct {
	Name    string // "agent-ui", "agent-ui-2", or "you"
	Dir     string // absolute worktree root
	Branch  string // "agent/ui", "agent/ui-2", or "main"
	Theme   theme
	Slot    int // agent slot; even = nested under .claude/worktrees, odd = outside the root
	Serial  int // 1 for the first agent in a slot, then 2, 3, ...
	Nested  bool
	Pending int // actions since the last commit
	Every   int // commit after this many actions
	Commits int // commits on this branch
	Who     person
}

type sim struct {
	cfg     config
	rng     *rand.Rand
	nm      *namer
	log     *logger
	root    string // main worktree root
	outside string // root + ".wt": parent of the outside worktrees
	you     *actor
	agents  []*actor
	now     func() time.Time
}

func newSim(cfg config, root string, rng *rand.Rand, nm *namer, log *logger) *sim {
	s := &sim{cfg: cfg, rng: rng, nm: nm, log: log, root: root, outside: root + ".wt", now: time.Now}
	s.you = &actor{Name: "you", Dir: root, Branch: "main", Theme: theme{Slug: "you", Dir: "docs"}, Who: human}
	s.you.Every = s.commitEvery()
	return s
}

func (s *sim) commitEvery() int { return 3 + s.rng.IntN(4) }

// spawnAgent creates the linked worktree and branch for slot/serial.
func (s *sim) spawnAgent(slot, serial int) (*actor, error) {
	th := themes[slot]
	name, branch := "agent-"+th.Slug, "agent/"+th.Slug
	if serial > 1 {
		name = fmt.Sprintf("%s-%d", name, serial)
		branch = fmt.Sprintf("%s-%d", branch, serial)
	}
	a := &actor{Name: name, Branch: branch, Theme: th, Slot: slot, Serial: serial, Nested: slot%2 == 0, Who: agentPerson(name)}
	if a.Nested {
		a.Dir = filepath.Join(s.root, ".claude", "worktrees", name)
	} else {
		a.Dir = filepath.Join(s.outside, name)
	}
	a.Every = s.commitEvery()
	if _, err := git(s.root, nil, "worktree", "add", "-q", "-b", branch, a.Dir, "main"); err != nil {
		return nil, err
	}
	where := "outside the repo"
	if a.Nested {
		where = "nested in the repo"
	}
	s.log.printf("%s: new worktree %s on %s (%s)", name, a.Dir, branch, where)
	return a, nil
}

func (s *sim) spawnInitialAgents() error {
	if err := os.MkdirAll(s.outside, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(s.outside, markerName), []byte("created by scripts/demo\n"), 0o644); err != nil {
		return err
	}
	for slot := 0; slot < s.cfg.Agents; slot++ {
		a, err := s.spawnAgent(slot, 1)
		if err != nil {
			return err
		}
		s.agents = append(s.agents, a)
	}
	return nil
}

// files lists existing files under dir (repo-relative) in worktree a.
// When recursive is false only direct children are listed.
func (s *sim) files(a *actor, dir string, recursive bool) []string {
	base := filepath.Join(a.Dir, filepath.FromSlash(dir))
	var out []string
	_ = filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != base && !recursive {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(a.Dir, p)
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	return out
}

func (s *sim) exists(a *actor) func(rel string) bool {
	return func(rel string) bool {
		_, err := os.Stat(filepath.Join(a.Dir, filepath.FromSlash(rel)))
		return err == nil
	}
}

func (s *sim) pick(list []string) string { return list[s.rng.IntN(len(list))] }

func (s *sim) abs(a *actor, rel string) string {
	return filepath.Join(a.Dir, filepath.FromSlash(rel))
}

// tracked returns files in list that git tracks in a's index.
func (s *sim) tracked(a *actor, list []string) ([]string, error) {
	out, err := git(a.Dir, nil, "ls-files", "-z", "--", a.Theme.Dir)
	if err != nil {
		return nil, err
	}
	inIndex := map[string]bool{}
	for _, p := range strings.Split(out, "\x00") {
		inIndex[p] = true
	}
	var res []string
	for _, p := range list {
		if inIndex[p] {
			res = append(res, p)
		}
	}
	return res, nil
}

// agentAction performs one random file operation inside a's theme folder.
// It returns a short description used for the commit message.
func (s *sim) agentAction(a *actor) (string, error) {
	list := s.files(a, a.Theme.Dir, true)
	roll := s.rng.IntN(100)
	if len(list) < 4 {
		roll = 0 // too few files left: create
	}
	switch {
	case roll < 25: // create
		rel := s.nm.next(a.Theme.Dir, mustArea(a.Theme.Dir).Ext, s.exists(a))
		if err := writeFile(a.Dir, rel, content(rel, s.rng)); err != nil {
			return "", err
		}
		s.log.action(a.Name, "create", rel)
		return "add " + path.Base(rel), nil
	case roll < 65: // edit
		rel := s.pick(list)
		var chunk strings.Builder
		for i := 0; i < 1+s.rng.IntN(6); i++ {
			chunk.WriteString(line(path.Ext(rel), s.rng))
		}
		if err := appendFile(a.Dir, rel, chunk.String()); err != nil {
			return "", err
		}
		s.log.action(a.Name, "edit", rel)
		return "update " + path.Base(rel), nil
	case roll < 85: // move: plain mv (65-74) or git mv (75-84)
		candidates, useGit := list, roll >= 75
		if useGit {
			tracked, err := s.tracked(a, list)
			if err != nil {
				return "", err
			}
			if len(tracked) == 0 {
				useGit = false
			} else {
				candidates = tracked
			}
		}
		rel := s.pick(candidates)
		to := s.nm.next(path.Dir(rel), path.Ext(rel), s.exists(a))
		if useGit {
			if _, err := git(a.Dir, nil, "mv", "--", rel, to); err != nil {
				return "", err
			}
			s.log.action(a.Name, "git mv", rel+" -> "+to)
			return "rename " + path.Base(rel), nil
		}
		// Plain mv: git sees a delete plus an untracked add until the commit.
		if err := os.Rename(s.abs(a, rel), s.abs(a, to)); err != nil {
			return "", err
		}
		s.log.action(a.Name, "mv", rel+" -> "+to)
		return "move " + path.Base(rel), nil
	default: // delete
		rel := s.pick(list)
		if err := os.Remove(s.abs(a, rel)); err != nil {
			return "", err
		}
		s.log.action(a.Name, "delete", rel)
		return "remove " + path.Base(rel), nil
	}
}

// humanAction edits or creates a note in the main worktree.
func (s *sim) humanAction() (string, error) {
	a := s.you
	candidates := append([]string{"README.md", "Makefile"}, s.files(a, "docs", false)...)
	if s.rng.IntN(5) == 0 {
		rel := s.nm.next("docs", ".md", s.exists(a))
		if err := writeFile(a.Dir, rel, content(rel, s.rng)); err != nil {
			return "", err
		}
		s.log.action(a.Name, "create", rel)
		return "add " + path.Base(rel), nil
	}
	rel := s.pick(candidates)
	if err := appendFile(a.Dir, rel, line(path.Ext(rel), s.rng)); err != nil {
		return "", err
	}
	s.log.action(a.Name, "edit", rel)
	return "update " + path.Base(rel), nil
}

func (s *sim) commit(a *actor, what string) error {
	prefix := "feat(" + a.Theme.Slug + "): "
	if a == s.you {
		prefix = "docs: "
	}
	ok, err := commitAll(a.Dir, a.Who, s.now(), prefix+what)
	if err != nil {
		return err
	}
	a.Pending = 0
	a.Every = s.commitEvery()
	if ok {
		a.Commits++
		s.log.action(a.Name, "commit", prefix+what)
	}
	return nil
}

// act runs one action for a and commits when a has done enough.
func (s *sim) act(a *actor) error {
	var what string
	var err error
	if a == s.you {
		what, err = s.humanAction()
	} else {
		what, err = s.agentAction(a)
	}
	if err != nil {
		return err
	}
	a.Pending++
	if a.Pending >= a.Every {
		return s.commit(a, what)
	}
	return nil
}

// mergeAndRespawn merges a's branch into main from the main worktree, removes
// a's worktree and branch, and starts a fresh agent in the same slot.
func (s *sim) mergeAndRespawn(a *actor) error {
	if err := s.commit(a, "wrap up "+a.Theme.Slug); err != nil {
		return err
	}
	if s.you.Pending > 0 {
		if err := s.commit(s.you, "update notes"); err != nil {
			return err
		}
	}
	msg := fmt.Sprintf("Merge branch '%s'", a.Branch)
	if _, err := git(s.root, identityEnv(human, s.now()), "merge", "--no-ff", "-q", "-m", msg, a.Branch); err != nil {
		_, _ = git(s.root, nil, "merge", "--abort")
		s.log.printf("%s: merge skipped: %v", a.Name, err)
		return nil
	}
	s.log.action("you", "merge", a.Branch+" -> main")
	if _, err := git(s.root, nil, "worktree", "remove", "--force", a.Dir); err != nil {
		return err
	}
	if _, err := git(s.root, nil, "branch", "-D", a.Branch); err != nil {
		return err
	}
	next, err := s.spawnAgent(a.Slot, a.Serial+1)
	if err != nil {
		return err
	}
	for i, x := range s.agents {
		if x == a {
			s.agents[i] = next
		}
	}
	return nil
}

// step picks an actor (agents 3x as likely as the human) and runs one action;
// an agent with 2+ commits sometimes gets merged instead.
func (s *sim) step() error {
	n := len(s.agents)*3 + 1
	i := s.rng.IntN(n)
	if i == n-1 {
		return s.act(s.you)
	}
	a := s.agents[i/3]
	if a.Commits >= 2 && s.rng.IntN(8) == 0 {
		return s.mergeAndRespawn(a)
	}
	return s.act(a)
}

// runSteps runs n steps back to back (used by --once).
func (s *sim) runSteps(ctx context.Context, n int) error {
	for i := 0; i < n; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.step(); err != nil {
			return err
		}
	}
	return nil
}

// leaveDirty makes sure every agent has at least one commit and every
// worktree has an uncommitted change, so all three lifecycle stages show.
func (s *sim) leaveDirty() error {
	for _, a := range s.agents {
		if a.Commits == 0 {
			what, err := s.agentAction(a)
			if err != nil {
				return err
			}
			if err := s.commit(a, what); err != nil {
				return err
			}
		}
		rel := s.nm.next(a.Theme.Dir, mustArea(a.Theme.Dir).Ext, s.exists(a))
		if err := writeFile(a.Dir, rel, content(rel, s.rng)); err != nil {
			return err
		}
		s.log.action(a.Name, "create", rel)
	}
	if err := appendFile(s.root, "README.md", "\nWork in progress.\n"); err != nil {
		return err
	}
	s.log.action("you", "edit", "README.md")
	return nil
}

func mustArea(dir string) area {
	a, ok := areaFor(dir)
	if !ok {
		panic("no area for " + dir)
	}
	return a
}

// loop runs until ctx is cancelled, sleeping ~900ms/speed between steps.
// Errors are logged, not fatal, so a transient git failure doesn't stop the show.
func (s *sim) loop(ctx context.Context) error {
	interval := time.Duration(float64(900*time.Millisecond) / s.cfg.Speed)
	for {
		if err := s.step(); err != nil {
			s.log.printf("warning: %v", err)
		}
		d := interval/2 + time.Duration(s.rng.Int64N(int64(interval)))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d):
		}
	}
}
