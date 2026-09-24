// Command demo builds a synthetic git repository ("nebula", an invented
// project) with several linked worktrees, then simulates coding agents and a
// human working in them so orion has something lively to show.
//
//	go run ./scripts/demo [--dir DIR] [--agents 3] [--seed N] [--speed 1.0] [--once [--steps 40]]
//
// Worktrees in even slots are nested under DIR/.claude/worktrees/, odd slots
// live outside the repo under DIR.wt/. The tool only ever deletes a DIR (and
// DIR.wt) that it created itself. Ctrl-C stops it and leaves the repo in place.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

type config struct {
	Dir    string
	Agents int
	Seed   uint64
	Speed  float64
	Once   bool
	Steps  int
}

// markerName marks directories the demo created (DIR/.git/<marker> and
// DIR.wt/<marker>), so it never deletes anything else.
const markerName = "orion-demo"

// maxSpeed caps --speed: at 1000x the 900 ms pause between actions is already under 1 ms.
const maxSpeed = 1000

func (c config) validate() error {
	if c.Dir == "" {
		return errors.New("--dir must not be empty")
	}
	if c.Agents < 1 || c.Agents > maxAgents {
		return fmt.Errorf("--agents must be between 1 and %d, got %d", maxAgents, c.Agents)
	}
	if !(c.Speed > 0) || math.IsInf(c.Speed, 0) || c.Speed > maxSpeed {
		return fmt.Errorf("--speed must be > 0 and <= %d, got %g", maxSpeed, c.Speed)
	}
	if c.Steps < 0 {
		return fmt.Errorf("--steps must be >= 0, got %d", c.Steps)
	}
	return nil
}

type logger struct{ w io.Writer }

func (l *logger) printf(format string, a ...any) { _, _ = fmt.Fprintf(l.w, format+"\n", a...) }

func (l *logger) action(who, verb, what string) {
	_, _ = fmt.Fprintf(l.w, "%s  %-14s %-7s %s\n", time.Now().Format("15:04:05"), who, verb, what)
}

func main() {
	var cfg config
	flag.StringVar(&cfg.Dir, "dir", filepath.Join(os.TempDir(), "orion-demo", "nebula"), "where to create the demo repo (recreated if the demo made it)")
	flag.IntVar(&cfg.Agents, "agents", 3, fmt.Sprintf("number of simulated agent worktrees (1-%d)", maxAgents))
	flag.Uint64Var(&cfg.Seed, "seed", 1, "random seed; the same seed gives the same initial repo")
	flag.Float64Var(&cfg.Speed, "speed", 1.0, "simulation speed multiplier")
	flag.BoolVar(&cfg.Once, "once", false, "set up, run --steps actions without pausing, then exit")
	flag.IntVar(&cfg.Steps, "steps", 40, "number of actions to run in --once mode")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, cfg, os.Stdout)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "demo:", err)
		os.Exit(1)
	}
}

// prepareDir makes root (and root.wt) empty, refusing to delete anything the
// demo did not create.
func prepareDir(root string) error {
	outside := root + ".wt"
	for _, d := range []struct{ dir, marker string }{
		{root, filepath.Join(root, ".git", markerName)},
		{outside, filepath.Join(outside, markerName)},
	} {
		entries, err := os.ReadDir(d.dir)
		if errors.Is(err, os.ErrNotExist) || (err == nil && len(entries) == 0) {
			continue
		}
		if err != nil {
			return err
		}
		if _, err := os.Stat(d.marker); err != nil {
			return fmt.Errorf("refusing to overwrite %s: it is not empty and was not created by the demo", d.dir)
		}
	}
	for _, d := range []string{root, outside} {
		if err := os.RemoveAll(d); err != nil {
			return err
		}
	}
	return os.MkdirAll(root, 0o755)
}

func run(ctx context.Context, cfg config, out io.Writer) error {
	if err := cfg.validate(); err != nil {
		return err
	}
	abs, err := filepath.Abs(cfg.Dir)
	if err != nil {
		return err
	}
	if err := prepareDir(abs); err != nil {
		return err
	}
	// Resolve symlinks (/tmp -> /private/tmp on macOS) so printed paths match git's.
	root, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return err
	}
	log := &logger{w: out}
	rng := rand.New(rand.NewPCG(cfg.Seed, 0x6f72696f6e))
	nm := newNamer(rng)
	if err := buildRepo(root, rng, nm, log); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(root, ".git", markerName), []byte("created by scripts/demo\n"), 0o644); err != nil {
		return err
	}
	s := newSim(cfg, root, rng, nm, log)
	if err := s.spawnInitialAgents(); err != nil {
		return err
	}
	log.printf("demo repo ready: %s", root)
	log.printf("watch it with:   orion %s", root)
	if cfg.Once {
		if err := s.runSteps(ctx, cfg.Steps); err != nil {
			return err
		}
		if err := s.leaveDirty(); err != nil {
			return err
		}
		log.printf("done: ran %d steps (--once)", cfg.Steps)
		return nil
	}
	log.printf("simulating %d agents; press Ctrl-C to stop", cfg.Agents)
	if err := s.loop(ctx); !errors.Is(err, context.Canceled) {
		return err
	}
	log.printf("stopped; the demo repo is left at %s", root)
	return nil
}
