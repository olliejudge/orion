# Orion Phase 1 (Live Map MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `orion` v0.1.0. It is a single Go binary, installable via Homebrew, that serves a live, animated bubble map of a git repo across all its worktrees, with the three-stage lifecycle (ghost → tinted on branch → merged), an activity stream, and the Vision/Night themes.

**Architecture:**
- The Go backend watches the filesystem (FSEvents on darwin, inotify on linux) and shells out to `git` to compute a base tree plus a change overlay per worktree.
- A pure `model` package diffs successive states into patches, which are streamed over a WebSocket.
- A Vite + Svelte 5 + PixiJS frontend, embedded with `go:embed`, lays out the map with d3-hierarchy and animates it with springs.

**Tech Stack:**
- Backend: Go 1.27, `github.com/fsnotify/fsevents` (darwin, cgo), `github.com/fsnotify/fsnotify` (linux), `github.com/coder/websocket`.
- Frontend: TypeScript, Svelte 5, PixiJS v8, d3-hierarchy, Vite, Vitest, Playwright, pnpm.
- Release: GoReleaser, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-23-orion-design.md`. Read it before starting any task. Where this plan and the spec disagree, the spec's *behaviour* wins and this plan's *names/interfaces* win.

## Global Constraints

- Frontend build output: `internal/webassets/static/` (gitignored except `.gitkeep`). `go build`/`go test` must work without Node; the server then serves `fallback.html`.
- **Already on `main` before Task 1:** `LICENSE` (MIT), `README.md` (stub, fully rewritten in Task 15), `.gitignore` (baseline: `/bin/`, `/dist/`, `/web/dist/`, `/coverage/`, `node_modules/`, `.superpowers/`, `.playwright-mcp/`, `.claude/worktrees/`, OS/editor files) and `CLAUDE.md`. Tasks modify these files; none creates them.
- Go module path: `github.com/olliejudge/orion`. Go 1.27. Minimum supported `git`: 2.30.
- Never use a git library; always exec the user's `git`, and always use `-z` / NUL-separated output where git offers it.
- All repo paths inside the program are repo-relative and slash-separated. Absolute paths appear only at the watch/exec boundary.
- The server binds `127.0.0.1` only. The default port is 7070; if taken, the next free port is used.
- Timing constants: debounce 150 ms per worktree; at most 4 recomputes/s per worktree; activity coalescing window 5 s; activity buffer 200 items; merge shimmer ~600 ms; spring settle ~300 ms.
- Worktree palette (index → colour), Apple system colours in dark mode: 0 blue `#0a84ff`, 1 orange `#ff9f0a`, 2 green `#30d158`, 3 pink `#ff375f`, 4 purple `#bf5af2`, 5 teal `#40c8e0`, 6 yellow `#ffd60a`, 7 indigo `#5e5ce6`, 8 red `#ff453a`, 9 mint `#63e6e2`. The main worktree is always index 0.
- Supported platforms: darwin/arm64, darwin/amd64, linux/amd64, linux/arm64. Darwin builds need cgo (FSEvents) and are built on a macOS runner; linux builds use `CGO_ENABLED=0`.
- **Privacy:** this repo is public. Fixtures, tests, docs, screenshots, commit messages and PR text use only synthetic repos. Never reference files or content from any private repo.
- **Git workflow** (from `CLAUDE.md`): one branch + one worktree per task, named `<type>/<short-desc>`; Conventional Commits; small commits with tests passing; PR into `main` (squash merge). Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

These are the five inputs most likely to bite a real user that no happy-path test covers. Each has a pinned test in the owning task.

1. **Nested linked worktrees** (e.g. `.claude/worktrees/agent-x/` inside the main root). Events and `git status` entries inside a nested worktree must never appear in the main worktree's overlay. `git status` in the main worktree may list the nested worktree as an untracked directory entry; that entry must be dropped. *Pinned in Task 3b (`TestStatusDropsNestedWorktreeDir`) and Task 6 (`TestRouterNestedWorktree`), and exercised end-to-end in Task 8b (`TestEngineNestedWorktree`).*
2. **Awkward paths:** spaces, unicode, quotes, leading dashes and newlines in file names. Everything must round-trip through `-z` parsing and JSON. *Pinned in Task 3b (`TestStatusAwkwardPaths`, `TestLsTreeAwkwardPaths`).*
3. **Worktrees appearing and disappearing mid-run**, including prunable entries whose directory no longer exists, and locked worktrees. There must be no crash; the overlay is removed and the legend updates. *Pinned in Task 3a (`TestListWorktreesPrunable`) and Task 8b (`TestEngineWorktreeRemoved`).*
4. **Event storms** (`git checkout` of another branch, `rebase`, `npm install` in an ignored folder). These must coalesce into a bounded number of recomputes that end in the correct final state, with no patch flood to the browser. *Pinned in Task 6 (`TestSchedulerBurst`) and Task 8b (`TestEngineCheckoutStorm`).*
5. **Plain `mv` without `git add`.** Git reports a delete plus an untracked add, but the user expects a *move* animation. When exactly one deleted and one added path in the same worktree share a base name, pair them as `renamed`. *Pinned in Task 3b (`TestPairMoves`) and Task 8b (`TestEngineUnstagedMove`).*

---

## File Structure

```
go.mod, go.sum
Makefile                                  # build, test, lint, dev, web targets
.golangci.yml
.github/workflows/ci.yml                  # Task 1
.github/workflows/release.yml             # Task 15
.goreleaser.yaml                          # Task 15
cmd/orion/main.go                         # CLI entry: flags, run()          (Task 1 stub, Task 8c real)
internal/version/version.go               # Version string set via ldflags   (Task 1)
internal/webassets/embed.go               # //go:embed all:static → FS; HasUI() reports whether index.html exists (Task 1)
internal/webassets/static/.gitkeep        # only committed file in static/; web build writes here; static/* else gitignored (Task 1)
internal/webassets/fallback.html          # embedded page shown when UI not built: "run make web" (Task 1)
internal/testrepo/testrepo.go             # synthetic repo builder for tests (Task 2)
internal/gitx/run.go                      # exec runner, version check       (Task 3)
internal/gitx/repo.go                     # RepoRoot, CommonDir, RevParse, MergeBase, ResolveBase, CommitSubject
internal/gitx/worktrees.go                # ListWorktrees, WorktreeAdminDir
internal/gitx/tree.go                     # LsTree
internal/gitx/changes.go                  # DiffNameStatus, Status, PairMoves
internal/model/types.go                   # wire + state types               (Task 4)
internal/model/diff.go                    # Store.Apply → Patch + Activity
internal/model/colors.go                  # colour index assignment
internal/watch/watch.go                   # Event, Watcher interface         (Task 5)
internal/watch/watch_darwin.go            # FSEvents implementation
internal/watch/watch_linux.go             # recursive inotify implementation
internal/repo/router.go                   # path → Route classification      (Task 6)
internal/repo/scheduler.go                # debounce + rate limit per key    (Task 6)
internal/repo/compute.go                  # gitx → model.State builders      (Task 8a)
internal/repo/engine.go                   # Engine: Open, Snapshot, Subscribe (Task 8a)
internal/repo/recompute.go                # fire → minimal recompute → Store.Apply → broadcast (Task 8a)
internal/repo/run.go                      # Run: watcher loop, routing, polling fallback (Task 8b)
internal/server/server.go                 # HTTP, token, host/origin checks, static (Task 7)
internal/server/hub.go                    # WS fan-out, snapshot, resync
internal/server/listen.go                 # port fallback
scripts/demo/main.go                      # synthetic demo repo + fake agents (Task 13)
web/package.json, vite.config.ts, tsconfig.json, svelte.config.js, eslint.config.js, index.html
web/src/main.ts                           # mount App                        (Task 9)
web/src/protocol.ts                       # TS mirror of model wire types    (Task 9)
web/src/store.ts                          # RepoStore: apply snapshot/patch, seq gap → resync (Task 9)
web/src/connection.ts                     # WebSocket client with backoff    (Task 9)
web/src/colors.ts                         # worktree palette, extension→colour groups (Task 10)
web/src/layout/nodes.ts                   # base ∪ overlays → hierarchy      (Task 10)
web/src/layout/pack.ts                    # stable d3 pack + culling/aggregation (Task 10)
web/src/layout/encoding.ts                # per-node visual encoding          (Task 10)
web/src/render/springs.ts, geometry.ts, scene.ts   # pure renderer logic (Task 11a)
web/src/layout/frame.ts                   # per-frame layout + encoding + culling at zoom (Task 10)
web/src/render/MapRenderer.ts             # Pixi scene, draw, animate, zoom, pick (Task 11b)
web/src/render/sprites.ts                 # TextureBank: sphere/halo/ghost/arc-label textures (Task 11b)
web/src/ui/App.svelte                     # composition + keyboard            (Task 12)
web/src/ui/Legend.svelte, Activity.svelte, LivePill.svelte, Tooltip.svelte
web/src/ui/theme.ts                       # Vision/Night tokens + persistence (Task 12)
web/e2e/smoke.spec.ts, web/playwright.config.ts   # (Task 14)
```

## Shared Interfaces (authoritative; every task must use these exact names)

### Go: `internal/gitx`

```go
package gitx

type Runner struct{ Git string } // Git defaults to "git" when empty
func (r Runner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) // error includes args + stderr
func CheckVersion(ctx context.Context, r Runner) (string, error)      // error if < 2.30
func CommonDir(ctx context.Context, r Runner, dir string) (string, error) // absolute git common dir
func MainRoot(ctx context.Context, r Runner, dir string) (string, error)  // absolute top-level of the MAIN worktree, even when dir is inside a linked worktree
func RevParse(ctx context.Context, r Runner, dir, rev string) (string, error) // full sha; error if missing
func MergeBase(ctx context.Context, r Runner, dir, a, b string) (string, error)
func ResolveBase(ctx context.Context, r Runner, dir, override string) (ref, sha string, err error) // spec §2 order; ref "" + sha "" when repo has no commits
func CommitSubject(ctx context.Context, r Runner, dir, sha string) (string, error)

type Worktree struct {
    Path     string // absolute
    Head     string // sha, "" if unborn
    Branch   string // short name, "" if detached
    Detached bool
    Locked   bool
    Prunable bool   // directory missing
    IsMain   bool   // first entry
}
func ListWorktrees(ctx context.Context, r Runner, dir string) ([]Worktree, error)
func WorktreeAdminDir(wtPath string) (string, error) // for linked wt: reads <wt>/.git "gitdir: X" → abs X; for main: <wt>/.git

type FileEntry struct{ Path string; Size int64 } // submodules: Size 0
func LsTree(ctx context.Context, r Runner, dir, rev string) ([]FileEntry, error)

type ChangeKind string
const (Added ChangeKind = "added"; Modified ChangeKind = "modified"; Deleted ChangeKind = "deleted"; Renamed ChangeKind = "renamed")
type Change struct{ Path string; From string; Kind ChangeKind }
func DiffNameStatus(ctx context.Context, r Runner, dir, from, to string) ([]Change, error) // -M; copies→Added
func Status(ctx context.Context, r Runner, wtDir string) ([]Change, error) // porcelain=v2 -z --untracked-files=all; drops entries that are directories (trailing "/"), i.e. nested repos/worktrees
func PairMoves(changes []Change) []Change // unique basename match Deleted+Added → one Renamed{Path: added, From: deleted}; stable order
```

### Go: `internal/testrepo` (tests only)

```go
package testrepo
func New(t testing.TB) *Repo            // temp dir, symlink-resolved, branch main, deterministic author/dates
func (r *Repo) Path() string
func (r *Repo) Write(rel, content string)
func (r *Repo) Remove(rel string)
func (r *Repo) Move(from, to string)    // plain os.Rename, no git
func (r *Repo) GitMv(from, to string)
func (r *Repo) Add(paths ...string)     // none ⇒ add -A
func (r *Repo) Commit(msg string) string
func (r *Repo) Branch(name string)
func (r *Repo) Checkout(name string)
func (r *Repo) Merge(branch string) string
func (r *Repo) WorktreeAdd(path, branch string) *Repo // relative ⇒ nested under root; absolute ⇒ anywhere
func (r *Repo) WorktreeRemove(path string)
func (r *Repo) Git(args ...string) string
```

### Go: `cmd/orion`

```go
func run(args []string, stdout, stderr io.Writer) int // main() is os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
```

### Cross-cutting rules

- **Every absolute path is symlink-resolved** (`filepath.EvalSymlinks`): gitx outputs, testrepo paths, watcher roots and `watch.Event.Path`. FSEvents reports `/private/var/...`, so any comparison must use resolved paths.
- `gitx.Runner.Run` sets `GIT_OPTIONAL_LOCKS=0`, so `git status` never rewrites `.git/index` and wakes our own watcher.
- `webassets.FS()` always returns a servable FS. When the UI is not built, `fallback.html` is served as `index.html`.

### Go: `internal/model`

```go
package model

type WorktreeID string // hex of first 8 bytes of sha256(abs path)
func IDFor(absPath string) WorktreeID

type Kind string   // "added" | "modified" | "deleted" | "renamed"
const (Added Kind = "added"; Modified Kind = "modified"; Deleted Kind = "deleted"; Renamed Kind = "renamed")
type Stage string  // "uncommitted" | "committed"
const (Uncommitted Stage = "uncommitted"; Committed Stage = "committed")

type ChangeEntry struct {
    Path  string `json:"path"`
    Kind  Kind   `json:"kind"`
    From  string `json:"from,omitempty"`
    Stage Stage  `json:"stage"`
    Size  int64  `json:"size"`
}
type File struct{ Path string `json:"path"`; Size int64 `json:"size"` }
type Worktree struct {
    ID          WorktreeID `json:"id"`
    Path        string     `json:"path"`
    Label       string     `json:"label"`  // branch, else short sha, else "main"
    Branch      string     `json:"branch,omitempty"`
    Head        string     `json:"head"`
    IsMain      bool       `json:"isMain"`
    Locked      bool       `json:"locked"`
    ColorIndex  int        `json:"colorIndex"` // assigned by Store; -1 = not yet active
    HeadSubject string     `json:"-"`          // filled by repo; used for commit activity
}
type RepoInfo struct{ Name string `json:"name"`; Base string `json:"base"`; BaseSha string `json:"baseSha"` }

// State is a full, immutable-by-convention view; repo builds a new one per recompute.
type State struct {
    Repo      RepoInfo
    Worktrees []Worktree                              // sorted: main first, then by Path
    Tree      map[string]int64                        // base tree path → size
    Overlays  map[WorktreeID]map[string]ChangeEntry   // absent/empty map = no changes
}

type Activity struct {
    TS       int64      `json:"ts"` // unix ms
    Worktree WorktreeID `json:"worktree"`
    Kind     string     `json:"kind"` // added|modified|deleted|renamed|commit|merge
    Path     string     `json:"path,omitempty"`
    From     string     `json:"from,omitempty"`
    Sha      string     `json:"sha,omitempty"`
    Subject  string     `json:"subject,omitempty"`
    Files    int        `json:"files,omitempty"`
}
type BasePatch struct{ Sha string `json:"sha"`; Upsert []File `json:"upsert"`; Remove []string `json:"remove"` }
type OverlayPatch struct{ Upsert []ChangeEntry `json:"upsert"`; Remove []string `json:"remove"` }
type Snapshot struct {
    Type      string                        `json:"type"` // "snapshot"
    Seq       uint64                        `json:"seq"`
    Repo      RepoInfo                      `json:"repo"`
    Worktrees []Worktree                    `json:"worktrees"`
    Tree      []File                        `json:"tree"`     // sorted by path
    Overlays  map[WorktreeID][]ChangeEntry  `json:"overlays"` // sorted by path
    Activity  []Activity                    `json:"activity"` // oldest→newest, ≤200
}
type Patch struct {
    Type      string                        `json:"type"` // "patch"
    Seq       uint64                        `json:"seq"`
    Worktrees []Worktree                    `json:"worktrees,omitempty"`
    Base      *BasePatch                    `json:"base,omitempty"`
    Overlays  map[WorktreeID]OverlayPatch   `json:"overlays,omitempty"`
    Activity  []Activity                    `json:"activity,omitempty"`
}

type Store struct{ /* unexported: current State, seq, activity ring, colour assignment, coalesce index */ }
func NewStore(initial State, now time.Time) *Store     // seq starts at 1; assigns main colour 0
func (s *Store) Apply(next State, now time.Time) (Patch, bool) // false when nothing changed; seq increments only on true
func (s *Store) Snapshot() Snapshot
func (s *Store) State() State
```

### Go: `internal/watch`

```go
package watch
type Event struct{ Path string; Rescan bool } // Path absolute; Rescan=true on overflow/must-scan
type Watcher interface {
    Events() <-chan Event
    Errors() <-chan error
    Add(root string) error    // watch a root recursively (idempotent)
    Remove(root string) error
    Close() error
}
func New() (Watcher, error)   // platform file provides it
```

### Go: `internal/repo`

```go
package repo
type Class int
const (Ignore Class = iota; FileEvent; WorktreeRefEvent; RefsEvent; WorktreesChanged)
type Route struct{ Class Class; Worktree model.WorktreeID }
type RouteTarget struct{ ID model.WorktreeID; Root string; AdminDir string } // abs paths
func NewRouter(commonDir string, targets []RouteTarget) *Router
func (r *Router) Route(absPath string) Route

type Reason uint8 // bit flags
const (ReasonFiles Reason = 1 << iota; ReasonRef; ReasonRefs; ReasonWorktrees; ReasonRescan)
func NewScheduler(debounce, minInterval time.Duration, fire func(key string, r Reason)) *Scheduler
func (s *Scheduler) Trigger(key string, r Reason) // coalesces reasons per key; fire runs on its own goroutine, never concurrently for the same key
func (s *Scheduler) Close()

type Engine struct{ /* ... */ }
func Open(ctx context.Context, path, baseOverride string, r gitx.Runner) (*Engine, error)
func (e *Engine) Run(ctx context.Context) error                     // blocks until ctx done
func (e *Engine) Snapshot() model.Snapshot
func (e *Engine) Subscribe() (<-chan model.Patch, func())          // buffered; slow subscriber gets dropped → must resync
```

### Go: `internal/server`

```go
package server
type Source interface {
    Snapshot() model.Snapshot
    Subscribe() (<-chan model.Patch, func())
}
type Options struct{ Port int; Dev bool; Assets fs.FS }
type Server struct{ URL string /* http://127.0.0.1:PORT/?t=TOKEN */ }
func Start(ctx context.Context, src Source, opt Options) (*Server, error) // listens (with port fallback), serves until ctx done
func (s *Server) Wait() error
```

### TypeScript: `web/src`

```ts
// protocol.ts: mirrors model JSON exactly
export type WorktreeId = string;
export type Kind = "added" | "modified" | "deleted" | "renamed";
export type Stage = "uncommitted" | "committed";
export interface ChangeEntry { path: string; kind: Kind; from?: string; stage: Stage; size: number }
export interface FileEntry { path: string; size: number }
export interface Worktree { id: WorktreeId; path: string; label: string; branch?: string; head: string; isMain: boolean; locked: boolean; colorIndex: number }
export interface RepoInfo { name: string; base: string; baseSha: string }
export interface Activity { ts: number; worktree: WorktreeId; kind: Kind | "commit" | "merge"; path?: string; from?: string; sha?: string; subject?: string; files?: number }
export interface Snapshot { type: "snapshot"; seq: number; repo: RepoInfo; worktrees: Worktree[]; tree: FileEntry[]; overlays: Record<WorktreeId, ChangeEntry[]>; activity: Activity[] }
export interface Patch { type: "patch"; seq: number; worktrees?: Worktree[]; base?: { sha: string; upsert: FileEntry[]; remove: string[] }; overlays?: Record<WorktreeId, { upsert: ChangeEntry[]; remove: string[] }>; activity?: Activity[] }
export type ServerMessage = Snapshot | Patch;

// store.ts
export interface RepoState {
  repo: RepoInfo; seq: number;
  worktrees: Map<WorktreeId, Worktree>;
  tree: Map<string, number>;
  overlays: Map<WorktreeId, Map<string, ChangeEntry>>;
  activity: Activity[]; // newest LAST, ≤200
}
export interface Change { kind: "snapshot" | "patch"; patch?: Patch; merged: string[] /* paths that left all overlays and are now in base */ }
export class RepoStore {
  get state(): RepoState | null;
  apply(msg: ServerMessage): { ok: true } | { ok: false; needsResync: true };
  subscribe(fn: (s: RepoState, c: Change) => void): () => void;
}

// connection.ts
export function connect(store: RepoStore, opts?: { url?: string; onStatus?: (s: "connecting" | "open" | "reconnecting") => void }): () => void;

// layout/nodes.ts
export interface TreeNode { path: string; name: string; isDir: boolean; size: number; children?: TreeNode[] }
export function buildTree(state: RepoState): TreeNode; // root path "" ; base ∪ overlay paths (deleted kept; renamed "from" excluded)

// layout/pack.ts
export interface Circle { path: string; x: number; y: number; r: number; depth: number; isDir: boolean; aggregate?: number /* collapsed child count */ }
export function computeLayout(root: TreeNode, width: number, height: number, opts?: { minFileR?: number; minDirR?: number }): Map<string, Circle>;

// layout/encoding.ts
export interface Touch { worktree: WorktreeId; colorIndex: number; stage: Stage; kind: Kind }
export interface NodeVisual { path: string; ext: string; touches: Touch[]; ghost: boolean; deleted: boolean; tinted: boolean; renamedFrom?: string }
export function encode(state: RepoState, path: string): NodeVisual;

// colors.ts
export const WORKTREE_COLORS: readonly string[]; // exactly the 10 hexes in Global Constraints
export function colorForExt(ext: string): { base: string; light: string }; // gradient stops

// render/MapRenderer.ts
export class MapRenderer {
  constructor(host: HTMLElement);
  init(): Promise<void>;
  update(layout: Map<string, Circle>, visuals: Map<string, NodeVisual>, change: Change): void;
  setTheme(t: "vision" | "night"): void;
  isolate(worktree: WorktreeId | null): void;
  highlight(path: string | null): void;
  zoomTo(path: string): void; // "" = root
  onHover(fn: (path: string | null, screen: { x: number; y: number }) => void): void;
  onClick(fn: (path: string | null) => void): void;
  destroy(): void;
}
```

---

## Task Graph (for parallel dispatch)

| Task | Title | Depends on | Branch |
|---|---|---|---|
| 1 | Foundation: module, CLI stub, embed placeholder, Makefile, lint, CI | none | `chore/foundation` |
| 2 | `testrepo` synthetic repo builder | 1 | `test/testrepo` |
| 3a | `gitx` core: runner, repo, worktrees | 2 | `feat/gitx-core` |
| 3b | `gitx` changes: tree, status, diff, PairMoves | 3a | `feat/gitx-changes` |
| 4 | `model` types, Store, diff + activity | 1 | `feat/model` |
| 5 | `watch` FSEvents + inotify | 1 | `feat/watch` |
| 6 | `repo` Router + Scheduler | 4 | `feat/repo-router-scheduler` |
| 7 | `server` HTTP/WS, security, port fallback | 4 | `feat/server` |
| 8a | `repo` Engine: compute, recompute, Store wiring | 3b, 4, 6 | `feat/engine` |
| 8b | `repo` Engine.Run: watcher loop, polling fallback, end-to-end engine tests | 5, 8a | `feat/engine-run` |
| 8c | CLI wiring (`cmd/orion`) | 7, 8b | `feat/cli-wiring` |
| 9 | Web scaffold, protocol, store, connection | 1 | `feat/web-scaffold` |
| 10 | Layout: nodes, stable pack, encoding, colours | 9 | `feat/web-layout` |
| 11a | Renderer core (pure): springs, geometry, scene diffing, frame | 10 | `feat/web-renderer-core` |
| 11b | Renderer: Pixi scene, textures, lifecycle visuals, zoom, picking | 11a | `feat/web-renderer` |
| 12 | Chrome: legend, activity, live pill, tooltip, themes, keys | 11b | `feat/web-chrome` |
| 13 | Demo script | 1 | `feat/demo` |
| 14 | Playwright smoke + screenshots (also replaces README screenshot placeholder) | 8c, 12, 13, 15 | `test/e2e-smoke` |
| 15 | Release: GoReleaser, release workflow, Homebrew tap, README | 8c | `ci/release` |

Parallel waves:
1. Task 1.
2. Tasks 2, 4, 5, 9, 13.
3. Tasks 3a, 6, 7, 10.
4. Tasks 3b, 11a.
5. Tasks 8a, 11b.
6. Tasks 8b, 12.
7. Task 8c.
8. Task 15.
9. Task 14.

Human-only steps (need explicit approval from Ollie): Task 15 Step 2 (create `olliejudge/homebrew-tap` + PAT + secret) and Task 15 Step 12 (tag and release v0.1.0).

---

### Task 1: Foundation: module, CLI stub, embedded assets, Makefile, lint, CI

**Branch:** `chore/foundation` · **Depends on:** none

**Files:**
- Create: `go.mod`
- Create: `internal/version/version.go`
- Create: `cmd/orion/main.go`, `cmd/orion/main_test.go`
- Create: `internal/webassets/embed.go`, `internal/webassets/embed_test.go`, `internal/webassets/fallback.html`, `internal/webassets/static/.gitkeep`
- Create: `Makefile`, `.golangci.yml`, `.github/workflows/ci.yml`
- Modify: `.gitignore` (append two lines), `CLAUDE.md` (fill in `## Commands`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Module `github.com/olliejudge/orion`, `go 1.27`.
  - `package version`: `var Version = "dev"` (overwritten with `-ldflags "-X github.com/olliejudge/orion/internal/version.Version=…"`).
  - `package main` (cmd/orion): `func run(args []string, stdout, stderr io.Writer) int`. It returns the exit code: 0 for `--version`, 2 for a bad flag, and 1 otherwise ("not implemented yet"). Task 8 replaces the body and keeps the signature.
  - `package webassets`: `func FS() fs.FS` always contains `index.html`: the built UI when `static/index.html` exists, otherwise `fallback.html` served as `index.html`. `func HasUI() bool` reports whether the real UI was embedded.
  - Make targets: `build`, `test`, `lint`, `web`, `dev`, `clean`, `help`. `make dev` runs `go run ./cmd/orion --dev --no-open --port 7070 $(REPO)` next to `pnpm -C web dev`, so Task 8 must accept `--dev`, `--no-open` and `--port`, and Task 9's Vite proxy targets `127.0.0.1:7070`.
  - CI: a `go` job on ubuntu-latest and macos-latest (vet, golangci-lint v2.13.2, `go test -race`). A `web` job that runs `pnpm -C web install --frozen-lockfile`, `lint`, `test` and `build` only when `web/package.json` exists (pnpm 12, Node 24), so Task 9 must provide `lint`, `test` and `build` scripts and a `web/pnpm-lock.yaml`.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/chore-foundation -b chore/foundation main
cd .claude/worktrees/chore-foundation
```

All later steps in this task run inside this worktree.

- [ ] **Step 2: Create the module and the version package**

`go.mod`:

```
module github.com/olliejudge/orion

go 1.27
```

`internal/version/version.go`:

```go
// Package version holds the build version, set at link time with
// -ldflags "-X github.com/olliejudge/orion/internal/version.Version=v1.2.3".
package version

// Version is "dev" for local builds; release builds overwrite it via ldflags.
var Version = "dev"
```

- [ ] **Step 3: Write the failing CLI test**

`cmd/orion/main_test.go`:

```go
package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/olliejudge/orion/internal/version"
)

func TestRunVersion(t *testing.T) {
	for _, arg := range []string{"--version", "-version"} {
		var stdout, stderr bytes.Buffer
		code := run([]string{arg}, &stdout, &stderr)
		if code != 0 {
			t.Fatalf("run(%q) exit code = %d, want 0 (stderr: %q)", arg, code, stderr.String())
		}
		want := "orion " + version.Version + "\n"
		if stdout.String() != want {
			t.Fatalf("run(%q) stdout = %q, want %q", arg, stdout.String(), want)
		}
	}
}

func TestRunUnknownFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--nope"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "nope") {
		t.Fatalf("stderr %q does not mention the bad flag", stderr.String())
	}
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `go test ./cmd/orion/`
Expected: FAIL (build failed) with `undefined: run`.

- [ ] **Step 5: Write the CLI stub**

`cmd/orion/main.go`:

```go
// Command orion serves a live, animated map of a git repository.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/olliejudge/orion/internal/version"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses args and executes the CLI, returning the process exit code.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("orion", flag.ContinueOnError)
	fs.SetOutput(stderr)
	showVersion := fs.Bool("version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		fmt.Fprintf(stdout, "orion %s\n", version.Version)
		return 0
	}
	fmt.Fprintln(stderr, "orion: the live map is not implemented yet")
	return 1
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `go test ./cmd/orion/ && go run ./cmd/orion --version`
Expected: `ok  	github.com/olliejudge/orion/cmd/orion`, then `orion dev`.

- [ ] **Step 7: Write the failing embedded-assets test, the fallback page and the static placeholder**

```bash
mkdir -p internal/webassets/static && touch internal/webassets/static/.gitkeep
```

`internal/webassets/fallback.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orion</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: radial-gradient(circle at 50% 30%, #1d1b3a, #07070c 70%);
         color: #e8e8f0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
  main { max-width: 28rem; padding: 2rem; border-radius: 16px;
         background: rgba(40, 40, 52, .45); border: 1px solid rgba(255, 255, 255, .10); }
  code { background: rgba(255, 255, 255, .08); padding: .1rem .35rem; border-radius: 6px; }
</style>
</head>
<body>
<main>
  <h1>Orion is running</h1>
  <p>This binary was built without the web UI. Run <code>make web</code> (or <code>make build</code>) and rebuild to embed it.</p>
</main>
</body>
</html>
```

`internal/webassets/embed_test.go`:

```go
package webassets

import (
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

func TestPickUsesBuiltUIWhenIndexExists(t *testing.T) {
	built := fstest.MapFS{
		"index.html":    {Data: []byte("<html>real ui</html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	got := pick(built)
	b, err := fs.ReadFile(got, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "<html>real ui</html>" {
		t.Fatalf("index.html = %q, want the built UI", b)
	}
	if _, err := fs.Stat(got, "assets/app.js"); err != nil {
		t.Fatalf("assets/app.js missing: %v", err)
	}
}

func TestPickFallsBackWithoutIndex(t *testing.T) {
	onlyKeep := fstest.MapFS{".gitkeep": {Data: nil}}
	got := pick(onlyKeep)
	b, err := fs.ReadFile(got, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "make web") {
		t.Fatalf("fallback index.html should tell the user to run make web, got %q", b)
	}
}

func TestFSAlwaysServesIndex(t *testing.T) {
	b, err := fs.ReadFile(FS(), "index.html")
	if err != nil {
		t.Fatalf("FS() has no index.html: %v", err)
	}
	if HasUI() == strings.Contains(string(b), "make web") {
		t.Fatalf("HasUI() = %v but index.html fallback-ness disagrees", HasUI())
	}
}
```

- [ ] **Step 8: Run it to verify it fails**

Run: `go test ./internal/webassets/`
Expected: FAIL (build failed) with `undefined: pick`, `undefined: FS`, `undefined: HasUI`.

- [ ] **Step 9: Implement `webassets`**

`internal/webassets/embed.go`. `testing/fstest` is a plain library package: it does not import `testing`, so it adds nothing to the binary beyond `MapFS`.

```go
// Package webassets embeds the built frontend. When the UI has not been built
// (static/ holds only .gitkeep), it serves fallback.html as index.html so that
// `go build` and `go test` work without Node.
package webassets

import (
	"embed"
	"io/fs"
	"testing/fstest"
)

//go:embed all:static
var static embed.FS

//go:embed fallback.html
var fallbackHTML []byte

// FS returns the files to serve at "/". It always contains index.html.
func FS() fs.FS {
	sub, err := fs.Sub(static, "static")
	if err != nil {
		panic(err) // "static" is a compile-time constant directory; cannot fail
	}
	return pick(sub)
}

// HasUI reports whether the real web UI was embedded at build time.
func HasUI() bool {
	_, err := fs.Stat(static, "static/index.html")
	return err == nil
}

func pick(built fs.FS) fs.FS {
	if _, err := fs.Stat(built, "index.html"); err == nil {
		return built
	}
	return fstest.MapFS{"index.html": {Data: fallbackHTML, Mode: 0o444}}
}
```

- [ ] **Step 10: Ignore build output in `static/`, then run the tests**

Append to `.gitignore`:

```
# Built web UI (only .gitkeep is committed)
internal/webassets/static/*
!internal/webassets/static/.gitkeep
```

Run: `go vet ./... && go test ./... && touch internal/webassets/static/index.html && git check-ignore internal/webassets/static/index.html && git check-ignore internal/webassets/static/.gitkeep; rm internal/webassets/static/index.html`
Expected: `ok` for `cmd/orion` and `internal/webassets`. The first `check-ignore` prints `internal/webassets/static/index.html`; the second prints nothing (exit 1), because `.gitkeep` stays tracked.

- [ ] **Step 11: Commit**

```bash
git add go.mod internal/version cmd/orion internal/webassets .gitignore
git commit -m "feat: add Go module, CLI stub and embedded web assets" \
  -m "go build and go test work without Node: when the UI is not built, the embedded fallback page is served as index.html." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 12: Add the Makefile, lint config and CI workflow**

`Makefile` (the recipe lines must start with a TAB):

```make
# Orion build entry points. `make help` lists targets.
GO      ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/olliejudge/orion/internal/version.Version=$(VERSION)
# Repo that `make dev` points orion at (default: this checkout).
REPO    ?= .

.PHONY: help build test lint web dev clean

help: ## List targets
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-8s %s\n", $$1, $$2}'

build: web ## Build the web UI (if present) and bin/orion
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/orion ./cmd/orion

test: ## Run Go tests (and web tests once web/ exists)
	$(GO) test ./...
	@if [ -f web/package.json ]; then pnpm -C web test; fi

lint: ## go vet + golangci-lint (and web lint once web/ exists)
	$(GO) vet ./...
	golangci-lint run
	@if [ -f web/package.json ]; then pnpm -C web lint; fi

web: ## Build web/ into internal/webassets/static (skipped when web/ is absent)
	@if [ -f web/package.json ]; then \
		pnpm -C web install --frozen-lockfile && pnpm -C web build; \
	else \
		echo "web/ not present yet: skipping UI build (the fallback page will be served)"; \
	fi

dev: ## Run the Go server with --dev plus Vite's dev server
	@if [ ! -f web/package.json ]; then echo "make dev needs web/ (added by the web scaffold task)"; exit 1; fi
	@trap 'kill 0' EXIT INT TERM; \
		$(GO) run ./cmd/orion --dev --no-open --port 7070 $(REPO) & \
		pnpm -C web dev

clean: ## Remove build output
	rm -rf bin dist
	find internal/webassets/static -mindepth 1 ! -name .gitkeep -exec rm -rf {} +
```

`.golangci.yml` (golangci-lint v2 format):

```yaml
version: "2"

linters:
  default: standard # errcheck, govet, ineffassign, staticcheck, unused
  enable:
    - bodyclose
    - errorlint
    - gocritic
    - misspell
    - nolintlint
    - unconvert
    - unparam
  settings:
    errcheck:
      exclude-functions:
        - fmt.Fprint
        - fmt.Fprintf
        - fmt.Fprintln
  exclusions:
    presets:
      - std-error-handling

formatters:
  enable:
    - gofmt
    - goimports
  settings:
    goimports:
      local-prefixes:
        - github.com/olliejudge/orion
```

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  go:
    name: go (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-go@v7
        with:
          go-version-file: go.mod
      - name: git version
        run: git --version
      - name: go vet
        run: go vet ./...
      - name: golangci-lint
        uses: golangci/golangci-lint-action@v9
        with:
          version: v2.13.2
      - name: go test
        run: go test -race -count=1 ./...

  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Detect web/
        id: detect
        run: |
          if [ -f web/package.json ]; then echo "present=true" >> "$GITHUB_OUTPUT"; else echo "present=false" >> "$GITHUB_OUTPUT"; fi
      - if: steps.detect.outputs.present == 'true'
        uses: pnpm/action-setup@v6
        with:
          version: 12
      - if: steps.detect.outputs.present == 'true'
        uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: web/pnpm-lock.yaml
      - if: steps.detect.outputs.present == 'true'
        run: pnpm -C web install --frozen-lockfile
      - if: steps.detect.outputs.present == 'true'
        run: pnpm -C web lint
      - if: steps.detect.outputs.present == 'true'
        run: pnpm -C web test
      - if: steps.detect.outputs.present == 'true'
        run: pnpm -C web build
      - if: steps.detect.outputs.present != 'true'
        run: echo "web/ not present yet; nothing to check"
```

- [ ] **Step 13: Fill in the Commands section of `CLAUDE.md`**

Replace the line `_To be filled in as the toolchain lands._` under `## Commands` with:

```markdown
- `make build`: build the web UI (when `web/` exists) into `internal/webassets/static/`, then `bin/orion`.
- `make test`: `go test ./...` (plus `pnpm -C web test` once `web/` exists).
- `make lint`: `go vet ./...` + `golangci-lint run` (plus `pnpm -C web lint` once `web/` exists).
- `make web`: build `web/` only; it is skipped with a message while `web/` does not exist.
- `make dev`: the Go server with `--dev` on port 7070, plus Vite's dev server (needs `web/`). Use `REPO=/path/to/repo make dev` to map another repo.
- One package or test: `go test ./internal/gitx -run TestStatus -v`.
- What CI runs: `go vet ./... && golangci-lint run && go test -race -count=1 ./...` on macOS and Linux.
- Toolchain: Go 1.27, git ≥ 2.30, golangci-lint v2.13.2 (`brew install golangci-lint` or `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2`), and pnpm 12 + Node 24 for `web/`.
```

- [ ] **Step 14: Verify the toolchain end to end**

Run: `make help && make web && make test && make lint`
Expected: the target list; `web/ not present yet: skipping UI build (the fallback page will be served)`; `ok` lines for `cmd/orion` and `internal/webassets`; and finally `0 issues.` from golangci-lint.

Optional: if `actionlint` is installed (`go install github.com/rhysd/actionlint/cmd/actionlint@latest`), `actionlint .github/workflows/ci.yml` prints nothing.

- [ ] **Step 15: Commit**

```bash
git add Makefile .golangci.yml .github/workflows/ci.yml CLAUDE.md
git commit -m "build: add Makefile, golangci-lint config and CI workflow" \
  -m "CI runs vet, golangci-lint and race-enabled tests on macOS and Linux; the web job activates once web/package.json exists." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 16: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin chore/foundation
gh pr create --base main --title "chore: foundation (module, CLI stub, embed, Makefile, lint, CI)" --body "$(cat <<'EOF'
Sets up the Go module, a `--version` CLI stub, the embedded web-asset package with its fallback page, the Makefile, the golangci-lint config and the CI workflow (macOS and Linux, plus a web job that turns on once `web/` exists). CLAUDE.md now lists the commands.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 2: `testrepo` synthetic repo builder

**Branch:** `test/testrepo` · **Depends on:** Task 1

**Files:**
- Create: `internal/testrepo/testrepo.go`
- Test: `internal/testrepo/testrepo_test.go`

**Interfaces:**
- Consumes: nothing (the Task 1 module only).
- Produces (`package testrepo`; every method fails the test via `t.Fatalf` on error):

```go
type Repo struct{ /* unexported */ }
func New(t testing.TB) *Repo                          // `git init --initial-branch=main` in t.TempDir(); commit.gpgsign=false
func (r *Repo) Path() string                         // absolute, symlinks resolved (/private/var/… on macOS)
func (r *Repo) Write(rel, content string)            // creates parent dirs
func (r *Repo) Remove(rel string)                    // os.RemoveAll on disk only
func (r *Repo) Move(from, to string)                 // plain os.Rename (git sees delete + untracked add)
func (r *Repo) GitMv(from, to string)                // `git mv`
func (r *Repo) Add(paths ...string)                  // no args = `git add -A`
func (r *Repo) Commit(msg string) string             // returns the new HEAD sha
func (r *Repo) Branch(name string)                   // create at HEAD, don't switch
func (r *Repo) Checkout(name string)
func (r *Repo) WorktreeAdd(path, branch string) *Repo // path relative to r or absolute; creates branch if missing
func (r *Repo) WorktreeRemove(path string)           // `git worktree remove --force`
func (r *Repo) Merge(branch string) string           // `merge --no-ff`, returns the new HEAD sha
func (r *Repo) Git(args ...string) string            // stdout with trailing newlines removed
```

  Git always runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, author and committer `Test <test@example.com>`, and dates of `2026-01-01T00:00:00Z` plus one minute per commit or merge. Worktrees share the counter, so identical operations produce identical shas.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/test-testrepo -b test/testrepo main
cd .claude/worktrees/test-testrepo
```

- [ ] **Step 2: Write the failing test**

`internal/testrepo/testrepo_test.go`:

```go
package testrepo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewRepoIsEmptyOnMain(t *testing.T) {
	r := New(t)
	if !filepath.IsAbs(r.Path()) {
		t.Fatalf("Path() = %q, want absolute", r.Path())
	}
	if got := r.Git("symbolic-ref", "--short", "HEAD"); got != "main" {
		t.Fatalf("HEAD -> %q, want main", got)
	}
	if got := r.Git("config", "commit.gpgsign"); got != "false" {
		t.Fatalf("commit.gpgsign = %q, want false", got)
	}
}

func TestCommitIsDeterministic(t *testing.T) {
	build := func() string {
		r := New(t)
		r.Write("a.txt", "hello\n")
		r.Write("dir/b.txt", "world\n")
		r.Add()
		return r.Commit("initial")
	}
	first, second := build(), build()
	if first != second {
		t.Fatalf("same operations gave different shas: %s vs %s", first, second)
	}
	if len(first) != 40 {
		t.Fatalf("sha %q is not 40 hex chars", first)
	}
}

func TestFileOps(t *testing.T) {
	r := New(t)
	r.Write("a.txt", "1")
	r.Write("b.txt", "2")
	r.Add("a.txt", "b.txt")
	r.Commit("two files")

	r.Move("a.txt", "moved/a.txt")
	if _, err := os.Stat(filepath.Join(r.Path(), "moved", "a.txt")); err != nil {
		t.Fatalf("Move did not create destination: %v", err)
	}
	r.GitMv("b.txt", "c.txt")
	r.Remove("moved/a.txt")
	status := r.Git("status", "--porcelain")
	for _, want := range []string{"R  b.txt -> c.txt", " D a.txt"} {
		if !strings.Contains(status, want) {
			t.Fatalf("status %q missing %q", status, want)
		}
	}
}

func TestBranchCheckoutMerge(t *testing.T) {
	r := New(t)
	r.Write("a.txt", "1")
	r.Add()
	base := r.Commit("base")
	r.Branch("feature")
	r.Checkout("feature")
	r.Write("f.txt", "feature")
	r.Add()
	feat := r.Commit("feature work")
	r.Checkout("main")
	merge := r.Merge("feature")
	if merge == base || merge == feat {
		t.Fatalf("Merge returned %s, want a new merge commit", merge)
	}
	if parents := strings.Fields(r.Git("rev-list", "--parents", "-n1", "HEAD")); len(parents) != 3 {
		t.Fatalf("HEAD is not a merge commit: %v", parents)
	}
}

func TestWorktreesNestedAndOutside(t *testing.T) {
	r := New(t)
	r.Write("a.txt", "1")
	r.Add()
	r.Commit("base")

	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")
	if want := filepath.Join(r.Path(), ".claude", "worktrees", "agent-x"); nested.Path() != want {
		t.Fatalf("nested Path() = %q, want %q", nested.Path(), want)
	}
	outside := r.WorktreeAdd(filepath.Join(t.TempDir(), "wt-out"), "outside")
	if strings.HasPrefix(outside.Path(), r.Path()) {
		t.Fatalf("outside worktree %q is inside the main root", outside.Path())
	}

	nested.Write("n.txt", "nested")
	nested.Add()
	nested.Commit("nested work")
	if got := nested.Git("rev-parse", "--abbrev-ref", "HEAD"); got != "agent-x" {
		t.Fatalf("nested branch = %q", got)
	}

	list := r.Git("worktree", "list", "--porcelain")
	for _, p := range []string{nested.Path(), outside.Path()} {
		if !strings.Contains(list, "worktree "+p) {
			t.Fatalf("worktree list missing %q:\n%s", p, list)
		}
	}

	r.WorktreeRemove(outside.Path())
	if strings.Contains(r.Git("worktree", "list", "--porcelain"), outside.Path()) {
		t.Fatal("WorktreeRemove left the worktree registered")
	}
	// Re-adding an existing branch checks it out instead of creating it.
	again := r.WorktreeAdd(filepath.Join(t.TempDir(), "again"), "outside")
	if got := again.Git("rev-parse", "--abbrev-ref", "HEAD"); got != "outside" {
		t.Fatalf("re-added branch = %q", got)
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `go test ./internal/testrepo/`
Expected: FAIL (build failed) with `undefined: New`.

- [ ] **Step 4: Implement the helper**

`internal/testrepo/testrepo.go`:

```go
// Package testrepo builds throwaway git repositories for tests. Every repo
// lives in t.TempDir(), uses deterministic author/committer identities and
// dates, ignores the user's global git config, and starts on branch main.
package testrepo

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Repo is a git working tree (the main one or a linked worktree).
type Repo struct {
	t     testing.TB
	root  string // absolute, symlinks resolved
	clock *int   // shared commit counter so dates increase across worktrees
}

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// New creates an empty repository on branch main.
func New(t testing.TB) *Repo {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("testrepo: resolve temp dir: %v", err)
	}
	r := &Repo{t: t, root: root, clock: new(int)}
	r.Git("init", "--quiet", "--initial-branch=main")
	r.Git("config", "commit.gpgsign", "false")
	r.Git("config", "tag.gpgsign", "false")
	r.Git("config", "core.autocrlf", "false")
	return r
}

// Path returns the absolute, symlink-resolved root of this working tree.
func (r *Repo) Path() string { return r.root }

func (r *Repo) abs(rel string) string {
	if filepath.IsAbs(rel) {
		return rel
	}
	return filepath.Join(r.root, filepath.FromSlash(rel))
}

// Write creates or overwrites rel (slash-separated, relative to Path) with
// content, creating parent directories as needed.
func (r *Repo) Write(rel, content string) {
	r.t.Helper()
	p := r.abs(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		r.t.Fatalf("testrepo: mkdir for %q: %v", rel, err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		r.t.Fatalf("testrepo: write %q: %v", rel, err)
	}
}

// Remove deletes rel from the working tree (not from the index).
func (r *Repo) Remove(rel string) {
	r.t.Helper()
	if err := os.RemoveAll(r.abs(rel)); err != nil {
		r.t.Fatalf("testrepo: remove %q: %v", rel, err)
	}
}

// Move renames a file on disk only, like a plain `mv` (git sees delete + add).
func (r *Repo) Move(from, to string) {
	r.t.Helper()
	dst := r.abs(to)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		r.t.Fatalf("testrepo: mkdir for %q: %v", to, err)
	}
	if err := os.Rename(r.abs(from), dst); err != nil {
		r.t.Fatalf("testrepo: move %q -> %q: %v", from, to, err)
	}
}

// GitMv renames with `git mv`, staging the rename.
func (r *Repo) GitMv(from, to string) {
	r.t.Helper()
	if err := os.MkdirAll(filepath.Dir(r.abs(to)), 0o755); err != nil {
		r.t.Fatalf("testrepo: mkdir for %q: %v", to, err)
	}
	r.Git("mv", "--", from, to)
}

// Add stages the given paths, or everything (`git add -A`) when none are given.
func (r *Repo) Add(paths ...string) {
	r.t.Helper()
	if len(paths) == 0 {
		r.Git("add", "-A")
		return
	}
	r.Git(append([]string{"add", "--"}, paths...)...)
}

// Commit commits the index with msg and returns the new HEAD sha.
func (r *Repo) Commit(msg string) string {
	r.t.Helper()
	r.Git("commit", "--quiet", "--no-verify", "-m", msg)
	return r.Git("rev-parse", "HEAD")
}

// Branch creates a branch at HEAD without switching to it.
func (r *Repo) Branch(name string) {
	r.t.Helper()
	r.Git("branch", "--", name)
}

// Checkout switches this working tree to an existing branch.
func (r *Repo) Checkout(name string) {
	r.t.Helper()
	r.Git("checkout", "--quiet", name, "--")
}

// Merge merges branch into the current branch with a merge commit and
// returns the new HEAD sha.
func (r *Repo) Merge(branch string) string {
	r.t.Helper()
	r.Git("merge", "--no-ff", "--quiet", "-m", "Merge "+branch, branch)
	return r.Git("rev-parse", "HEAD")
}

// WorktreeAdd adds a linked worktree at path (relative to this Repo's root,
// or absolute) on branch, creating the branch from HEAD if it does not exist.
func (r *Repo) WorktreeAdd(path, branch string) *Repo {
	r.t.Helper()
	dst := r.abs(path)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		r.t.Fatalf("testrepo: mkdir for worktree %q: %v", path, err)
	}
	if r.hasBranch(branch) {
		r.Git("worktree", "add", "--quiet", dst, branch)
	} else {
		r.Git("worktree", "add", "--quiet", "-b", branch, dst)
	}
	real, err := filepath.EvalSymlinks(dst)
	if err != nil {
		r.t.Fatalf("testrepo: resolve worktree %q: %v", path, err)
	}
	return &Repo{t: r.t, root: real, clock: r.clock}
}

// WorktreeRemove force-removes the linked worktree at path (relative or absolute).
func (r *Repo) WorktreeRemove(path string) {
	r.t.Helper()
	r.Git("worktree", "remove", "--force", r.abs(path))
}

func (r *Repo) hasBranch(name string) bool {
	cmd := exec.Command("git", "rev-parse", "--verify", "--quiet", "refs/heads/"+name)
	cmd.Dir = r.root
	cmd.Env = r.env()
	return cmd.Run() == nil
}

// Git runs git in this working tree and returns stdout with trailing
// newlines removed. It fails the test on error.
func (r *Repo) Git(args ...string) string {
	r.t.Helper()
	if len(args) > 0 && (args[0] == "commit" || args[0] == "merge") {
		*r.clock++
	}
	cmd := exec.Command("git", args...)
	cmd.Dir = r.root
	cmd.Env = r.env()
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		r.t.Fatalf("testrepo: git %s: %v\n%s", strings.Join(args, " "), err, stderr.String())
	}
	return strings.TrimRight(stdout.String(), "\n")
}

func (r *Repo) env() []string {
	date := epoch.Add(time.Duration(*r.clock) * time.Minute).Format(time.RFC3339)
	return append(os.Environ(),
		"GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=Test",
		"GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test",
		"GIT_COMMITTER_EMAIL=test@example.com",
		fmt.Sprintf("GIT_AUTHOR_DATE=%s", date),
		fmt.Sprintf("GIT_COMMITTER_DATE=%s", date),
	)
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `go vet ./internal/testrepo && go test -race -count=1 -v ./internal/testrepo/`
Expected: PASS for `TestNewRepoIsEmptyOnMain`, `TestCommitIsDeterministic`, `TestFileOps`, `TestBranchCheckoutMerge` and `TestWorktreesNestedAndOutside`.

- [ ] **Step 6: Commit**

```bash
git add internal/testrepo
git commit -m "test: add synthetic git repo builder for tests" \
  -m "Deterministic identities and dates, isolated from the user's git config, with nested and external linked worktrees." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin test/testrepo
gh pr create --base main --title "test: add testrepo synthetic repo builder" --body "$(cat <<'EOF'
Adds `internal/testrepo`, which builds throwaway git repos in `t.TempDir()` for tests: init on main, write/move/remove, commit, branch, merge, and linked worktrees both nested inside the root and outside it. Commits are deterministic and the helper ignores the user's global git config.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 3a: `gitx` runner, repo queries and worktrees

The skeleton's Task 3 is split in two: 3a (`feat/gitx-core`) and 3b (`feat/gitx-changes`). 3b depends on 3a. Task 8 depends on both.

**Branch:** `feat/gitx-core` · **Depends on:** Task 2

**Files:**
- Create: `internal/gitx/run.go`, `internal/gitx/repo.go`, `internal/gitx/worktrees.go`
- Test: `internal/gitx/run_test.go`, `internal/gitx/repo_test.go`, `internal/gitx/worktrees_test.go`

**Interfaces:**
- Consumes: `testrepo.New`, `(*Repo).Write/Add/Commit/Branch/Checkout/WorktreeAdd/Git/Path` (Task 2).
- Produces (exactly the Shared Interfaces names):

```go
type Runner struct{ Git string }
func (r Runner) Run(ctx context.Context, dir string, args ...string) ([]byte, error)
func CheckVersion(ctx context.Context, r Runner) (string, error)
func CommonDir(ctx context.Context, r Runner, dir string) (string, error)
func MainRoot(ctx context.Context, r Runner, dir string) (string, error)
func RevParse(ctx context.Context, r Runner, dir, rev string) (string, error)
func MergeBase(ctx context.Context, r Runner, dir, a, b string) (string, error) // "" + nil when the histories are unrelated
func ResolveBase(ctx context.Context, r Runner, dir, override string) (ref, sha string, err error)
func CommitSubject(ctx context.Context, r Runner, dir, sha string) (string, error)
type Worktree struct{ Path, Head, Branch string; Detached, Locked, Prunable, IsMain bool }
func ListWorktrees(ctx context.Context, r Runner, dir string) ([]Worktree, error)
func WorktreeAdminDir(wtPath string) (string, error)
```

  Behaviour later tasks rely on:
  - `Run` sets `GIT_OPTIONAL_LOCKS=0`, so `git status` never rewrites `.git/index`. Without it, every status call would wake our own watcher and loop forever.
  - Every absolute path returned (`CommonDir`, `MainRoot`, `Worktree.Path`, `WorktreeAdminDir`) is symlink-resolved, matching the paths the watcher reports.
  - `ResolveBase` returns short ref names: `origin/main`, `main`, `master`, the main worktree's branch, or a 7-character sha when that worktree is detached. An unknown override is an error. Falling back to HEAD (spec §8) is Task 8's job.
  - `Runner.Run`, `refuseOption`, `trimOut` and `realPath` are shared by Task 3b.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-gitx-core -b feat/gitx-core main
cd .claude/worktrees/feat-gitx-core
```

- [ ] **Step 2: Write the failing runner tests**

`internal/gitx/run_test.go`:

```go
package gitx

import (
	"context"
	"strings"
	"testing"
)

func TestParseVersion(t *testing.T) {
	tests := []struct {
		in           string
		want         string
		major, minor int
		wantErr      bool
	}{
		{in: "git version 2.39.5 (Apple Git-154)\n", want: "2.39.5", major: 2, minor: 39},
		{in: "git version 2.30.0\n", want: "2.30.0", major: 2, minor: 30},
		{in: "git version 2.45.1.windows.1\n", want: "2.45.1", major: 2, minor: 45},
		{in: "git version 3.0\n", want: "3.0", major: 3, minor: 0},
		{in: "not git\n", wantErr: true},
	}
	for _, tt := range tests {
		got, major, minor, err := parseVersion(tt.in)
		if tt.wantErr {
			if err == nil {
				t.Errorf("parseVersion(%q) = %q, want error", tt.in, got)
			}
			continue
		}
		if err != nil || got != tt.want || major != tt.major || minor != tt.minor {
			t.Errorf("parseVersion(%q) = %q %d.%d %v, want %q %d.%d", tt.in, got, major, minor, err, tt.want, tt.major, tt.minor)
		}
	}
}

func TestCheckVersionAcceptsInstalledGit(t *testing.T) {
	v, err := CheckVersion(context.Background(), Runner{})
	if err != nil {
		t.Fatalf("CheckVersion: %v", err)
	}
	if !strings.HasPrefix(v, "2.") && !strings.HasPrefix(v, "3.") {
		t.Fatalf("version %q looks wrong", v)
	}
}

func TestCheckVersionRejectsOldGit(t *testing.T) {
	if err := requireMinimum("2.29.3", 2, 29); err == nil {
		t.Fatal("2.29 accepted, want error")
	}
	if err := requireMinimum("1.9.0", 1, 9); err == nil {
		t.Fatal("1.9 accepted, want error")
	}
	if err := requireMinimum("2.30.0", 2, 30); err != nil {
		t.Fatalf("2.30 rejected: %v", err)
	}
}

func TestRunErrorIncludesArgsAndStderr(t *testing.T) {
	_, err := Runner{}.Run(context.Background(), t.TempDir(), "rev-parse", "--verify", "no-such-ref")
	if err == nil {
		t.Fatal("want error outside a repo")
	}
	msg := err.Error()
	if !strings.Contains(msg, "rev-parse --verify no-such-ref") || !strings.Contains(msg, "not a git repository") {
		t.Fatalf("error %q should name the args and include stderr", msg)
	}
}

func TestRunnerUsesCustomBinary(t *testing.T) {
	_, err := Runner{Git: "/nonexistent/git"}.Run(context.Background(), t.TempDir(), "version")
	if err == nil {
		t.Fatal("want error for missing binary")
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/gitx/`
Expected: FAIL (build failed) with `undefined: parseVersion`, `undefined: CheckVersion`, `undefined: Runner`.

- [ ] **Step 4: Implement the runner and the version check**

`internal/gitx/run.go`:

```go
// Package gitx is a thin, stateless wrapper over the git CLI. Every function
// execs the user's git and parses NUL-separated (-z) output where git offers it.
package gitx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// Runner execs git. The zero value runs "git" from PATH.
type Runner struct{ Git string }

func (r Runner) bin() string {
	if r.Git == "" {
		return "git"
	}
	return r.Git
}

// Run executes git with args in dir and returns stdout. The error names the
// command, the directory and git's stderr.
func (r Runner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, r.bin(), args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		// Never take optional locks (e.g. status refreshing the index): writes
		// under .git/ would wake our own watcher and loop forever.
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0",
		"LC_ALL=C",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), fmt.Errorf("git %s (in %s): %w: %s",
			strings.Join(args, " "), dir, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

var versionRE = regexp.MustCompile(`^git version (\d+)\.(\d+)(\.\d+)?`)

func parseVersion(out string) (version string, major, minor int, err error) {
	m := versionRE.FindStringSubmatch(strings.TrimSpace(out))
	if m == nil {
		return "", 0, 0, fmt.Errorf("unrecognised git version output %q", strings.TrimSpace(out))
	}
	major, _ = strconv.Atoi(m[1])
	minor, _ = strconv.Atoi(m[2])
	return m[1] + "." + m[2] + m[3], major, minor, nil
}

func requireMinimum(version string, major, minor int) error {
	if major < 2 || (major == 2 && minor < 30) {
		return fmt.Errorf("git %s is too old: orion needs git 2.30 or newer", version)
	}
	return nil
}

// CheckVersion returns the installed git version ("2.39.5"), or an error if
// git is missing or older than 2.30.
func CheckVersion(ctx context.Context, r Runner) (string, error) {
	out, err := r.Run(ctx, "", "version")
	if err != nil {
		return "", fmt.Errorf("git not found or not runnable: %w", err)
	}
	v, major, minor, err := parseVersion(string(out))
	if err != nil {
		return "", err
	}
	if err := requireMinimum(v, major, minor); err != nil {
		return "", err
	}
	return v, nil
}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `go test -count=1 ./internal/gitx/`
Expected: `ok  	github.com/olliejudge/orion/internal/gitx`.

- [ ] **Step 6: Commit**

```bash
git add internal/gitx
git commit -m "feat(gitx): add git runner and minimum version check" \
  -m "Runs with GIT_OPTIONAL_LOCKS=0 so status never rewrites the index and retriggers the watcher." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing repo and worktree tests**

These tests pin **Review Focus #3** (`TestListWorktreesPrunable`: a worktree whose directory vanished, plus a locked one). They also cover resolution from inside nested and outside linked worktrees, and every rung of the spec §2 base-branch ladder.

`internal/gitx/repo_test.go`:

```go
package gitx

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/olliejudge/orion/internal/testrepo"
)

var ctx = context.Background()

func TestCommonDirAndMainRootFromEverywhere(t *testing.T) {
	r := testrepo.New(t)
	r.Write("sub/dir/a.txt", "a")
	r.Add()
	r.Commit("base")
	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")
	outside := r.WorktreeAdd(filepath.Join(t.TempDir(), "outside"), "outside")

	for name, dir := range map[string]string{
		"root":    r.Path(),
		"subdir":  filepath.Join(r.Path(), "sub", "dir"),
		"nested":  nested.Path(),
		"outside": outside.Path(),
	} {
		common, err := CommonDir(ctx, Runner{}, dir)
		if err != nil {
			t.Fatalf("%s: CommonDir: %v", name, err)
		}
		if want := filepath.Join(r.Path(), ".git"); common != want {
			t.Errorf("%s: CommonDir = %q, want %q", name, common, want)
		}
		root, err := MainRoot(ctx, Runner{}, dir)
		if err != nil {
			t.Fatalf("%s: MainRoot: %v", name, err)
		}
		if root != r.Path() {
			t.Errorf("%s: MainRoot = %q, want %q", name, root, r.Path())
		}
	}
}

func TestMainRootErrors(t *testing.T) {
	if _, err := MainRoot(ctx, Runner{}, t.TempDir()); err == nil {
		t.Error("MainRoot outside a repo: want error")
	}
	bare := t.TempDir()
	if _, err := (Runner{}).Run(ctx, bare, "init", "--bare", "--quiet"); err != nil {
		t.Fatal(err)
	}
	if _, err := MainRoot(ctx, Runner{}, bare); err == nil {
		t.Error("MainRoot in a bare repo: want error")
	}
}

func TestRevParseMergeBaseSubject(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	base := r.Commit("base commit")
	r.Branch("feature")
	r.Checkout("feature")
	r.Write("b.txt", "b")
	r.Add()
	feat := r.Commit("feature: add b")
	r.Checkout("main")
	r.Write("c.txt", "c")
	r.Add()
	r.Commit("main moves on")

	got, err := RevParse(ctx, Runner{}, r.Path(), "feature")
	if err != nil || got != feat {
		t.Fatalf("RevParse(feature) = %q, %v; want %q", got, err, feat)
	}
	if _, err := RevParse(ctx, Runner{}, r.Path(), "no-such-branch"); err == nil {
		t.Error("RevParse(missing) should fail")
	}
	if _, err := RevParse(ctx, Runner{}, r.Path(), "--all"); err == nil {
		t.Error("RevParse must refuse revs that look like options")
	}

	mb, err := MergeBase(ctx, Runner{}, r.Path(), "main", "feature")
	if err != nil || mb != base {
		t.Fatalf("MergeBase = %q, %v; want %q", mb, err, base)
	}

	r.Git("checkout", "--quiet", "--orphan", "island")
	r.Git("rm", "-r", "--quiet", "--cached", ".")
	r.Write("island.txt", "i")
	r.Add("island.txt")
	r.Commit("unrelated root")
	mb, err = MergeBase(ctx, Runner{}, r.Path(), "main", "island")
	if err != nil || mb != "" {
		t.Fatalf("MergeBase of unrelated histories = %q, %v; want \"\", nil", mb, err)
	}

	subj, err := CommitSubject(ctx, Runner{}, r.Path(), feat)
	if err != nil || subj != "feature: add b" {
		t.Fatalf("CommitSubject = %q, %v", subj, err)
	}
}

func TestResolveBase(t *testing.T) {
	commit := func(r *testrepo.Repo, name string) string {
		r.Write(name, name)
		r.Add()
		return r.Commit("add " + name)
	}

	t.Run("unborn repo", func(t *testing.T) {
		r := testrepo.New(t)
		ref, sha, err := ResolveBase(ctx, Runner{}, r.Path(), "")
		if err != nil || ref != "" || sha != "" {
			t.Fatalf("got %q %q %v, want empty and nil", ref, sha, err)
		}
	})

	t.Run("local main", func(t *testing.T) {
		r := testrepo.New(t)
		sha := commit(r, "a")
		r.Branch("other")
		r.Checkout("other")
		commit(r, "b")
		assertBase(t, r.Path(), "", "main", sha)
	})

	t.Run("master when no main", func(t *testing.T) {
		r := testrepo.New(t)
		sha := commit(r, "a")
		r.Git("branch", "-m", "master")
		assertBase(t, r.Path(), "", "master", sha)
	})

	t.Run("current branch of main worktree", func(t *testing.T) {
		r := testrepo.New(t)
		commit(r, "a")
		r.Git("branch", "-m", "trunk")
		sha := commit(r, "b")
		wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "wt"), "side")
		commit(wt, "c")
		// Asked from the linked worktree, the answer is still the MAIN worktree's branch.
		assertBase(t, wt.Path(), "", "trunk", sha)
	})

	t.Run("detached main worktree", func(t *testing.T) {
		r := testrepo.New(t)
		sha := commit(r, "a")
		r.Git("checkout", "--quiet", "--detach")
		r.Git("branch", "-D", "--quiet", "main")
		assertBase(t, r.Path(), "", sha[:7], sha)
	})

	t.Run("origin HEAD wins over local main", func(t *testing.T) {
		remote := testrepo.New(t)
		remoteSha := commit(remote, "remote.txt")
		r := testrepo.New(t)
		commit(r, "local.txt")
		r.Git("remote", "add", "origin", remote.Path())
		r.Git("fetch", "--quiet", "origin")
		r.Git("remote", "set-head", "origin", "main")
		assertBase(t, r.Path(), "", "origin/main", remoteSha)
	})

	t.Run("override wins", func(t *testing.T) {
		r := testrepo.New(t)
		commit(r, "a")
		r.Branch("release")
		r.Checkout("release")
		sha := commit(r, "b")
		assertBase(t, r.Path(), "release", "release", sha)
		if _, _, err := ResolveBase(ctx, Runner{}, r.Path(), "nope"); err == nil {
			t.Fatal("unknown override: want error")
		}
	})
}

func assertBase(t *testing.T, dir, override, wantRef, wantSha string) {
	t.Helper()
	ref, sha, err := ResolveBase(ctx, Runner{}, dir, override)
	if err != nil {
		t.Fatalf("ResolveBase: %v", err)
	}
	if ref != wantRef || sha != wantSha {
		t.Fatalf("ResolveBase = %q %q, want %q %q", ref, sha, wantRef, wantSha)
	}
}

func TestWorktreeAdminDir(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	r.Commit("base")
	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")

	got, err := WorktreeAdminDir(r.Path())
	if err != nil || got != filepath.Join(r.Path(), ".git") {
		t.Fatalf("main admin dir = %q, %v", got, err)
	}
	got, err = WorktreeAdminDir(nested.Path())
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(r.Path(), ".git", "worktrees", "agent-x"); got != want {
		t.Fatalf("linked admin dir = %q, want %q", got, want)
	}
	if _, err := os.Stat(filepath.Join(got, "HEAD")); err != nil {
		t.Fatalf("admin dir has no HEAD: %v", err)
	}
	if _, err := WorktreeAdminDir(t.TempDir()); err == nil {
		t.Fatal("WorktreeAdminDir of a non-worktree: want error")
	}
}
```

`internal/gitx/worktrees_test.go`:

```go
package gitx

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/olliejudge/orion/internal/testrepo"
)

func TestListWorktrees(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	head := r.Commit("base")
	nested := r.WorktreeAdd(".claude/worktrees/agent-x", "agent-x")
	outside := r.WorktreeAdd(filepath.Join(t.TempDir(), "outside"), "feature/outside")
	detachedPath := filepath.Join(t.TempDir(), "detached")
	r.Git("worktree", "add", "--quiet", "--detach", detachedPath)
	detachedPath, _ = filepath.EvalSymlinks(detachedPath)

	// Ask from inside a linked worktree: the list is the same.
	wts, err := ListWorktrees(ctx, Runner{}, nested.Path())
	if err != nil {
		t.Fatal(err)
	}
	want := []Worktree{
		{Path: r.Path(), Head: head, Branch: "main", IsMain: true},
		{Path: nested.Path(), Head: head, Branch: "agent-x"},
		{Path: outside.Path(), Head: head, Branch: "feature/outside"},
		{Path: detachedPath, Head: head, Detached: true},
	}
	if len(wts) != len(want) {
		t.Fatalf("got %d worktrees, want %d: %+v", len(wts), len(want), wts)
	}
	byPath := map[string]Worktree{}
	for _, w := range wts {
		byPath[w.Path] = w
	}
	if wts[0] != want[0] {
		t.Errorf("first entry = %+v, want main %+v", wts[0], want[0])
	}
	for _, w := range want[1:] {
		if got := byPath[w.Path]; got != w {
			t.Errorf("worktree %s = %+v, want %+v", w.Path, got, w)
		}
	}
}

func TestListWorktreesPrunable(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "a")
	r.Add()
	r.Commit("base")
	gone := r.WorktreeAdd(filepath.Join(t.TempDir(), "gone"), "gone")
	locked := r.WorktreeAdd(filepath.Join(t.TempDir(), "locked"), "locked")
	r.Git("worktree", "lock", "--reason", "agent busy", locked.Path())
	if err := os.RemoveAll(gone.Path()); err != nil {
		t.Fatal(err)
	}

	wts, err := ListWorktrees(ctx, Runner{}, r.Path())
	if err != nil {
		t.Fatalf("ListWorktrees with a missing worktree dir: %v", err)
	}
	var sawGone, sawLocked bool
	for _, w := range wts {
		switch w.Path {
		case gone.Path():
			sawGone = true
			if !w.Prunable {
				t.Errorf("missing worktree not marked prunable: %+v", w)
			}
		case locked.Path():
			sawLocked = true
			if !w.Locked || w.Prunable {
				t.Errorf("locked worktree = %+v, want Locked and not Prunable", w)
			}
		}
	}
	if !sawGone || !sawLocked {
		t.Fatalf("missing entries in %+v", wts)
	}
}

func TestListWorktreesUnborn(t *testing.T) {
	r := testrepo.New(t)
	wts, err := ListWorktrees(ctx, Runner{}, r.Path())
	if err != nil {
		t.Fatal(err)
	}
	if len(wts) != 1 || wts[0].Head != "" || wts[0].Branch != "main" || !wts[0].IsMain {
		t.Fatalf("unborn repo worktrees = %+v", wts)
	}
}

func TestParseWorktreesBothSeparators(t *testing.T) {
	const zero = "0000000000000000000000000000000000000000"
	const sha = "1111111111111111111111111111111111111111"
	lines := []string{
		"worktree /repo", "HEAD " + sha, "branch refs/heads/main", "",
		"worktree /repo/.claude/worktrees/a b", "HEAD " + sha, "detached", "locked", "",
		"worktree /elsewhere/new", "HEAD " + zero, "branch refs/heads/new", "locked because\\nreasons", "prunable gitdir file points to non-existent location", "",
	}
	for _, sep := range []byte{0, '\n'} {
		var buf []byte
		for _, l := range lines {
			buf = append(buf, l...)
			buf = append(buf, sep)
		}
		got, bare := parseWorktrees(buf, sep)
		if bare {
			t.Fatalf("sep %q: reported bare", sep)
		}
		want := []Worktree{
			{Path: "/repo", Head: sha, Branch: "main", IsMain: true},
			{Path: "/repo/.claude/worktrees/a b", Head: sha, Detached: true, Locked: true},
			{Path: "/elsewhere/new", Branch: "new", Locked: true, Prunable: true},
		}
		if len(got) != len(want) {
			t.Fatalf("sep %q: got %+v", sep, got)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("sep %q entry %d = %+v, want %+v", sep, i, got[i], want[i])
			}
		}
	}
	got, bare := parseWorktrees([]byte("worktree /x.git\x00bare\x00\x00"), 0)
	if !bare || len(got) != 0 {
		t.Fatalf("bare repo parse = %+v bare=%v", got, bare)
	}
}
```

- [ ] **Step 8: Run them to verify they fail**

Run: `go test ./internal/gitx/`
Expected: FAIL (build failed) with `undefined: CommonDir`, `undefined: MainRoot`, `undefined: ListWorktrees`, `undefined: parseWorktrees`, and similar.

- [ ] **Step 9: Implement the repo queries and worktree listing**

`internal/gitx/repo.go`. Two notes on git 2.30 support: `--path-format=absolute` needs git 2.31, so relative `--git-common-dir` output is resolved against `dir`. `worktree list -z` needs git 2.36, so `ListWorktrees` tries `-z` first and falls back to newline-separated output.

```go
package gitx

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func trimOut(b []byte) string { return strings.TrimRight(string(b), "\r\n") }

// realPath makes p absolute and resolves symlinks when p exists, so paths
// compare equal to what the file watcher reports (e.g. /private/var on macOS).
func realPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	return abs
}

func refuseOption(rev string) error {
	if rev == "" || strings.HasPrefix(rev, "-") {
		return fmt.Errorf("invalid revision %q", rev)
	}
	return nil
}

// CommonDir returns the absolute git common dir (the main repo's .git) for dir.
func CommonDir(ctx context.Context, r Runner, dir string) (string, error) {
	// --path-format=absolute needs git 2.31; resolve relative output ourselves.
	out, err := r.Run(ctx, dir, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", err
	}
	p := trimOut(out)
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	return realPath(p), nil
}

// MainRoot returns the absolute top level of the MAIN worktree, even when dir
// is inside a linked worktree. Bare repositories are an error.
func MainRoot(ctx context.Context, r Runner, dir string) (string, error) {
	common, err := CommonDir(ctx, r, dir)
	if err != nil {
		return "", err
	}
	if filepath.Base(common) == ".git" {
		return filepath.Dir(common), nil
	}
	// Separate git dir or submodule: the first worktree entry is the main one.
	wts, bare, err := listWorktrees(ctx, r, dir)
	if err != nil {
		return "", err
	}
	if bare || len(wts) == 0 || !wts[0].IsMain {
		return "", fmt.Errorf("%s is a bare repository; run orion inside a worktree", common)
	}
	return wts[0].Path, nil
}

// RevParse resolves rev to a full commit sha. It errors when rev is missing.
func RevParse(ctx context.Context, r Runner, dir, rev string) (string, error) {
	if err := refuseOption(rev); err != nil {
		return "", err
	}
	out, err := r.Run(ctx, dir, "rev-parse", "--verify", "--quiet", rev+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("revision %q not found: %w", rev, err)
	}
	return trimOut(out), nil
}

// MergeBase returns the best common ancestor of a and b, or "" with a nil
// error when they share no history.
func MergeBase(ctx context.Context, r Runner, dir, a, b string) (string, error) {
	if err := refuseOption(a); err != nil {
		return "", err
	}
	if err := refuseOption(b); err != nil {
		return "", err
	}
	out, err := r.Run(ctx, dir, "merge-base", a, b)
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 && len(out) == 0 {
			return "", nil
		}
		return "", err
	}
	return trimOut(out), nil
}

// ResolveBase picks the base branch (spec §2): the override if given, else
// origin/HEAD's target, else local main, else master, else the main
// worktree's current branch (short sha when detached). A repo with no
// commits yields "", "", nil.
func ResolveBase(ctx context.Context, r Runner, dir, override string) (ref, sha string, err error) {
	if override != "" {
		sha, err := RevParse(ctx, r, dir, override)
		if err != nil {
			return "", "", fmt.Errorf("base branch %q: %w", override, err)
		}
		return override, sha, nil
	}
	if out, err := r.Run(ctx, dir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"); err == nil {
		full := trimOut(out)
		if sha, err := RevParse(ctx, r, dir, full); err == nil {
			return strings.TrimPrefix(full, "refs/remotes/"), sha, nil
		}
	}
	for _, name := range []string{"main", "master"} {
		if sha, err := RevParse(ctx, r, dir, "refs/heads/"+name); err == nil {
			return name, sha, nil
		}
	}
	wts, _, err := listWorktrees(ctx, r, dir)
	if err != nil {
		return "", "", err
	}
	if len(wts) == 0 || !wts[0].IsMain || wts[0].Head == "" {
		return "", "", nil
	}
	main := wts[0]
	if main.Branch != "" {
		return main.Branch, main.Head, nil
	}
	return main.Head[:7], main.Head, nil
}

// CommitSubject returns the first line of the commit message of sha.
func CommitSubject(ctx context.Context, r Runner, dir, sha string) (string, error) {
	if err := refuseOption(sha); err != nil {
		return "", err
	}
	out, err := r.Run(ctx, dir, "log", "-1", "--no-show-signature", "--format=%s", sha)
	if err != nil {
		return "", err
	}
	return trimOut(out), nil
}

// WorktreeAdminDir returns the git admin dir of a worktree: <wt>/.git for the
// main worktree, or the "gitdir:" target of <wt>/.git for a linked one
// (normally <common>/worktrees/<name>).
func WorktreeAdminDir(wtPath string) (string, error) {
	dotgit := filepath.Join(wtPath, ".git")
	fi, err := os.Stat(dotgit)
	if err != nil {
		return "", fmt.Errorf("%s is not a git worktree: %w", wtPath, err)
	}
	if fi.IsDir() {
		return realPath(dotgit), nil
	}
	b, err := os.ReadFile(dotgit)
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(b))
	target, ok := strings.CutPrefix(line, "gitdir: ")
	if !ok {
		return "", fmt.Errorf("%s: unexpected .git file contents %q", wtPath, line)
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(wtPath, target)
	}
	return realPath(target), nil
}
```

`internal/gitx/worktrees.go`:

```go
package gitx

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
)

// Worktree is one entry of `git worktree list --porcelain`.
type Worktree struct {
	Path     string // absolute
	Head     string // sha, "" if unborn
	Branch   string // short name, "" if detached
	Detached bool
	Locked   bool
	Prunable bool // directory missing
	IsMain   bool // first entry
}

// ListWorktrees lists the repo's worktrees, main first. Bare entries are
// skipped. Paths are symlink-resolved when the directory exists; a missing
// directory marks the entry Prunable.
func ListWorktrees(ctx context.Context, r Runner, dir string) ([]Worktree, error) {
	wts, _, err := listWorktrees(ctx, r, dir)
	return wts, err
}

func listWorktrees(ctx context.Context, r Runner, dir string) ([]Worktree, bool, error) {
	// -z needs git 2.36; fall back to newline-separated output on older git.
	out, err := r.Run(ctx, dir, "worktree", "list", "--porcelain", "-z")
	sep := byte(0)
	if err != nil {
		var err2 error
		out, err2 = r.Run(ctx, dir, "worktree", "list", "--porcelain")
		if err2 != nil {
			return nil, false, err
		}
		sep = '\n'
	}
	wts, bare := parseWorktrees(out, sep)
	for i := range wts {
		if _, err := os.Stat(wts[i].Path); err != nil {
			wts[i].Prunable = true
			continue
		}
		wts[i].Path = realPath(wts[i].Path)
	}
	return wts, bare, nil
}

// parseWorktrees parses porcelain records separated by sep, each ending with
// an empty field. It reports whether the first record was a bare repo.
func parseWorktrees(out []byte, sep byte) ([]Worktree, bool) {
	var (
		wts      []Worktree
		cur      Worktree
		inEntry  bool
		isBare   bool
		index    int
		bareRepo bool
	)
	flush := func() {
		if inEntry {
			if isBare {
				if index == 0 {
					bareRepo = true
				}
			} else {
				cur.IsMain = index == 0
				wts = append(wts, cur)
			}
			index++
		}
		cur, inEntry, isBare = Worktree{}, false, false
	}
	for _, field := range bytes.Split(out, []byte{sep}) {
		line := string(field)
		key, val, _ := strings.Cut(line, " ")
		switch key {
		case "":
			flush()
		case "worktree":
			flush()
			cur.Path = filepath.Clean(val)
			inEntry = true
		case "HEAD":
			if strings.Trim(val, "0") != "" {
				cur.Head = val
			}
		case "branch":
			cur.Branch = strings.TrimPrefix(val, "refs/heads/")
		case "detached":
			cur.Detached = true
		case "locked":
			cur.Locked = true
		case "prunable":
			cur.Prunable = true
		case "bare":
			isBare = true
		}
	}
	flush()
	return wts, bareRepo
}
```

- [ ] **Step 10: Run them to verify they pass**

Run: `go vet ./internal/gitx && go test -race -count=1 -v ./internal/gitx/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: every test reports `--- PASS`, including `TestListWorktreesPrunable` and all `TestResolveBase` subtests, then `ok  	github.com/olliejudge/orion/internal/gitx`.

- [ ] **Step 11: Commit**

```bash
git add internal/gitx
git commit -m "feat(gitx): resolve repo root, base branch and worktrees" \
  -m "MainRoot works from linked worktrees; ResolveBase follows spec §2; ListWorktrees marks missing directories prunable." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 12: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin feat/gitx-core
gh pr create --base main --title "feat(gitx): runner, repo queries and worktree listing" --body "$(cat <<'EOF'
Adds the core of `internal/gitx`: an exec runner (with `GIT_OPTIONAL_LOCKS=0`), the git ≥ 2.30 check, CommonDir/MainRoot, RevParse, MergeBase, ResolveBase (spec §2 order), CommitSubject, ListWorktrees (with prunable and locked entries) and WorktreeAdminDir. Everything is tested against synthetic repos from `testrepo`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 3b: `gitx` tree listing, diffs, status and move pairing

**Branch:** `feat/gitx-changes` · **Depends on:** Task 3a

**Files:**
- Create: `internal/gitx/tree.go`, `internal/gitx/changes.go`
- Test: `internal/gitx/tree_test.go`, `internal/gitx/changes_test.go`

**Interfaces:**
- Consumes (Task 3a): `Runner`, `refuseOption(rev string) error`, `trimOut([]byte) string`, and the test-only `ctx` variable declared in `repo_test.go`. From Task 2: `testrepo`.
- Produces:

```go
type FileEntry struct{ Path string; Size int64 } // submodules: Size 0
func LsTree(ctx context.Context, r Runner, dir, rev string) ([]FileEntry, error) // rev "" → nil, nil
type ChangeKind string
const (Added ChangeKind = "added"; Modified ChangeKind = "modified"; Deleted ChangeKind = "deleted"; Renamed ChangeKind = "renamed")
type Change struct{ Path string; From string; Kind ChangeKind }
func DiffNameStatus(ctx context.Context, r Runner, dir, from, to string) ([]Change, error) // from "" = empty tree; copies → Added
func Status(ctx context.Context, r Runner, wtDir string) ([]Change, error)
func PairMoves(changes []Change) []Change
```

  Status semantics:
  - `XY` = `AD` (added, then deleted) is dropped.
  - Any other `D` in `X` or `Y` → Deleted.
  - `A` in `X` → Added.
  - Everything else (`M`, `T`, unmerged `u`) → Modified.
  - A staged rename (`2 R.`) → Renamed{Path: new, From: old}; if the renamed file was then deleted (`2 RD`), it becomes Deleted{Path: old}.
  - Untracked `?` → Added, except entries ending in `/` (nested repos and nested worktrees), which are dropped.

  `DiffNameStatus` runs the plumbing command `git diff-tree -r -z -M --name-status`. Its output format is the same as `git diff --name-status -M -z`, but it ignores user `diff.*` config such as `diff.relative` or external drivers.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-gitx-changes -b feat/gitx-changes main
cd .claude/worktrees/feat-gitx-changes
```

- [ ] **Step 2: Write the failing tree tests**

This pins **Review Focus #2** for trees (`TestLsTreeAwkwardPaths`: spaces, unicode, quotes, a leading dash, a newline, a tab and a backslash). `awkwardNames` is reused by `changes_test.go`.

`internal/gitx/tree_test.go`:

```go
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
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/gitx/`
Expected: FAIL (build failed) with `undefined: LsTree` and `undefined: FileEntry`.

- [ ] **Step 4: Implement `LsTree`**

`internal/gitx/tree.go`:

```go
package gitx

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
)

// FileEntry is one file of a tree. Submodules have Size 0.
type FileEntry struct {
	Path string
	Size int64
}

// LsTree lists every file in rev's tree (recursively, whole repo even when
// dir is a subdirectory). An empty rev (unborn repo) yields nil.
func LsTree(ctx context.Context, r Runner, dir, rev string) ([]FileEntry, error) {
	if rev == "" {
		return nil, nil
	}
	if err := refuseOption(rev); err != nil {
		return nil, err
	}
	out, err := r.Run(ctx, dir, "ls-tree", "-r", "-l", "-z", "--full-tree", rev)
	if err != nil {
		return nil, err
	}
	return parseLsTree(out)
}

// parseLsTree parses records "<mode> <type> <object> <size>\t<path>\x00";
// size is space-padded and "-" for submodules (type "commit").
func parseLsTree(out []byte) ([]FileEntry, error) {
	var entries []FileEntry
	for _, rec := range bytes.Split(out, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		meta, path, ok := bytes.Cut(rec, []byte{'\t'})
		if !ok {
			return nil, fmt.Errorf("ls-tree: malformed record %q", rec)
		}
		fields := strings.Fields(string(meta))
		if len(fields) != 4 {
			return nil, fmt.Errorf("ls-tree: malformed metadata %q", meta)
		}
		var size int64
		if fields[1] == "blob" {
			n, err := strconv.ParseInt(fields[3], 10, 64)
			if err != nil {
				return nil, fmt.Errorf("ls-tree: bad size in %q: %w", meta, err)
			}
			size = n
		}
		entries = append(entries, FileEntry{Path: string(path), Size: size})
	}
	return entries, nil
}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `go test -count=1 -run 'LsTree' -v ./internal/gitx/`
Expected: `--- PASS` for `TestLsTree`, `TestLsTreeFromSubdirListsWholeTree`, `TestLsTreeEmptyRev` and `TestLsTreeAwkwardPaths`.

- [ ] **Step 6: Commit**

```bash
git add internal/gitx/tree.go internal/gitx/tree_test.go
git commit -m "feat(gitx): list base tree files with sizes" \
  -m "Parses ls-tree -r -l -z so any file name round-trips; submodule entries get size 0." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing change tests**

These pin **Review Focus #1** (`TestStatusDropsNestedWorktreeDir`: the main worktree's status must not include a nested worktree or anything inside it), **#2** (`TestStatusAwkwardPaths`) and **#5** (`TestPairMoves`: a plain `mv` becomes one rename).

`internal/gitx/changes_test.go`:

```go
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
	raw := strings.Join([]string{
		"# branch.oid " + sha,
		"# branch.head main",
		"1 .M N... 100644 100644 100644 " + sha + " " + sha + " mod with space.txt",
		"1 A. N... 000000 100644 100644 " + sha + " " + sha + " new\nline.txt",
		"1 .D N... 100644 100644 000000 " + sha + " " + sha + " gone.txt",
		"1 AD N... 000000 100644 000000 " + sha + " " + sha + " transient.txt",
		"2 R. N... 100644 100644 100644 " + sha + " " + sha + " R100 to dir/b.txt",
		"from a.txt",
		"2 RD N... 100644 100644 000000 " + sha + " " + sha + " R100 moved-then-deleted.txt",
		"orig.txt",
		"u UU N... 100644 100644 100644 100644 " + sha + " " + sha + " " + sha + " conflict.txt",
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
		{Path: "untracked/-dash.txt", Kind: Added},
	})
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
```

- [ ] **Step 8: Run them to verify they fail**

Run: `go test ./internal/gitx/`
Expected: FAIL (build failed) with `undefined: Change`, `undefined: DiffNameStatus`, `undefined: Status`, `undefined: PairMoves`, and similar.

- [ ] **Step 9: Implement diffs, status and move pairing**

`internal/gitx/changes.go`:

```go
package gitx

import (
	"bytes"
	"context"
	"os"
	"path"
	"strings"
)

// ChangeKind is how a path differs from the comparison point.
type ChangeKind string

const (
	Added    ChangeKind = "added"
	Modified ChangeKind = "modified"
	Deleted  ChangeKind = "deleted"
	Renamed  ChangeKind = "renamed"
)

// Change is one changed path. From is set only for Renamed.
type Change struct {
	Path string
	From string
	Kind ChangeKind
}

// DiffNameStatus lists changes between two commits with rename detection.
// Copies are reported as Added. from == "" means the empty tree.
func DiffNameStatus(ctx context.Context, r Runner, dir, from, to string) ([]Change, error) {
	if from == "" {
		empty, err := r.Run(ctx, dir, "hash-object", "-t", "tree", os.DevNull)
		if err != nil {
			return nil, err
		}
		from = trimOut(empty)
	}
	if err := refuseOption(from); err != nil {
		return nil, err
	}
	if err := refuseOption(to); err != nil {
		return nil, err
	}
	// diff-tree is plumbing: unlike `git diff` it ignores diff.* user config
	// (diff.relative, external drivers, colour) and always prints root-relative paths.
	out, err := r.Run(ctx, dir, "diff-tree", "-r", "-z", "-M", "--name-status", "--no-commit-id", from, to)
	if err != nil {
		return nil, err
	}
	return parseNameStatus(out), nil
}

func parseNameStatus(out []byte) []Change {
	fields := strings.Split(string(out), "\x00")
	var changes []Change
	for i := 0; i < len(fields); i++ {
		status := fields[i]
		if status == "" {
			continue
		}
		switch status[0] {
		case 'R', 'C':
			if i+2 >= len(fields) {
				return changes
			}
			from, to := fields[i+1], fields[i+2]
			i += 2
			if status[0] == 'R' {
				changes = append(changes, Change{Path: to, From: from, Kind: Renamed})
			} else {
				changes = append(changes, Change{Path: to, Kind: Added})
			}
		default:
			if i+1 >= len(fields) {
				return changes
			}
			p := fields[i+1]
			i++
			switch status[0] {
			case 'A':
				changes = append(changes, Change{Path: p, Kind: Added})
			case 'D':
				changes = append(changes, Change{Path: p, Kind: Deleted})
			case 'M', 'T', 'U':
				changes = append(changes, Change{Path: p, Kind: Modified})
			}
		}
	}
	return changes
}

// Status lists the uncommitted changes of the worktree at wtDir (staged,
// unstaged and untracked, with staged renames). Untracked directory entries
// (trailing "/", i.e. nested repos or nested worktrees) are dropped.
func Status(ctx context.Context, r Runner, wtDir string) ([]Change, error) {
	out, err := r.Run(ctx, wtDir, "status", "--porcelain=v2", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	return parseStatus(out), nil
}

func parseStatus(out []byte) []Change {
	fields := bytes.Split(out, []byte{0})
	var changes []Change
	for i := 0; i < len(fields); i++ {
		line := string(fields[i])
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case '1': // 1 XY sub mH mI mW hH hI path
			parts := strings.SplitN(line, " ", 9)
			if len(parts) != 9 {
				continue
			}
			if kind, ok := kindForXY(parts[1][0], parts[1][1]); ok {
				changes = append(changes, Change{Path: parts[8], Kind: kind})
			}
		case '2': // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
			parts := strings.SplitN(line, " ", 10)
			if len(parts) != 10 || i+1 >= len(fields) {
				continue
			}
			orig := string(fields[i+1])
			i++
			x, y := parts[1][0], parts[1][1]
			switch {
			case y == 'D':
				changes = append(changes, Change{Path: orig, Kind: Deleted})
			case x == 'C':
				changes = append(changes, Change{Path: parts[9], Kind: Added})
			default:
				changes = append(changes, Change{Path: parts[9], From: orig, Kind: Renamed})
			}
		case 'u': // u XY sub m1 m2 m3 mW h1 h2 h3 path
			parts := strings.SplitN(line, " ", 11)
			if len(parts) == 11 {
				changes = append(changes, Change{Path: parts[10], Kind: Modified})
			}
		case '?':
			p := line[2:]
			if !strings.HasSuffix(p, "/") {
				changes = append(changes, Change{Path: p, Kind: Added})
			}
		}
	}
	return changes
}

func kindForXY(x, y byte) (ChangeKind, bool) {
	switch {
	case x == 'A' && y == 'D':
		return "", false // added to the index, then deleted: nothing left
	case x == 'D' || y == 'D':
		return Deleted, true
	case x == 'A':
		return Added, true
	default:
		return Modified, true
	}
}

// PairMoves turns a Deleted + Added pair whose basenames match (and are
// unique among deletions and additions) into one Renamed{Path: added, From:
// deleted}, placed where the Added entry was. Other entries keep their order.
func PairMoves(changes []Change) []Change {
	deleted := map[string][]int{}
	added := map[string][]int{}
	for i, c := range changes {
		switch c.Kind {
		case Deleted:
			deleted[path.Base(c.Path)] = append(deleted[path.Base(c.Path)], i)
		case Added:
			added[path.Base(c.Path)] = append(added[path.Base(c.Path)], i)
		}
	}
	drop := map[int]bool{}
	replace := map[int]Change{}
	for name, ds := range deleted {
		as := added[name]
		if len(ds) == 1 && len(as) == 1 {
			drop[ds[0]] = true
			replace[as[0]] = Change{Path: changes[as[0]].Path, From: changes[ds[0]].Path, Kind: Renamed}
		}
	}
	out := make([]Change, 0, len(changes)-len(drop))
	for i, c := range changes {
		if drop[i] {
			continue
		}
		if rc, ok := replace[i]; ok {
			c = rc
		}
		out = append(out, c)
	}
	return out
}
```

- [ ] **Step 10: Run them to verify they pass**

Run: `go vet ./internal/gitx && go test -race -count=1 -v ./internal/gitx/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: all tests `--- PASS`, including `TestStatusDropsNestedWorktreeDir`, `TestStatusAwkwardPaths`, `TestLsTreeAwkwardPaths`, `TestListWorktreesPrunable` and `TestPairMoves`, then `ok  	github.com/olliejudge/orion/internal/gitx`.

- [ ] **Step 11: Commit**

```bash
git add internal/gitx/changes.go internal/gitx/changes_test.go
git commit -m "feat(gitx): parse committed diffs, working-tree status and plain moves" \
  -m "Status drops nested worktree directories so their files never count against the main worktree." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 12: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin feat/gitx-changes
gh pr create --base main --title "feat(gitx): tree listing, diffs, status and move pairing" --body "$(cat <<'EOF'
Adds LsTree, DiffNameStatus (diff-tree -M -z), Status (porcelain v2 -z, all untracked, dropping nested-worktree directory entries) and PairMoves, which turns a plain mv into a rename. Pins Review Focus tests for nested worktrees, awkward file names and plain moves.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 4: `model` types, Store, diff and activity

**Branch:** `feat/model` · **Depends on:** Task 1

**Files:**
- Create: `internal/model/types.go`, `internal/model/colors.go`, `internal/model/diff.go`
- Test: `internal/model/types_test.go`, `internal/model/diff_test.go`, `internal/model/colors_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: exactly the `internal/model` block in Shared Interfaces (`WorktreeID`, `IDFor`, `Kind`, `Stage`, `Uncommitted`, `Committed`, `ChangeEntry`, `File`, `Worktree`, `RepoInfo`, `State`, `Activity`, `BasePatch`, `OverlayPatch`, `Snapshot`, `Patch`, `Store`, `NewStore`, `(*Store).Apply`, `(*Store).Snapshot`, `(*Store).State`), **plus** the constants `Added`, `Modified`, `Deleted` and `Renamed` of type `Kind`.

  Rules that Tasks 6–12 rely on (each one has a test):
  1. **Seq.** A snapshot starts at seq 1. Each patch that changes something gets the next seq (2, 3, …). An unchanged `Apply` returns `false` and does not advance seq. `Store` is safe for concurrent use.
  2. **Worktrees.** `Patch.Worktrees` is the full list, sorted main first and then by `Path`, sent whenever any wire field changed, including `ColorIndex`. `HeadSubject` alone never triggers a patch.
  3. **Base.** `Patch.Base` is present when the tree or the base sha changed. `Upsert` holds new and resized files, sorted by path; `Remove` holds files that disappeared, sorted. Both marshal as `[]`, never `null`.
  4. **Overlays.** `Patch.Overlays[id]` upserts entries that are new or changed and removes paths that disappeared. A worktree that disappears has all its paths removed. Worktrees with no change are omitted.
  5. **File activity.** A new or changed **uncommitted** entry produces a row with its kind. When an uncommitted entry keeps its kind and `From` and only its size changed, the row is `modified` (an edit, even if the file is untracked). A `modified` row is dropped if the same worktree and path had any file row less than 5 s earlier.
  6. **Commit activity.** When a worktree that existed before now has a different `Head` but the same `Branch`, and at least one of its entries went uncommitted → committed or appeared as committed, it gets one `commit` row: `{Sha: Head, Subject: HeadSubject, Files: n}`. A branch change is a checkout, not a commit.
  7. **Merge activity.** When `BaseSha` changed, each worktree still present that lost `n > 0` overlay paths gets one `merge` row `{Sha: new BaseSha, Files: n}`.
  8. **Row order and ring.** Rows are ordered by worktree order, then file rows by path, then the commit row, then the merge row, all stamped with `TS = now.UnixMilli()`. The ring keeps the newest 200 rows, oldest first.
  9. **Colours.** The main worktree is always 0. Another worktree gets the lowest unused index 1–9 the first time it has a non-empty overlay or an activity row (including at `NewStore`). It keeps that index for the session, and removing it frees nothing. Once 1–9 are all used, indices are reused round-robin starting at 1. A worktree with no colour has `-1`.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-model -b feat/model main
cd .claude/worktrees/feat-model
```

- [ ] **Step 2: Write the failing type and JSON golden tests**

The golden strings are the wire contract that `web/src/protocol.ts` (Task 9) mirrors. Change them only together with the TS types.

`internal/model/types_test.go`:

```go
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
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/model/`
Expected: FAIL (build failed) with `undefined: IDFor`, `undefined: Patch`, `undefined: Snapshot`, and similar.

- [ ] **Step 4: Implement the types**

`internal/model/types.go`:

```go
// Package model holds orion's pure state: the base tree, per-worktree
// overlays and the activity stream. It has no I/O. Store.Apply diffs a new
// State against the previous one and returns the wire Patch.
package model

import (
	"crypto/sha256"
	"encoding/hex"
)

// WorktreeID is the hex of the first 8 bytes of sha256(absolute path).
type WorktreeID string

// IDFor returns the stable id of the worktree at absPath.
func IDFor(absPath string) WorktreeID {
	sum := sha256.Sum256([]byte(absPath))
	return WorktreeID(hex.EncodeToString(sum[:8]))
}

// Kind is how an overlay entry differs from base.
type Kind string

const (
	Added    Kind = "added"
	Modified Kind = "modified"
	Deleted  Kind = "deleted"
	Renamed  Kind = "renamed"
)

// Stage is where a change lives: in the working tree or committed on the
// worktree's branch but not yet in base.
type Stage string

const (
	Uncommitted Stage = "uncommitted"
	Committed   Stage = "committed"
)

// ChangeEntry is one path in a worktree's overlay.
type ChangeEntry struct {
	Path  string `json:"path"`
	Kind  Kind   `json:"kind"`
	From  string `json:"from,omitempty"`
	Stage Stage  `json:"stage"`
	Size  int64  `json:"size"`
}

// File is one base-tree file.
type File struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// Worktree is one git worktree as sent to clients.
type Worktree struct {
	ID          WorktreeID `json:"id"`
	Path        string     `json:"path"`
	Label       string     `json:"label"` // branch, else short sha, else "main"
	Branch      string     `json:"branch,omitempty"`
	Head        string     `json:"head"`
	IsMain      bool       `json:"isMain"`
	Locked      bool       `json:"locked"`
	ColorIndex  int        `json:"colorIndex"` // assigned by Store; -1 = not yet active
	HeadSubject string     `json:"-"`          // filled by repo; used for commit activity
}

// RepoInfo names the repo and its base branch.
type RepoInfo struct {
	Name    string `json:"name"`
	Base    string `json:"base"`
	BaseSha string `json:"baseSha"`
}

// State is a full, immutable-by-convention view; repo builds a new one per recompute.
type State struct {
	Repo      RepoInfo
	Worktrees []Worktree                            // sorted: main first, then by Path
	Tree      map[string]int64                      // base tree path → size
	Overlays  map[WorktreeID]map[string]ChangeEntry // absent/empty map = no changes
}

// Activity is one row of the activity stream.
type Activity struct {
	TS       int64      `json:"ts"` // unix ms
	Worktree WorktreeID `json:"worktree"`
	Kind     string     `json:"kind"` // added|modified|deleted|renamed|commit|merge
	Path     string     `json:"path,omitempty"`
	From     string     `json:"from,omitempty"`
	Sha      string     `json:"sha,omitempty"`
	Subject  string     `json:"subject,omitempty"`
	Files    int        `json:"files,omitempty"`
}

// BasePatch updates the base tree.
type BasePatch struct {
	Sha    string   `json:"sha"`
	Upsert []File   `json:"upsert"`
	Remove []string `json:"remove"`
}

// OverlayPatch updates one worktree's overlay.
type OverlayPatch struct {
	Upsert []ChangeEntry `json:"upsert"`
	Remove []string      `json:"remove"`
}

// Snapshot is the full state sent to a newly connected client.
type Snapshot struct {
	Type      string                       `json:"type"` // "snapshot"
	Seq       uint64                       `json:"seq"`
	Repo      RepoInfo                     `json:"repo"`
	Worktrees []Worktree                   `json:"worktrees"`
	Tree      []File                       `json:"tree"`     // sorted by path
	Overlays  map[WorktreeID][]ChangeEntry `json:"overlays"` // sorted by path
	Activity  []Activity                   `json:"activity"` // oldest→newest, ≤200
}

// Patch is an incremental update; absent fields mean "unchanged".
type Patch struct {
	Type      string                      `json:"type"` // "patch"
	Seq       uint64                      `json:"seq"`
	Worktrees []Worktree                  `json:"worktrees,omitempty"`
	Base      *BasePatch                  `json:"base,omitempty"`
	Overlays  map[WorktreeID]OverlayPatch `json:"overlays,omitempty"`
	Activity  []Activity                  `json:"activity,omitempty"`
}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `go test -count=1 ./internal/model/`
Expected: `ok  	github.com/olliejudge/orion/internal/model`.

- [ ] **Step 6: Commit**

```bash
git add internal/model
git commit -m "feat(model): add wire and state types with JSON golden tests" \
  -m "Golden strings pin the field names the TypeScript client depends on." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing Store, diff, activity and colour tests**

`internal/model/diff_test.go`:

```go
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
```

`internal/model/colors_test.go`:

```go
package model

import (
	"fmt"
	"testing"
)

func agent(n int) Worktree {
	p := fmt.Sprintf("/wt/agent-%02d", n)
	return Worktree{ID: IDFor(p), Path: p, Label: p, Branch: p, Head: "h1"}
}

func colourOf(s *Store, id WorktreeID) int {
	for _, w := range s.Snapshot().Worktrees {
		if w.ID == id {
			return w.ColorIndex
		}
	}
	return -2
}

func TestColoursInOrderOfFirstActivity(t *testing.T) {
	a, b, c := agent(1), agent(2), agent(3)
	all := []Worktree{mainWT, a, b, c}
	s := NewStore(st("b1", nil, all, nil), t0)
	if colourOf(s, mainID) != 0 || colourOf(s, a.ID) != -1 {
		t.Fatalf("initial colours: main %d, a %d", colourOf(s, mainID), colourOf(s, a.ID))
	}

	// b becomes active before a, so b gets 1.
	s.Apply(st("b1", nil, all, overlays{b.ID: entries(unc("x", Added, 1))}), at(1))
	s.Apply(st("b1", nil, all, overlays{b.ID: entries(unc("x", Added, 1)), a.ID: entries(unc("y", Added, 1))}), at(2))
	if colourOf(s, b.ID) != 1 || colourOf(s, a.ID) != 2 {
		t.Fatalf("b=%d a=%d, want 1 and 2", colourOf(s, b.ID), colourOf(s, a.ID))
	}

	// b goes idle and then is removed: its colour is not freed, so c gets 3.
	s.Apply(st("b1", nil, []Worktree{mainWT, a, c}, overlays{a.ID: entries(unc("y", Added, 1))}), at(3))
	s.Apply(st("b1", nil, []Worktree{mainWT, a, c}, overlays{a.ID: entries(unc("y", Added, 1)), c.ID: entries(unc("z", Added, 1))}), at(4))
	if colourOf(s, c.ID) != 3 {
		t.Fatalf("c = %d, want 3 (removed worktrees keep their colour)", colourOf(s, c.ID))
	}

	// b comes back: same colour as before.
	s.Apply(st("b1", nil, all, nil), at(5))
	if colourOf(s, b.ID) != 1 {
		t.Fatalf("returning b = %d, want 1", colourOf(s, b.ID))
	}
	if colourOf(s, a.ID) != 2 {
		t.Fatalf("idle a lost its colour: %d", colourOf(s, a.ID))
	}
}

func TestColoursRoundRobinWhenExhausted(t *testing.T) {
	wts := []Worktree{mainWT}
	for i := 1; i <= 11; i++ {
		wts = append(wts, agent(i))
	}
	s := NewStore(st("b1", nil, wts, nil), t0)
	ov := overlays{}
	for i := 1; i <= 11; i++ {
		ov[agent(i).ID] = entries(unc("f", Added, 1))
		next := overlays{}
		for k, v := range ov {
			next[k] = v
		}
		s.Apply(st("b1", nil, wts, next), at(float64(i)))
	}
	for i := 1; i <= 9; i++ {
		if got := colourOf(s, agent(i).ID); got != i {
			t.Fatalf("agent %d colour = %d, want %d", i, got, i)
		}
	}
	if got := colourOf(s, agent(10).ID); got != 1 {
		t.Fatalf("agent 10 colour = %d, want 1 (round-robin)", got)
	}
	if got := colourOf(s, agent(11).ID); got != 2 {
		t.Fatalf("agent 11 colour = %d, want 2 (round-robin)", got)
	}
	if colourOf(s, mainID) != 0 {
		t.Fatal("main lost colour 0")
	}
}

func TestStartupOverlayAssignsColour(t *testing.T) {
	a, idle := agent(1), agent(2)
	s := NewStore(st("b1", nil, []Worktree{mainWT, idle, a}, overlays{a.ID: entries(com("c", Added, 1))}), t0)
	if colourOf(s, a.ID) != 1 {
		t.Fatalf("agent with committed work at startup = %d, want 1", colourOf(s, a.ID))
	}
	if colourOf(s, idle.ID) != -1 {
		t.Fatalf("idle agent = %d, want -1", colourOf(s, idle.ID))
	}
}
```

- [ ] **Step 8: Run them to verify they fail**

Run: `go test ./internal/model/`
Expected: FAIL (build failed) with `undefined: Store` and `undefined: NewStore`.

- [ ] **Step 9: Implement colour assignment**

`internal/model/colors.go`:

```go
package model

// paletteSize is the number of worktree colours (Global Constraints palette).
const paletteSize = 10

// colorAssigner hands out palette indices: 0 is reserved for the main
// worktree; others get the lowest unused index 1..9 when they first become
// active and keep it for the session (removal frees nothing). Once 1..9 are
// all taken, indices are reused round-robin.
type colorAssigner struct {
	byID map[WorktreeID]int
	used [paletteSize]bool
	rr   int // round-robin cursor over 1..9 once the palette is exhausted
}

func newColorAssigner() *colorAssigner {
	return &colorAssigner{byID: map[WorktreeID]int{}}
}

// get returns id's colour, or -1 when it has none yet.
func (c *colorAssigner) get(id WorktreeID) int {
	if i, ok := c.byID[id]; ok {
		return i
	}
	return -1
}

func (c *colorAssigner) setMain(id WorktreeID) {
	c.byID[id] = 0
	c.used[0] = true
}

func (c *colorAssigner) assign(id WorktreeID) {
	if _, ok := c.byID[id]; ok {
		return
	}
	for i := 1; i < paletteSize; i++ {
		if !c.used[i] {
			c.used[i] = true
			c.byID[id] = i
			return
		}
	}
	c.byID[id] = 1 + c.rr
	c.rr = (c.rr + 1) % (paletteSize - 1)
}
```

- [ ] **Step 10: Implement the Store**

`internal/model/diff.go`:

```go
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
		if committed > 0 {
			acts = append(acts, Activity{TS: ts, Worktree: wt.ID, Kind: "commit", Sha: wt.Head, Subject: wt.HeadSubject, Files: committed})
		}
		if baseMoved {
			merged := 0
			for path := range before {
				if _, ok := after[path]; !ok {
					merged++
				}
			}
			if merged > 0 {
				acts = append(acts, Activity{TS: ts, Worktree: wt.ID, Kind: "merge", Sha: next.Repo.BaseSha, Files: merged})
			}
		}
	}
	return acts
}

func (s *Store) assignColors(st State, acts []Activity) {
	active := map[WorktreeID]bool{}
	for _, a := range acts {
		active[a.Worktree] = true
	}
	for _, wt := range st.Worktrees {
		switch {
		case wt.IsMain:
			s.colors.setMain(wt.ID)
		case len(st.Overlays[wt.ID]) > 0 || active[wt.ID]:
			s.colors.assign(wt.ID)
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
```

- [ ] **Step 11: Run them to verify they pass**

Run: `go vet ./internal/model && go test -race -count=1 -v ./internal/model/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: `--- PASS` for every test, including all `TestActivity` subtests, `TestModifiedCoalescing`, `TestColoursRoundRobinWhenExhausted`, `TestPatchJSONGolden` and `TestSnapshotJSONGolden`, then `ok  	github.com/olliejudge/orion/internal/model`.

- [ ] **Step 12: Commit**

```bash
git add internal/model
git commit -m "feat(model): diff states into patches with activity and colours" \
  -m "Implements spec §5 activity derivation, 5 s modified coalescing, the 200-item ring and session-stable worktree colours." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 13: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin feat/model
gh pr create --base main --title "feat(model): state store, patch diffing, activity and colours" --body "$(cat <<'EOF'
Adds `internal/model`: the wire types (with JSON golden tests for the TS client), and a concurrency-safe Store that diffs successive States into Patches. It covers the worktree list, the base tree, per-worktree overlays and the activity stream (file, commit and merge rows, 5 s coalescing, 200-item ring), plus session-stable colour assignment.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 5: `watch`: FSEvents (darwin) and recursive inotify (linux)

**Branch:** `feat/watch` · **Depends on:** Task 1

**Files:**
- Create: `internal/watch/watch.go` (the `Event` and `Watcher` types)
- Create: `internal/watch/watch_darwin.go` (FSEvents, cgo)
- Create: `internal/watch/watch_linux.go` (fsnotify with a recursive walk-add)
- Create: `internal/watch/watch_other.go` (`New` returns an "unsupported platform" error on other OSes, so the module still compiles there)
- Test: `internal/watch/watch_test.go` (both platforms), `internal/watch/watch_darwin_test.go`, `internal/watch/watch_linux_test.go`
- Modify: `go.mod`, `go.sum`

**Pinned dependencies** (verified with `go get` and `go doc` on 2026-09-23):
- `github.com/fsnotify/fsevents v0.2.0`. API used: `EventStream{Paths, Latency, Flags, Events chan []Event}`, `Start() error`, `Stop()`; flags `FileEvents`, `NoDefer`, `MustScanSubDirs`, `UserDropped`, `KernelDropped` and `HistoryDone`. With `Device == 0`, event paths are absolute and symlink-resolved. `Stop()` removes the stream from the package registry, so a late callback is dropped rather than blocking.
- `github.com/fsnotify/fsnotify v1.10.1`, which pulls in `golang.org/x/sys v0.13.0`. API used: `NewWatcher()`, `Add`, `Remove`, `WatchList`, `Close`, `Events`, `Errors`, `Event.Has(Create)`, `ErrEventOverflow`, `ErrNonExistentWatch` and `ErrClosed`. `Add` is non-recursive and returns the raw errno (`ENOSPC` when the watch limit is hit).

**Interfaces:**
- Consumes: nothing.
- Produces: exactly the `internal/watch` block in Shared Interfaces. Semantics Task 8 relies on:
  - `Event.Path` is absolute and **symlink-resolved** (for example `/private/var/…` on macOS). `Add` resolves its root, so comparisons must use `filepath.EvalSymlinks` paths. `gitx` and `testrepo` already return those.
  - `Rescan: true` means "recompute everything under `Path`". On darwin, `Path` is the FSEvents path carrying `MustScanSubDirs`, `UserDropped` or `KernelDropped`. On linux, an `IN_Q_OVERFLOW` sends one `Rescan` event per watched root, with `Path` set to that root.
  - Linux `Add` walks the tree and adds every directory. An unreadable subdirectory is sent on `Errors()` and skipped. Hitting the inotify limit (`errors.Is(err, syscall.ENOSPC)`) makes `Add` return the error, and the caller falls back to polling (spec §8). A directory created later is walked and added too, and every entry found inside it is emitted as an event, so files written before its watch existed are not lost. On that later-created directory, the limit error goes to `Errors()`.
  - Nothing is filtered by name: `.git/` and `node_modules/` events are all delivered. Routing and ignoring are Task 6's job.
  - `Close` closes `Events()` and `Errors()`. `Add` after `Close` returns an error.

- [ ] **Step 1: Create the worktree and add the pinned dependencies**

```bash
git worktree add .claude/worktrees/feat-watch -b feat/watch main
cd .claude/worktrees/feat-watch
go get github.com/fsnotify/fsevents@v0.2.0 github.com/fsnotify/fsnotify@v1.10.1
```

- [ ] **Step 2: Write the interface file and the failing cross-platform tests**

`internal/watch/watch.go`:

```go
// Package watch turns the OS file-watching API into a stream of absolute
// paths: FSEvents on darwin, recursive inotify (via fsnotify) on linux. It
// knows nothing about git.
package watch

// Event is one filesystem change. Path is absolute and symlink-resolved.
// Rescan is true when the OS dropped or coalesced events under Path (the
// watched root on linux): the consumer must recompute everything there.
type Event struct {
	Path   string
	Rescan bool
}

// Watcher watches directory trees recursively.
type Watcher interface {
	Events() <-chan Event
	Errors() <-chan error
	Add(root string) error // watch a root recursively (idempotent)
	Remove(root string) error
	Close() error // stops all watches and closes Events and Errors
}
```

`internal/watch/watch_test.go`:

```go
package watch

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const eventTimeout = 2 * time.Second

func tempRoot(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func newWatcher(t *testing.T, roots ...string) Watcher {
	t.Helper()
	w, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = w.Close() })
	for _, r := range roots {
		if err := w.Add(r); err != nil {
			t.Fatalf("Add(%s): %v", r, err)
		}
	}
	settle(w)
	return w
}

// settle drains events for a short quiet period so earlier activity (or
// stream start-up) cannot satisfy the next expectation.
func settle(w Watcher) {
	for {
		select {
		case _, ok := <-w.Events():
			if !ok {
				return
			}
		case <-time.After(200 * time.Millisecond):
			return
		}
	}
}

func expectEvent(t *testing.T, w Watcher, path string) {
	t.Helper()
	deadline := time.After(eventTimeout)
	for {
		select {
		case ev, ok := <-w.Events():
			if !ok {
				t.Fatalf("events closed while waiting for %s", path)
			}
			if ev.Path == path || ev.Rescan {
				return
			}
		case err := <-w.Errors():
			t.Fatalf("watch error while waiting for %s: %v", path, err)
		case <-deadline:
			t.Fatalf("no event for %s within %s", path, eventTimeout)
		}
	}
}

func expectNoEventUnder(t *testing.T, w Watcher, root string, wait time.Duration) {
	t.Helper()
	deadline := time.After(wait)
	for {
		select {
		case ev := <-w.Events():
			if rel, err := filepath.Rel(root, ev.Path); err == nil && filepath.IsLocal(rel) || ev.Path == root {
				t.Fatalf("unexpected event under removed root: %+v", ev)
			}
		case <-deadline:
			return
		}
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCreateModifyRenameDelete(t *testing.T) {
	root := tempRoot(t)
	w := newWatcher(t, root)
	a := filepath.Join(root, "a.txt")
	b := filepath.Join(root, "b.txt")

	write(t, a, "one")
	expectEvent(t, w, a)
	settle(w)

	f, err := os.OpenFile(a, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(" two"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	expectEvent(t, w, a)
	settle(w)

	if err := os.Rename(a, b); err != nil {
		t.Fatal(err)
	}
	expectEvent(t, w, b)
	settle(w)

	if err := os.Remove(b); err != nil {
		t.Fatal(err)
	}
	expectEvent(t, w, b)
}

func TestNestedDirCreatedAfterStartIsWatched(t *testing.T) {
	root := tempRoot(t)
	w := newWatcher(t, root)
	deep := filepath.Join(root, "sub", "deeper", "x.txt")
	write(t, deep, "hi") // MkdirAll + write races the watcher adding sub/ and sub/deeper/
	expectEvent(t, w, deep)
	settle(w)

	write(t, deep, "again")
	expectEvent(t, w, deep)
}

func TestExistingNestedDirIsWatched(t *testing.T) {
	root := tempRoot(t)
	nested := filepath.Join(root, "pre", "existing", "file.txt")
	write(t, nested, "before")
	w := newWatcher(t, root)
	write(t, nested, "after")
	expectEvent(t, w, nested)
}

func TestRemoveStopsEvents(t *testing.T) {
	keep, drop := tempRoot(t), tempRoot(t)
	w := newWatcher(t, keep, drop)
	if err := w.Remove(drop); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	settle(w)

	write(t, filepath.Join(drop, "ignored.txt"), "x")
	expectNoEventUnder(t, w, drop, 500*time.Millisecond)

	kept := filepath.Join(keep, "kept.txt")
	write(t, kept, "y")
	expectEvent(t, w, kept)
}

func TestAddIsIdempotentAndResolvesSymlinks(t *testing.T) {
	root := tempRoot(t)
	link := filepath.Join(tempRoot(t), "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	w := newWatcher(t, root, root, link)
	p := filepath.Join(root, "f.txt")
	write(t, p, "x")
	expectEvent(t, w, p) // reported under the resolved root, not the link
}

func TestCloseClosesChannels(t *testing.T) {
	w, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Add(tempRoot(t)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case _, ok := <-w.Events():
		if ok {
			// A buffered event may still be pending; the channel must close right after.
			for range w.Events() {
			}
		}
	case <-time.After(eventTimeout):
		t.Fatal("Events not closed after Close")
	}
	if err := w.Add(tempRoot(t)); err == nil {
		t.Fatal("Add after Close: want error")
	}
}
```

`internal/watch/watch_darwin_test.go`:

```go
//go:build darwin

package watch

import (
	"testing"

	"github.com/fsnotify/fsevents"
)

func TestConvertDarwin(t *testing.T) {
	tests := []struct {
		in     fsevents.Event
		want   Event
		wantOK bool
	}{
		{fsevents.Event{Path: "/r/a.txt", Flags: fsevents.ItemCreated | fsevents.ItemIsFile}, Event{Path: "/r/a.txt"}, true},
		{fsevents.Event{Path: "r/dir/", Flags: fsevents.ItemModified}, Event{Path: "/r/dir"}, true},
		{fsevents.Event{Path: "/r", Flags: fsevents.MustScanSubDirs}, Event{Path: "/r", Rescan: true}, true},
		{fsevents.Event{Path: "/r", Flags: fsevents.MustScanSubDirs | fsevents.UserDropped}, Event{Path: "/r", Rescan: true}, true},
		{fsevents.Event{Path: "/r", Flags: fsevents.KernelDropped}, Event{Path: "/r", Rescan: true}, true},
		{fsevents.Event{Path: "/r", Flags: fsevents.HistoryDone}, Event{}, false},
	}
	for _, tt := range tests {
		got, ok := convert(tt.in)
		if ok != tt.wantOK || got != tt.want {
			t.Errorf("convert(%+v) = %+v, %v; want %+v, %v", tt.in, got, ok, tt.want, tt.wantOK)
		}
	}
}
```

`internal/watch/watch_linux_test.go`:

```go
//go:build linux

package watch

import (
	"errors"
	"fmt"
	"syscall"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestOverflowBecomesRescanPerRoot(t *testing.T) {
	a, b := tempRoot(t), tempRoot(t)
	w := newWatcher(t, a, b).(*inotifyWatcher)
	w.handleError(fsnotify.ErrEventOverflow)
	got := map[string]bool{}
	for len(got) < 2 {
		select {
		case ev := <-w.Events():
			if !ev.Rescan {
				t.Fatalf("got non-rescan event %+v", ev)
			}
			got[ev.Path] = true
		case <-time.After(eventTimeout):
			t.Fatalf("rescan events = %v, want both roots", got)
		}
	}
	if !got[a] || !got[b] {
		t.Fatalf("rescan events = %v, want %s and %s", got, a, b)
	}
}

func TestLimitErrorIsRecognised(t *testing.T) {
	if !isLimit(fmt.Errorf("watch /x: %w", syscall.ENOSPC)) {
		t.Fatal("wrapped ENOSPC not recognised")
	}
	if isLimit(fmt.Errorf("watch /x: %w", syscall.EACCES)) {
		t.Fatal("EACCES misread as the watch limit")
	}
}

func TestOtherErrorsAreForwarded(t *testing.T) {
	w := newWatcher(t, tempRoot(t)).(*inotifyWatcher)
	w.handleError(syscall.EIO)
	select {
	case err := <-w.Errors():
		if !errors.Is(err, syscall.EIO) {
			t.Fatalf("error = %v, want EIO", err)
		}
	case <-time.After(eventTimeout):
		t.Fatal("error not forwarded")
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/watch/`
Expected: FAIL (build failed) with `undefined: New`, plus `undefined: convert` on macOS or `undefined: inotifyWatcher` on Linux.

- [ ] **Step 4: Implement the darwin watcher**

`internal/watch/watch_darwin.go`:

```go
//go:build darwin

package watch

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsevents"
)

const (
	latency   = 50 * time.Millisecond
	rescanFor = fsevents.MustScanSubDirs | fsevents.UserDropped | fsevents.KernelDropped
)

type stream struct {
	es   *fsevents.EventStream
	quit chan struct{}
	done chan struct{}
}

type fseventsWatcher struct {
	mu      sync.Mutex
	closed  bool
	streams map[string]*stream // resolved root → stream
	events  chan Event
	errors  chan error
}

// New returns an FSEvents-backed Watcher (one stream per root).
func New() (Watcher, error) {
	return &fseventsWatcher{
		streams: map[string]*stream{},
		events:  make(chan Event, 4096),
		errors:  make(chan error, 16),
	}, nil
}

func (w *fseventsWatcher) Events() <-chan Event { return w.events }
func (w *fseventsWatcher) Errors() <-chan error { return w.errors }

func resolve(root string) (string, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

func (w *fseventsWatcher) Add(root string) error {
	real, err := resolve(root)
	if err != nil {
		return fmt.Errorf("watch %s: %w", root, err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return errors.New("watch: watcher is closed")
	}
	if _, ok := w.streams[real]; ok {
		return nil
	}
	s := &stream{
		es: &fsevents.EventStream{
			Paths:   []string{real},
			Latency: latency,
			Flags:   fsevents.FileEvents | fsevents.NoDefer,
			Events:  make(chan []fsevents.Event, 64),
		},
		quit: make(chan struct{}),
		done: make(chan struct{}),
	}
	if err := s.es.Start(); err != nil {
		return fmt.Errorf("watch %s: %w", real, err)
	}
	w.streams[real] = s
	go w.forward(s)
	return nil
}

func (w *fseventsWatcher) forward(s *stream) {
	defer close(s.done)
	for {
		select {
		case <-s.quit:
			return
		case batch := <-s.es.Events:
			for _, e := range batch {
				ev, ok := convert(e)
				if !ok {
					continue
				}
				select {
				case w.events <- ev:
				case <-s.quit:
					return
				}
			}
		}
	}
}

// convert maps an FSEvents event to ours. FSEvents reports absolute,
// symlink-resolved paths when the stream is not device-relative.
func convert(e fsevents.Event) (Event, bool) {
	if e.Flags&fsevents.HistoryDone != 0 || e.Path == "" {
		return Event{}, false
	}
	p := filepath.Clean("/" + e.Path)
	return Event{Path: p, Rescan: e.Flags&rescanFor != 0}, true
}

// stop ends the forwarder, then stops the stream while draining its channel
// so an in-flight FSEvents callback can never block Stop.
func (s *stream) stop() {
	close(s.quit)
	<-s.done
	stopped := make(chan struct{})
	go func() {
		s.es.Stop()
		close(stopped)
	}()
	for {
		select {
		case <-s.es.Events:
		case <-stopped:
			return
		}
	}
}

func (w *fseventsWatcher) Remove(root string) error {
	real, err := resolve(root)
	if err != nil {
		real = filepath.Clean(root) // the root may already be gone
	}
	w.mu.Lock()
	s, ok := w.streams[real]
	delete(w.streams, real)
	w.mu.Unlock()
	if ok {
		s.stop()
	}
	return nil
}

func (w *fseventsWatcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	streams := w.streams
	w.streams = map[string]*stream{}
	w.mu.Unlock()
	for _, s := range streams {
		s.stop()
	}
	close(w.events)
	close(w.errors)
	return nil
}
```

- [ ] **Step 5: Implement the linux watcher and the unsupported-platform stub**

`internal/watch/watch_linux.go`:

```go
//go:build linux

package watch

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/fsnotify/fsnotify"
)

type inotifyWatcher struct {
	mu     sync.Mutex
	roots  map[string]bool // resolved roots
	fw     *fsnotify.Watcher
	events chan Event
	errors chan error
	done   chan struct{} // closed when loop exits

	// sendMu guards closed: senders hold it for reading while sending, so
	// Close (which takes it for writing after closing quit) never closes a
	// channel mid-send; quit unblocks senders whose consumer has gone.
	sendMu    sync.RWMutex
	closed    bool
	quit      chan struct{}
	closeOnce sync.Once
}

// New returns an inotify-backed Watcher that adds every directory under each
// root, and new directories as they appear.
func New() (Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &inotifyWatcher{
		fw:     fw,
		roots:  map[string]bool{},
		events: make(chan Event, 4096),
		errors: make(chan error, 16),
		done:   make(chan struct{}),
		quit:   make(chan struct{}),
	}
	go w.loop()
	return w, nil
}

func (w *inotifyWatcher) Events() <-chan Event { return w.events }
func (w *inotifyWatcher) Errors() <-chan error { return w.errors }

func resolve(root string) (string, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

// Add watches every directory under root. Unreadable subdirectories are
// reported on Errors and skipped; hitting the inotify watch limit (ENOSPC)
// aborts and returns the error so the caller can fall back to polling.
func (w *inotifyWatcher) Add(root string) error {
	real, err := resolve(root)
	if err != nil {
		return fmt.Errorf("watch %s: %w", root, err)
	}
	w.sendMu.RLock()
	closed := w.closed
	w.sendMu.RUnlock()
	if closed {
		return errors.New("watch: watcher is closed")
	}
	w.mu.Lock()
	w.roots[real] = true
	w.mu.Unlock()
	return w.addTree(real, false)
}

// addTree adds dir and its subdirectories. When announce is true (a directory
// created after start), every entry found is also emitted as an event,
// because files may have been written before the watch existed.
func (w *inotifyWatcher) addTree(dir string, announce bool) error {
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == dir {
				return err
			}
			w.sendError(fmt.Errorf("watch %s: %w", p, err))
			return fs.SkipDir
		}
		if announce && p != dir {
			w.send(Event{Path: p})
		}
		if !d.IsDir() {
			return nil
		}
		if err := w.fw.Add(p); err != nil {
			werr := fmt.Errorf("watch %s: %w", p, err)
			if errors.Is(err, fsnotify.ErrClosed) || isLimit(err) {
				return werr
			}
			w.sendError(werr)
			return fs.SkipDir
		}
		return nil
	})
}

// isLimit reports whether err means the inotify watch limit was reached
// (fs.inotify.max_user_watches), which inotify signals as ENOSPC.
func isLimit(err error) bool { return errors.Is(err, syscall.ENOSPC) }

func (w *inotifyWatcher) loop() {
	defer close(w.done)
	for {
		select {
		case e, ok := <-w.fw.Events:
			if !ok {
				return
			}
			w.handle(e)
		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			w.handleError(err)
		}
	}
}

func (w *inotifyWatcher) handle(e fsnotify.Event) {
	p := filepath.Clean(e.Name)
	if !w.underRoot(p) {
		return
	}
	w.send(Event{Path: p})
	if e.Has(fsnotify.Create) {
		if err := w.addTree(p, true); err != nil && isLimit(err) {
			w.sendError(err)
		}
	}
}

func (w *inotifyWatcher) handleError(err error) {
	if errors.Is(err, fsnotify.ErrEventOverflow) {
		w.mu.Lock()
		roots := make([]string, 0, len(w.roots))
		for r := range w.roots {
			roots = append(roots, r)
		}
		w.mu.Unlock()
		for _, r := range roots {
			w.send(Event{Path: r, Rescan: true})
		}
		return
	}
	w.sendError(err)
}

func (w *inotifyWatcher) underRoot(p string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return rootOf(w.roots, p) != ""
}

// within reports whether p is root or inside it.
func within(root, p string) bool {
	if p == root {
		return true
	}
	rel, err := filepath.Rel(root, p)
	return err == nil && filepath.IsLocal(rel)
}

// rootOf returns the registered root containing p, or "".
func rootOf(roots map[string]bool, p string) string {
	for r := range roots {
		if within(r, p) {
			return r
		}
	}
	return ""
}

func (w *inotifyWatcher) send(ev Event) {
	w.sendMu.RLock()
	defer w.sendMu.RUnlock()
	if w.closed {
		return
	}
	select {
	case w.events <- ev:
	case <-w.quit:
	}
}

func (w *inotifyWatcher) sendError(err error) {
	w.sendMu.RLock()
	defer w.sendMu.RUnlock()
	if w.closed {
		return
	}
	select {
	case w.errors <- err:
	default: // never block the event loop on an unread error
	}
}

func (w *inotifyWatcher) Remove(root string) error {
	real, err := resolve(root)
	if err != nil {
		real = filepath.Clean(root)
	}
	w.mu.Lock()
	delete(w.roots, real)
	remaining := make(map[string]bool, len(w.roots))
	for r := range w.roots {
		remaining[r] = true
	}
	w.mu.Unlock()
	for _, p := range w.fw.WatchList() {
		if !within(real, p) || rootOf(remaining, p) != "" {
			continue // not ours, or also inside another root
		}
		if err := w.fw.Remove(p); err != nil && !errors.Is(err, fsnotify.ErrNonExistentWatch) {
			return fmt.Errorf("unwatch %s: %w", p, err)
		}
	}
	return nil
}

func (w *inotifyWatcher) Close() error {
	var err error
	w.closeOnce.Do(func() {
		close(w.quit) // unblock any sender stuck on a full channel
		w.sendMu.Lock()
		w.closed = true
		w.sendMu.Unlock()
		err = w.fw.Close()
		<-w.done
		close(w.events)
		close(w.errors)
	})
	return err
}
```

`internal/watch/watch_other.go`:

```go
//go:build !darwin && !linux

package watch

import (
	"fmt"
	"runtime"
)

// New reports that file watching is unsupported on this platform.
func New() (Watcher, error) {
	return nil, fmt.Errorf("watch: %s is not supported (orion runs on macOS and Linux)", runtime.GOOS)
}
```

- [ ] **Step 6: Tidy the module**

Run: `go mod tidy && cat go.mod`
Expected:

```
module github.com/olliejudge/orion

go 1.27

require (
	github.com/fsnotify/fsevents v0.2.0
	github.com/fsnotify/fsnotify v1.10.1
)

require golang.org/x/sys v0.13.0 // indirect
```

- [ ] **Step 7: Run the tests on this machine and vet the other platforms**

Run: `go vet ./... && GOOS=linux go vet ./internal/watch && GOOS=windows go vet ./internal/watch && go test -race -count=3 -v ./internal/watch/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: every test `--- PASS` (three runs each), then `ok  	github.com/olliejudge/orion/internal/watch`. On macOS the list includes `TestConvertDarwin`; on Linux it includes `TestOverflowBecomesRescanPerRoot`, `TestLimitErrorIsRecognised` and `TestOtherErrorsAreForwarded`.

- [ ] **Step 8: Run the other platform's tests**

On macOS with Docker available, run the Linux tests in a container. Otherwise the CI `go` matrix covers the other OS.

Run: `docker run --rm -v "$PWD":/src -w /src golang:1.27 go test -race -count=1 ./internal/watch/`
Expected: `ok  	github.com/olliejudge/orion/internal/watch`.

- [ ] **Step 9: Lint**

Run: `golangci-lint run ./... && GOOS=linux CGO_ENABLED=0 golangci-lint run ./...`
Expected: `0 issues.` twice.

- [ ] **Step 10: Commit**

```bash
git add go.mod go.sum internal/watch
git commit -m "feat(watch): add recursive watcher on FSEvents and inotify" \
  -m "Reports absolute, symlink-resolved paths; overflow and must-scan become Rescan events; hitting the inotify watch limit returns ENOSPC so callers can poll." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 11: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin feat/watch
gh pr create --base main --title "feat(watch): FSEvents and recursive inotify watcher" --body "$(cat <<'EOF'
Adds `internal/watch`: a recursive file watcher that uses FSEvents on macOS (fsnotify/fsevents v0.2.0, FileEvents|NoDefer, 50 ms latency) and inotify on Linux (fsnotify v1.10.1, adding new directories as they appear). Overflow and must-scan conditions become `Rescan` events, and hitting the inotify watch limit is reported as ENOSPC. Tests cover create, modify, rename and delete, directories created after start, Remove and Close on both platforms.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```


---

### Task 6: `repo` Router + Scheduler

**Branch:** `feat/repo-router-scheduler` · **Depends on:** Task 4

The Router says what a filesystem event means (spec §4 step 3). The Scheduler turns event storms into a bounded number of recomputes (spec §4 step 4). Both are pure. They don't touch the filesystem or git, so the tests use synthetic paths and short durations.

**Files:**
- Create: `internal/repo/router.go`, `internal/repo/scheduler.go`
- Test: `internal/repo/router_test.go`, `internal/repo/scheduler_test.go`

**Interfaces:**
- Consumes: `model.WorktreeID` (Task 4).
- Produces: exactly the Router and Scheduler parts of the `internal/repo` block in Shared Interfaces (`Class`, `Ignore`, `FileEvent`, `WorktreeRefEvent`, `RefsEvent`, `WorktreesChanged`, `Route`, `RouteTarget`, `Router`, `NewRouter`, `(*Router).Route`, `Reason`, `ReasonFiles`, `ReasonRef`, `ReasonRefs`, `ReasonWorktrees`, `ReasonRescan`, `Scheduler`, `NewScheduler`, `(*Scheduler).Trigger`, `(*Scheduler).Close`). Task 8 also uses these package-internal pieces:
  - `func (r *Router) ids() []model.WorktreeID` returns every target's ID, in the order given to `NewRouter`.
  - `func under(p, root string) (rel string, ok bool)` reports whether `p` is `root` or inside it, splitting only at a path-separator boundary. `rel` is slash-separated, and `""` when `p == root`.
  - The test helper `waitFor(t *testing.T, timeout time.Duration, cond func() bool)` in `scheduler_test.go`, which polls every 5 ms.
- Routing rules. Every path is absolute and symlink-resolved; Task 8 resolves `RouteTarget` paths the same way Task 5 resolves event paths. The first matching rule wins:
  1. A path under `<commonDir>` is classified relative to the common dir:
     - `worktrees` itself, or `worktrees/<name>` (an admin dir created or removed) → `WorktreesChanged`.
     - `worktrees/<name>/…` for a **known** linked worktree (its `AdminDir` is exactly `<commonDir>/worktrees/<name>`):
       - `HEAD`, `index`, `ORIG_HEAD`, `MERGE_HEAD`, `REBASE_HEAD`, `rebase-merge[/…]` or `rebase-apply[/…]` → `WorktreeRefEvent` for that worktree.
       - `locked` → `WorktreesChanged`, because `git worktree lock` and `unlock` change the legend.
       - Anything else (`logs/HEAD`, `index.lock`, …) → `Ignore`.
     - `worktrees/<name>/…` for an **unknown** `<name>` → `WorktreesChanged`. A worktree is being added, and this is robust even if its directory-creation event was coalesced away.
     - `refs`, `refs/**` or `packed-refs` → `RefsEvent`.
     - The same state-file set directly in `<commonDir>` (`HEAD`, `index`, `ORIG_HEAD`, `MERGE_HEAD`, `REBASE_HEAD`, `rebase-merge/…`, `rebase-apply/…`) → `WorktreeRefEvent` for the main worktree. The main worktree is the target whose `AdminDir == commonDir`.
     - Anything else under `<commonDir>` (`objects/`, `logs/`, `config`, the dir itself) → `Ignore`.
  2. Otherwise the path goes to the target with the **longest** `Root` that is the path itself or a prefix ending at a separator: `/r2/x` never matches root `/r`. The result is `FileEvent`, except that any path component equal to `.git` below that root gives `Ignore` (a linked worktree's `.git` gitfile, or a nested plain repo's git dir).
  3. No match → `Ignore`.
  - A target with `AdminDir == ""` gets file events only.
- Scheduler semantics:
  - Each key fires `debounce` after its last trigger. Under sustained churn it fires no later than `maxWait = max(2×debounce, minInterval)` after the first pending trigger, and never sooner than `minInterval` after its previous fire *started*.
  - Reasons are OR-ed while a key is pending.
  - `fire` runs on its own goroutine. It never overlaps for one key; triggers that arrive during a fire are queued and fire afterwards. Different keys may fire concurrently.
  - `Close` stops pending timers and waits for in-flight fires. `Trigger` after `Close` is a no-op.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-repo-router-scheduler -b feat/repo-router-scheduler main
cd .claude/worktrees/feat-repo-router-scheduler
```

- [ ] **Step 2: Write the failing router tests**

`TestRouterNestedWorktree` is pinned by Review Focus item 1.

`internal/repo/router_test.go`:

```go
package repo

import (
	"path/filepath"
	"testing"

	"github.com/olliejudge/orion/internal/model"
)

// Synthetic layout used by every router test:
//
//	/r                          main worktree root (ID "main")
//	/r/.git                     common dir (and main's admin dir)
//	/r/.claude/worktrees/agent  nested linked worktree (ID "nested"), admin /r/.git/worktrees/agent
//	/r2                         sibling linked worktree (ID "sib"), admin /r/.git/worktrees/r2
func testRouter() *Router {
	return NewRouter("/r/.git", []RouteTarget{
		{ID: "main", Root: "/r", AdminDir: "/r/.git"},
		{ID: "nested", Root: "/r/.claude/worktrees/agent", AdminDir: "/r/.git/worktrees/agent"},
		{ID: "sib", Root: "/r2", AdminDir: "/r/.git/worktrees/r2"},
	})
}

func TestRouterNestedWorktree(t *testing.T) {
	r := testRouter()
	cases := []struct {
		path string
		want Route
	}{
		{"/r/.claude/worktrees/agent/src/x.go", Route{FileEvent, "nested"}},
		{"/r/.claude/worktrees/agent", Route{FileEvent, "nested"}},
		{"/r/.claude/worktrees/agent/.git", Route{Ignore, ""}},
		{"/r/.claude/worktrees/agentx/y.go", Route{FileEvent, "main"}}, // not a separator boundary
		{"/r/.claude/worktrees/other.txt", Route{FileEvent, "main"}},
		{"/r/.claude/notes.md", Route{FileEvent, "main"}},
	}
	for _, c := range cases {
		if got := r.Route(filepath.FromSlash(c.path)); got != c.want {
			t.Errorf("Route(%q) = %+v, want %+v", c.path, got, c.want)
		}
	}
}

func TestRouterGitDir(t *testing.T) {
	r := testRouter()
	cases := []struct {
		path string
		want Route
	}{
		// main worktree's own state files
		{"/r/.git/HEAD", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/index", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/ORIG_HEAD", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/MERGE_HEAD", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/rebase-merge/done", Route{WorktreeRefEvent, "main"}},
		{"/r/.git/index.lock", Route{Ignore, ""}},
		// refs
		{"/r/.git/refs/heads/feature", Route{RefsEvent, ""}},
		{"/r/.git/refs/remotes/origin/main", Route{RefsEvent, ""}},
		{"/r/.git/refs", Route{RefsEvent, ""}},
		{"/r/.git/packed-refs", Route{RefsEvent, ""}},
		// linked worktree admin dirs
		{"/r/.git/worktrees/agent/HEAD", Route{WorktreeRefEvent, "nested"}},
		{"/r/.git/worktrees/agent/index", Route{WorktreeRefEvent, "nested"}},
		{"/r/.git/worktrees/agent/REBASE_HEAD", Route{WorktreeRefEvent, "nested"}},
		{"/r/.git/worktrees/agent/rebase-apply/0001", Route{WorktreeRefEvent, "nested"}},
		{"/r/.git/worktrees/r2/HEAD", Route{WorktreeRefEvent, "sib"}},
		{"/r/.git/worktrees/r2/logs/HEAD", Route{Ignore, ""}},
		{"/r/.git/worktrees/r2/index.lock", Route{Ignore, ""}},
		{"/r/.git/worktrees/r2/locked", Route{WorktreesChanged, ""}},
		// worktree set changes
		{"/r/.git/worktrees", Route{WorktreesChanged, ""}},
		{"/r/.git/worktrees/agent", Route{WorktreesChanged, ""}},
		{"/r/.git/worktrees/new-one", Route{WorktreesChanged, ""}},
		{"/r/.git/worktrees/new-one/HEAD", Route{WorktreesChanged, ""}},
		// everything else in the common dir
		{"/r/.git/objects/ab/cdef", Route{Ignore, ""}},
		{"/r/.git/logs/HEAD", Route{Ignore, ""}},
		{"/r/.git/config", Route{Ignore, ""}},
		{"/r/.git", Route{Ignore, ""}},
	}
	for _, c := range cases {
		if got := r.Route(filepath.FromSlash(c.path)); got != c.want {
			t.Errorf("Route(%q) = %+v, want %+v", c.path, got, c.want)
		}
	}
}

func TestRouterFiles(t *testing.T) {
	r := testRouter()
	cases := []struct {
		path string
		want Route
	}{
		{"/r/README.md", Route{FileEvent, "main"}},
		{"/r", Route{FileEvent, "main"}},
		{"/r2/a/b.txt", Route{FileEvent, "sib"}},
		{"/r2/.git", Route{Ignore, ""}},
		{"/r/sub/.git/HEAD", Route{Ignore, ""}}, // a nested plain repo's git dir
		{"/r/sub/.gitignore", Route{FileEvent, "main"}},
		{"/r20/x", Route{Ignore, ""}},
		{"/elsewhere/x", Route{Ignore, ""}},
		{"/", Route{Ignore, ""}},
	}
	for _, c := range cases {
		if got := r.Route(filepath.FromSlash(c.path)); got != c.want {
			t.Errorf("Route(%q) = %+v, want %+v", c.path, got, c.want)
		}
	}
}

func TestRouterSeparateGitDir(t *testing.T) {
	// Main worktree created with --separate-git-dir: common dir outside the root,
	// and <root>/.git is a gitfile.
	r := NewRouter("/store/r.git", []RouteTarget{
		{ID: "main", Root: "/r", AdminDir: "/store/r.git"},
	})
	if got := r.Route("/store/r.git/HEAD"); got != (Route{WorktreeRefEvent, "main"}) {
		t.Errorf("HEAD: %+v", got)
	}
	if got := r.Route("/r/.git"); got != (Route{Ignore, ""}) {
		t.Errorf("gitfile: %+v", got)
	}
	if got := r.Route("/r/a.txt"); got != (Route{FileEvent, "main"}) {
		t.Errorf("file: %+v", got)
	}
}

func TestRouterIDs(t *testing.T) {
	got := testRouter().ids()
	want := []model.WorktreeID{"main", "nested", "sib"}
	if len(got) != len(want) {
		t.Fatalf("ids() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ids() = %v, want %v", got, want)
		}
	}
}

func TestRouterTargetWithoutAdminDir(t *testing.T) {
	r := NewRouter("/r/.git", []RouteTarget{
		{ID: "main", Root: "/r", AdminDir: "/r/.git"},
		{ID: "odd", Root: "/o"}, // admin dir could not be read
	})
	if got := r.Route("/o/a.txt"); got != (Route{FileEvent, "odd"}) {
		t.Errorf("file: %+v", got)
	}
	if got := r.Route("/r/.git/HEAD"); got != (Route{WorktreeRefEvent, "main"}) {
		t.Errorf("main HEAD: %+v", got)
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/repo/ 2>&1 | head -5`
Expected: build failure, `undefined: NewRouter` (and `RouteTarget`, `FileEvent`, …).

- [ ] **Step 4: Implement the router**

`internal/repo/router.go`:

```go
// Package repo connects watch → gitx → model: it routes filesystem events,
// schedules recomputes and owns the live model.Store.
package repo

import (
	"path/filepath"
	"sort"
	"strings"

	"github.com/olliejudge/orion/internal/model"
)

// Class says what a filesystem event means for the repo.
type Class int

const (
	Ignore           Class = iota // nothing to do
	FileEvent                     // a working-tree file of Route.Worktree changed
	WorktreeRefEvent              // HEAD/index/merge/rebase state of Route.Worktree changed
	RefsEvent                     // refs/** or packed-refs changed (base or any branch may have moved)
	WorktreesChanged              // the set of linked worktrees (or their lock state) changed
)

// Route is the classification of one event path.
type Route struct {
	Class    Class
	Worktree model.WorktreeID
}

// RouteTarget describes one worktree. Root and AdminDir are absolute, clean,
// symlink-resolved paths. For the main worktree AdminDir equals the common dir.
type RouteTarget struct {
	ID       model.WorktreeID
	Root     string
	AdminDir string
}

// Router classifies absolute event paths. It is immutable; build a new one
// when the set of worktrees changes.
type Router struct {
	commonDir string
	main      model.WorktreeID
	hasMain   bool
	linked    map[string]model.WorktreeID // admin dir → ID, for linked worktrees only
	byRoot    []RouteTarget               // sorted by len(Root) descending → first match is the longest prefix
	order     []model.WorktreeID
}

// stateFiles are the per-worktree git files whose change means HEAD, the index
// or an in-progress merge/rebase changed.
var stateFiles = map[string]bool{
	"HEAD": true, "index": true, "ORIG_HEAD": true, "MERGE_HEAD": true, "REBASE_HEAD": true,
}

// NewRouter builds a Router for the given common dir and worktrees.
func NewRouter(commonDir string, targets []RouteTarget) *Router {
	r := &Router{commonDir: filepath.Clean(commonDir), linked: map[string]model.WorktreeID{}}
	for _, t := range targets {
		t.Root = filepath.Clean(t.Root)
		r.order = append(r.order, t.ID)
		r.byRoot = append(r.byRoot, t)
		switch admin := filepath.Clean(t.AdminDir); {
		case t.AdminDir == "":
			// admin dir unknown: file events only
		case admin == r.commonDir:
			r.main, r.hasMain = t.ID, true
		default:
			r.linked[admin] = t.ID
		}
	}
	sort.SliceStable(r.byRoot, func(i, j int) bool { return len(r.byRoot[i].Root) > len(r.byRoot[j].Root) })
	return r
}

// ids returns the IDs of every target, in the order given to NewRouter.
func (r *Router) ids() []model.WorktreeID {
	return append([]model.WorktreeID(nil), r.order...)
}

// Route classifies one absolute path.
func (r *Router) Route(absPath string) Route {
	p := filepath.Clean(absPath)
	if rel, ok := under(p, r.commonDir); ok {
		return r.routeGit(rel)
	}
	for _, t := range r.byRoot {
		rel, ok := under(p, t.Root)
		if !ok {
			continue
		}
		for _, part := range strings.Split(rel, "/") {
			if part == ".git" {
				return Route{Class: Ignore}
			}
		}
		return Route{Class: FileEvent, Worktree: t.ID}
	}
	return Route{Class: Ignore}
}

// routeGit classifies rel, a slash-separated path relative to the common dir
// ("" for the common dir itself).
func (r *Router) routeGit(rel string) Route {
	switch {
	case rel == "worktrees":
		return Route{Class: WorktreesChanged}
	case strings.HasPrefix(rel, "worktrees/"):
		rest := strings.TrimPrefix(rel, "worktrees/")
		name, inner, _ := strings.Cut(rest, "/")
		if inner == "" {
			return Route{Class: WorktreesChanged} // <name> dir created or removed
		}
		id, known := r.linked[filepath.Join(r.commonDir, "worktrees", name)]
		switch {
		case !known:
			return Route{Class: WorktreesChanged} // an admin dir we do not know yet: a worktree is being added
		case inner == "locked":
			return Route{Class: WorktreesChanged} // `git worktree lock/unlock`
		case isStateFile(inner):
			return Route{Class: WorktreeRefEvent, Worktree: id}
		}
		return Route{Class: Ignore}
	case rel == "refs" || strings.HasPrefix(rel, "refs/") || rel == "packed-refs":
		return Route{Class: RefsEvent}
	case isStateFile(rel):
		if r.hasMain {
			return Route{Class: WorktreeRefEvent, Worktree: r.main}
		}
	}
	return Route{Class: Ignore}
}

func isStateFile(rel string) bool {
	if stateFiles[rel] {
		return true
	}
	for _, d := range []string{"rebase-merge", "rebase-apply"} {
		if rel == d || strings.HasPrefix(rel, d+"/") {
			return true
		}
	}
	return false
}

// under reports whether p is root or inside it, and returns the slash-separated
// remainder ("" when p == root). The match must end at a separator boundary.
func under(p, root string) (string, bool) {
	if p == root {
		return "", true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	if !strings.HasPrefix(p, prefix) {
		return "", false
	}
	return filepath.ToSlash(p[len(prefix):]), true
}
```

- [ ] **Step 5: Run the router tests to verify they pass**

Run: `go test -count=1 -v -run TestRouter ./internal/repo/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: `--- PASS` for `TestRouterNestedWorktree`, `TestRouterGitDir`, `TestRouterFiles`, `TestRouterSeparateGitDir`, `TestRouterIDs` and `TestRouterTargetWithoutAdminDir`, then `ok  	github.com/olliejudge/orion/internal/repo`.

- [ ] **Step 6: Commit**

```bash
git add internal/repo/router.go internal/repo/router_test.go
git commit -m "feat(repo): route watcher events to worktrees, refs and worktree set" \
  -m "Longest-prefix routing keeps events inside nested linked worktrees (e.g. .claude/worktrees/*) out of the main worktree; .git internals are split into per-worktree ref events, refs events and worktree-set changes." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing scheduler tests**

`TestSchedulerBurst` is pinned by Review Focus item 4. The bound is `ceil(burst duration / minInterval) + 2` fires, and the last fire must start after the last trigger. Every test uses 20 ms debounce and a 50 ms min interval, so the file runs in about 2 s.

`internal/repo/scheduler_test.go`:

```go
package repo

import (
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testDebounce    = 20 * time.Millisecond
	testMinInterval = 50 * time.Millisecond
)

type fireRec struct {
	key string
	r   Reason
	at  time.Time
}

type recorder struct {
	mu    sync.Mutex
	fires []fireRec
}

func (rc *recorder) fire(key string, r Reason) {
	rc.mu.Lock()
	rc.fires = append(rc.fires, fireRec{key, r, time.Now()})
	rc.mu.Unlock()
}

func (rc *recorder) snapshot() []fireRec {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return append([]fireRec(nil), rc.fires...)
}

// waitFor polls cond every 5ms until it is true or timeout passes.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("condition not met within %v", timeout)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// quiet waits until no new fire has been recorded for d.
func (rc *recorder) quiet(t *testing.T, d time.Duration) []fireRec {
	t.Helper()
	n, since := -1, time.Now()
	waitFor(t, 5*time.Second, func() bool {
		cur := len(rc.snapshot())
		if cur != n {
			n, since = cur, time.Now()
		}
		return time.Since(since) >= d
	})
	return rc.snapshot()
}

func TestSchedulerDebounceMergesReasons(t *testing.T) {
	rc := &recorder{}
	s := NewScheduler(testDebounce, testMinInterval, rc.fire)
	defer s.Close()
	s.Trigger("a", ReasonFiles)
	time.Sleep(5 * time.Millisecond)
	s.Trigger("a", ReasonRef)
	last := time.Now()
	s.Trigger("a", ReasonFiles)
	fires := rc.quiet(t, 150*time.Millisecond)
	if len(fires) != 1 {
		t.Fatalf("fires = %d, want 1: %+v", len(fires), fires)
	}
	if fires[0].r != ReasonFiles|ReasonRef {
		t.Errorf("reason = %b, want %b", fires[0].r, ReasonFiles|ReasonRef)
	}
	if fires[0].at.Sub(last) < testDebounce {
		t.Errorf("fired %v after last trigger, want ≥ %v", fires[0].at.Sub(last), testDebounce)
	}
}

func TestSchedulerMinInterval(t *testing.T) {
	rc := &recorder{}
	s := NewScheduler(testDebounce, testMinInterval, rc.fire)
	defer s.Close()
	s.Trigger("a", ReasonFiles)
	waitFor(t, time.Second, func() bool { return len(rc.snapshot()) == 1 })
	s.Trigger("a", ReasonRefs)
	fires := rc.quiet(t, 150*time.Millisecond)
	if len(fires) != 2 {
		t.Fatalf("fires = %d, want 2", len(fires))
	}
	if gap := fires[1].at.Sub(fires[0].at); gap < testMinInterval {
		t.Errorf("gap between fires = %v, want ≥ %v", gap, testMinInterval)
	}
	if fires[1].r != ReasonRefs {
		t.Errorf("second reason = %b, want %b", fires[1].r, ReasonRefs)
	}
}

func TestSchedulerBurst(t *testing.T) {
	rc := &recorder{}
	s := NewScheduler(testDebounce, testMinInterval, rc.fire)
	defer s.Close()
	all := ReasonFiles | ReasonRef | ReasonRefs | ReasonWorktrees | ReasonRescan
	start := time.Now()
	for i := 0; i < 1000; i++ {
		s.Trigger("wt", Reason(1)<<(i%5))
	}
	last := time.Now()
	dur := last.Sub(start)
	fires := rc.quiet(t, 200*time.Millisecond)

	limit := int(math.Ceil(float64(dur)/float64(testMinInterval))) + 2
	if len(fires) == 0 || len(fires) > limit {
		t.Fatalf("fires = %d for a %v burst, want 1..%d", len(fires), dur, limit)
	}
	final := fires[len(fires)-1]
	if !final.at.After(last) {
		t.Errorf("final fire at %v is not after the last trigger at %v", final.at, last)
	}
	var union Reason
	for _, f := range fires {
		union |= f.r
	}
	if union != all {
		t.Errorf("union of fired reasons = %b, want %b", union, all)
	}
	if len(fires) == 1 && final.r != all {
		t.Errorf("single fire reason = %b, want %b", final.r, all)
	}
}

func TestSchedulerSustainedChurn(t *testing.T) {
	rc := &recorder{}
	s := NewScheduler(testDebounce, testMinInterval, rc.fire)
	defer s.Close()
	churn := 300 * time.Millisecond
	start := time.Now()
	for time.Since(start) < churn {
		s.Trigger("wt", ReasonFiles)
		time.Sleep(2 * time.Millisecond)
	}
	last := time.Now()
	fires := rc.quiet(t, 200*time.Millisecond)
	limit := int(math.Ceil(float64(last.Sub(start))/float64(testMinInterval))) + 2
	if len(fires) < 2 || len(fires) > limit {
		t.Fatalf("fires = %d during %v of churn, want 2..%d (progress during churn, but rate-limited)", len(fires), last.Sub(start), limit)
	}
	if !fires[0].at.Before(last) {
		t.Errorf("no fire during sustained churn; first fire at +%v", fires[0].at.Sub(start))
	}
	if !fires[len(fires)-1].at.After(last) {
		t.Errorf("no trailing fire after churn ended")
	}
	for i := 1; i < len(fires); i++ {
		if gap := fires[i].at.Sub(fires[i-1].at); gap < testMinInterval-2*time.Millisecond {
			t.Errorf("fires %d and %d only %v apart, want ≥ %v", i-1, i, gap, testMinInterval)
		}
	}
}

func TestSchedulerNeverConcurrentPerKey(t *testing.T) {
	var running, maxRunning, calls atomic.Int32
	var mu sync.Mutex
	var reasons []Reason
	s := NewScheduler(testDebounce, testMinInterval, func(key string, r Reason) {
		n := running.Add(1)
		for {
			m := maxRunning.Load()
			if n <= m || maxRunning.CompareAndSwap(m, n) {
				break
			}
		}
		mu.Lock()
		reasons = append(reasons, r)
		mu.Unlock()
		calls.Add(1)
		time.Sleep(100 * time.Millisecond)
		running.Add(-1)
	})
	defer s.Close()
	s.Trigger("a", ReasonFiles)
	waitFor(t, time.Second, func() bool { return calls.Load() == 1 })
	s.Trigger("a", ReasonRef) // arrives while the first fire is still running
	waitFor(t, 2*time.Second, func() bool { return calls.Load() == 2 && running.Load() == 0 })
	if maxRunning.Load() != 1 {
		t.Fatalf("max concurrent fires for one key = %d, want 1", maxRunning.Load())
	}
	mu.Lock()
	defer mu.Unlock()
	if reasons[1] != ReasonRef {
		t.Errorf("second fire reason = %b, want %b", reasons[1], ReasonRef)
	}
}

func TestSchedulerKeysIndependent(t *testing.T) {
	release := make(chan struct{})
	bFired := make(chan struct{})
	s := NewScheduler(testDebounce, testMinInterval, func(key string, r Reason) {
		switch key {
		case "a":
			<-release
		case "b":
			close(bFired)
		}
	})
	defer s.Close()
	defer close(release)
	s.Trigger("a", ReasonFiles)
	time.Sleep(2 * testDebounce) // let "a" start and block
	s.Trigger("b", ReasonFiles)
	select {
	case <-bFired:
	case <-time.After(time.Second):
		t.Fatal(`key "b" did not fire while key "a" was busy`)
	}
}

func TestSchedulerClose(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{})
	s := NewScheduler(testDebounce, testMinInterval, func(key string, r Reason) {
		if calls.Add(1) == 1 {
			close(started)
			time.Sleep(80 * time.Millisecond)
		}
	})
	s.Trigger("a", ReasonFiles)
	<-started
	s.Trigger("a", ReasonFiles) // pending when Close is called: must never fire
	begin := time.Now()
	s.Close()
	if time.Since(begin) < 40*time.Millisecond {
		t.Errorf("Close returned before the in-flight fire finished")
	}
	s.Trigger("b", ReasonFiles)
	time.Sleep(150 * time.Millisecond) // give any (incorrect) timer time to fire
	if n := calls.Load(); n != 1 {
		t.Fatalf("calls = %d after Close, want 1", n)
	}
}
```

- [ ] **Step 8: Run them to verify they fail**

Run: `go test ./internal/repo/ 2>&1 | head -5`
Expected: build failure, `undefined: NewScheduler` (and `ReasonFiles`, …).

- [ ] **Step 9: Implement the scheduler**

`internal/repo/scheduler.go`:

```go
package repo

import (
	"sync"
	"time"
)

// Reason is a bit set describing why a key needs recomputing.
type Reason uint8

const (
	ReasonFiles     Reason = 1 << iota // working-tree files changed
	ReasonRef                          // this worktree's HEAD/index changed
	ReasonRefs                         // refs/** or packed-refs changed
	ReasonWorktrees                    // the worktree set changed
	ReasonRescan                       // watcher overflow: recompute everything
)

// Scheduler coalesces triggers per key. A key fires `debounce` after its last
// trigger, but no later than maxWait after its first pending trigger (so
// sustained churn still produces progress), and never sooner than
// `minInterval` after its previous fire started. Fires for one key never
// overlap; triggers that arrive during a fire are OR-ed and fire afterwards.
type Scheduler struct {
	debounce, minInterval, maxWait time.Duration
	fire                           func(key string, r Reason)

	mu     sync.Mutex
	keys   map[string]*keyState
	closed bool
	wg     sync.WaitGroup
}

type keyState struct {
	pending     Reason
	first, last time.Time // first and latest trigger since pending became non-zero
	lastFire    time.Time
	running     bool
	gen         uint64 // bumps on every arm; stale timer callbacks compare and bail
	timer       *time.Timer
}

// NewScheduler returns a Scheduler that calls fire on its own goroutine.
func NewScheduler(debounce, minInterval time.Duration, fire func(key string, r Reason)) *Scheduler {
	maxWait := 2 * debounce
	if maxWait < minInterval {
		maxWait = minInterval
	}
	return &Scheduler{
		debounce: debounce, minInterval: minInterval, maxWait: maxWait,
		fire: fire, keys: map[string]*keyState{},
	}
}

// Trigger records reason r for key. It never blocks on a running fire.
func (s *Scheduler) Trigger(key string, r Reason) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	k := s.keys[key]
	if k == nil {
		k = &keyState{}
		s.keys[key] = k
	}
	now := time.Now()
	if k.pending == 0 {
		k.first = now
	}
	k.pending |= r
	k.last = now
	if !k.running {
		s.arm(key, k, now)
	}
}

// arm (re)starts k's timer. s.mu must be held.
func (s *Scheduler) arm(key string, k *keyState, now time.Time) {
	due := k.last.Add(s.debounce)
	if limit := k.first.Add(s.maxWait); limit.Before(due) {
		due = limit
	}
	if earliest := k.lastFire.Add(s.minInterval); earliest.After(due) {
		due = earliest
	}
	if k.timer != nil {
		k.timer.Stop()
	}
	k.gen++
	gen := k.gen
	k.timer = time.AfterFunc(max(due.Sub(now), 0), func() { s.run(key, k, gen) })
}

func (s *Scheduler) run(key string, k *keyState, gen uint64) {
	s.mu.Lock()
	if s.closed || gen != k.gen || k.running || k.pending == 0 {
		s.mu.Unlock()
		return
	}
	r := k.pending
	k.pending = 0
	k.running = true
	k.lastFire = time.Now()
	k.timer = nil
	s.wg.Add(1)
	s.mu.Unlock()

	defer s.wg.Done()
	s.fire(key, r)

	s.mu.Lock()
	defer s.mu.Unlock()
	k.running = false
	if k.pending != 0 && !s.closed {
		s.arm(key, k, time.Now())
	}
}

// Close cancels pending fires and waits for in-flight fires to return.
// Trigger after Close is a no-op.
func (s *Scheduler) Close() {
	s.mu.Lock()
	s.closed = true
	for _, k := range s.keys {
		if k.timer != nil {
			k.timer.Stop()
		}
	}
	s.mu.Unlock()
	s.wg.Wait()
}
```

- [ ] **Step 10: Run the scheduler tests under the race detector, three times, to verify they pass and are stable**

Run: `go test -race -count=3 -v -run TestScheduler ./internal/repo/ 2>&1 | grep -E '^(--- |ok|FAIL)' | sort | uniq -c`
Expected: each of `TestSchedulerDebounceMergesReasons`, `TestSchedulerMinInterval`, `TestSchedulerBurst`, `TestSchedulerSustainedChurn`, `TestSchedulerNeverConcurrentPerKey`, `TestSchedulerKeysIndependent` and `TestSchedulerClose` shows `3 --- PASS`, then one `ok` line.

- [ ] **Step 11: Lint and run the whole module's tests**

Run: `make lint && go test -race ./...`
Expected: `0 issues.` from golangci-lint, and every package `ok`.

- [ ] **Step 12: Commit**

```bash
git add internal/repo/scheduler.go internal/repo/scheduler_test.go
git commit -m "feat(repo): debounce and rate-limit recomputes per key" \
  -m "Trailing 150 ms debounce with a max-wait so sustained churn still shows progress, at most 4 fires/s per key, reasons OR-ed, and never two concurrent fires for one key." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 13: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin feat/repo-router-scheduler
gh pr create --base main --title "feat(repo): event router and recompute scheduler" --body "$(cat <<'EOF'
Adds the two pure building blocks of `internal/repo`:

- **Router** classifies absolute event paths (spec §4 step 3). File events go to the longest-prefix worktree root, so nested linked worktrees never count against the main worktree. `.git` internals become per-worktree ref events, refs events or worktree-set changes; everything else under `.git` is ignored.
- **Scheduler** does a per-key trailing debounce, with a max-wait and a min interval (spec §4 step 4). Reasons are OR-ed and fires for one key never overlap. The pinned `TestSchedulerBurst` bounds a 1000-trigger burst.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 7: `server` HTTP/WS, security, port fallback

**Branch:** `feat/server` · **Depends on:** Task 4

**Files:**
- Create: `internal/server/listen.go`, `internal/server/server.go`, `internal/server/hub.go`
- Test: `internal/server/listen_test.go`, `internal/server/server_test.go`, `internal/server/hub_test.go`
- Modify: `go.mod`, `go.sum`

**Pinned dependency** (verified with `go get` and `go doc` on 2026-09-23): `github.com/coder/websocket v1.8.15`, with no new transitive requirements. API used:
- `websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true}) (*Conn, error)`. We check `Origin` ourselves first, because in `--dev` the Origin is Vite's port, not ours.
- `websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: h}) (*Conn, *http.Response, error)`. Its doc says "You never need to close resp.Body yourself", and on success `resp.Body` is nil. So `Dial` call sites carry `//nolint:bodyclose` with that reason.
- `(*Conn).Read(ctx) (MessageType, []byte, error)`, `(*Conn).Close(StatusCode, reason string) error` (a close handshake with a 5 s timeout), `(*Conn).CloseNow() error`, `websocket.CloseStatus(err) StatusCode`, `websocket.StatusGoingAway` and `websocket.StatusNormalClosure`.
- `wsjson.Read(ctx, c, v)` and `wsjson.Write(ctx, c, v)`.

**Interfaces:**
- Consumes: `model.Snapshot` and `model.Patch` (Task 4), whose `Seq` is monotonically increasing.
- Produces: exactly the `internal/server` block in Shared Interfaces (`Source`, `Options`, `Server{URL}`, `Start`, `(*Server).Wait`). Behaviour Tasks 8, 9 and 14 rely on:
  - `Start` listens on `127.0.0.1`. `Options.Port == 0` means any free port (for tests); otherwise it tries `Port … Port+20`. The token is 32 random bytes, hex-encoded (64 chars). `URL` is `http://127.0.0.1:PORT/?t=TOKEN`.
  - Every request needs a `Host` of `127.0.0.1:PORT` or `localhost:PORT`, otherwise 403 (DNS rebinding).
  - The token is accepted as a `?t=` query parameter on **any** path, including `/ws?t=TOKEN`, which is how the web client (Task 9) connects, or as the cookie.
  - `GET /?t=TOKEN` sets the cookie `orion_t=TOKEN; Path=/; HttpOnly; SameSite=Strict` and responds `302 Location: /`.
  - Any other request needs the cookie or a `?t=` query token, otherwise 403.
  - `/ws` also needs `Origin` to be exactly `http://127.0.0.1:PORT` or `http://localhost:PORT` (a missing Origin is 403).
  - Responses carry `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
  - **Static files:** `Options.Assets` is served with an SPA fallback. A missing path without an extension gets `index.html`; a missing path with an extension gets 404.
  - **No UI build:** if `Assets` has no `index.html`, its `fallback.html` is served for every path, or a built-in "run `make web`" page if that is missing too, including when `Assets` is nil. With Task 1's `webassets.FS()`, `index.html` always exists (the fallback page *is* `index.html` when the UI isn't built).
  - **`Options.Dev`:** no static files (404; Vite serves the UI). `Host` and `Origin` may also use `VitePort` (5173) on `127.0.0.1` or `localhost`, because Vite's page at `http://localhost:5173` proxies `/ws` to us with `changeOrigin: true`. Any other port is still 403, and a non-dev server rejects 5173. The token is still required; the web client sends it as `/ws?t=TOKEN`.
  - **Interface addition:** exported `const VitePort = 5173` (Task 8c prints the Vite URL with it).
  - **WebSocket protocol:** on connect the server subscribes, then sends `Source.Snapshot()`, then every patch with `Seq > lastSentSeq`. Stale patches from the subscribe/snapshot race are dropped. Client `{"type":"resync"}` → a fresh snapshot. If the source closes the subscription channel (a dropped slow subscriber), the server resubscribes and sends a fresh snapshot. When the client disconnects, it unsubscribes.
  - **Shutdown:** when `ctx` is done, every WebSocket gets a close frame with `StatusGoingAway`. `Wait` returns (nil on a clean shutdown) once the HTTP server and every WebSocket handler have finished.

- [ ] **Step 1: Create the worktree and add the pinned dependency**

```bash
git worktree add .claude/worktrees/feat-server -b feat/server main
cd .claude/worktrees/feat-server
go get github.com/coder/websocket@v1.8.15
```

- [ ] **Step 2: Write the failing port-fallback tests**

`internal/server/listen_test.go`:

```go
package server

import (
	"net"
	"testing"
)

func TestListenZeroPicksFreePort(t *testing.T) {
	ln, err := listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	addr := ln.Addr().(*net.TCPAddr)
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) || addr.Port == 0 {
		t.Fatalf("addr = %v, want 127.0.0.1:<non-zero>", addr)
	}
}

func TestListenFallsBackToNextPort(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()
	taken := busy.Addr().(*net.TCPAddr).Port

	ln, err := listen(taken)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	got := ln.Addr().(*net.TCPAddr).Port
	if got <= taken || got > taken+20 {
		t.Fatalf("port = %d, want in (%d, %d]", got, taken, taken+20)
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/server/ 2>&1 | head -5`
Expected: build failure, `undefined: listen`.

- [ ] **Step 4: Implement the listener**

`internal/server/listen.go`:

```go
package server

import (
	"fmt"
	"net"
	"strconv"
)

// portTries is how many ports after the requested one listen tries.
const portTries = 20

// listen binds 127.0.0.1:port, falling back to port+1 … port+20 when taken.
// Port 0 asks the OS for any free port (used by tests).
func listen(port int) (net.Listener, error) {
	if port == 0 {
		return net.Listen("tcp", "127.0.0.1:0")
	}
	var firstErr error
	for p := port; p <= port+portTries && p <= 65535; p++ {
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
		if err == nil {
			return ln, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, fmt.Errorf("no free port in %d-%d: %w", port, port+portTries, firstErr)
}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `go test -count=1 -v ./internal/server/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: `--- PASS: TestListenZeroPicksFreePort` and `--- PASS: TestListenFallsBackToNextPort`, then `ok`.

- [ ] **Step 6: Commit**

```bash
git add internal/server/listen.go internal/server/listen_test.go
git commit -m "feat(server): bind 127.0.0.1 with next-free-port fallback" \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Write the failing HTTP tests**

The tests run a real server on port 0 and drive it with a fake `Source`. `fakeSource.dropAll` imitates the engine closing a slow subscriber's channel.

`internal/server/server_test.go`:

```go
package server

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/olliejudge/orion/internal/model"
)

// fakeSource is an in-memory Source whose snapshot and subscribers tests control.
type fakeSource struct {
	mu   sync.Mutex
	snap model.Snapshot
	subs map[int]chan model.Patch
	next int
}

func newFakeSource(seq uint64) *fakeSource {
	return &fakeSource{snap: model.Snapshot{Type: "snapshot", Seq: seq, Repo: model.RepoInfo{Name: "demo"}}, subs: map[int]chan model.Patch{}}
}

func (f *fakeSource) Snapshot() model.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

func (f *fakeSource) Subscribe() (<-chan model.Patch, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.next
	f.next++
	ch := make(chan model.Patch, 16)
	f.subs[id] = ch
	return ch, func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if c, ok := f.subs[id]; ok {
			delete(f.subs, id)
			close(c)
		}
	}
}

func (f *fakeSource) setSeq(seq uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snap.Seq = seq
}

func (f *fakeSource) publish(p model.Patch) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.subs {
		c <- p
	}
}

// dropAll closes every subscriber channel, as Engine does to a slow subscriber.
func (f *fakeSource) dropAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, c := range f.subs {
		delete(f.subs, id)
		close(c)
	}
}

func (f *fakeSource) subscribers() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.subs)
}

type harness struct {
	srv    *Server
	src    *fakeSource
	cancel context.CancelFunc
	base   string // http://127.0.0.1:PORT
	host   string // 127.0.0.1:PORT
	token  string
}

func startServer(t *testing.T, opt Options) *harness {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	src := newFakeSource(5)
	srv, err := Start(ctx, src, opt)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{srv: srv, src: src, cancel: cancel, base: "http://" + u.Host, host: u.Host, token: u.Query().Get("t")}
	t.Cleanup(func() {
		cancel()
		if err := srv.Wait(); err != nil {
			t.Errorf("Wait: %v", err)
		}
	})
	return h
}

// reply is a fully read HTTP response.
type reply struct {
	StatusCode int
	Header     http.Header
	Body       string
	Cookies    []*http.Cookie
}

// get performs a GET without following redirects. cookie "" sends none;
// mutate may adjust the request (e.g. its Host) before it is sent.
func (h *harness) get(t *testing.T, path, cookie string, mutate func(*http.Request)) reply {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, h.base+path, http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: "orion_t", Value: cookie})
	}
	if mutate != nil {
		mutate(req)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return reply{StatusCode: resp.StatusCode, Header: resp.Header, Body: string(b), Cookies: resp.Cookies()}
}

var uiFS = fstest.MapFS{
	"index.html":    {Data: []byte("<h1>orion app</h1>")},
	"assets/app.js": {Data: []byte("console.log(1)")},
}

func TestStartURLHasLoopbackAndToken(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	if !regexp.MustCompile(`^http://127\.0\.0\.1:\d+/\?t=[0-9a-f]{64}$`).MatchString(h.srv.URL) {
		t.Fatalf("URL = %q", h.srv.URL)
	}
}

func TestTokenQuerySetsCookieAndRedirects(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	resp := h.get(t, "/?t="+h.token, "", nil)
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/" {
		t.Fatalf("status %d location %q, want 302 to /", resp.StatusCode, resp.Header.Get("Location"))
	}
	var c *http.Cookie
	for _, ck := range resp.Cookies {
		if ck.Name == "orion_t" {
			c = ck
		}
	}
	if c == nil || c.Value != h.token || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
		t.Fatalf("cookie = %+v, want orion_t=<token>; HttpOnly; SameSite=Strict; Path=/", c)
	}
}

func TestRejectsMissingOrWrongToken(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	for _, tc := range []struct{ path, cookie string }{
		{"/", ""},
		{"/?t=wrong", ""},
		{"/?t=" + strings.Repeat("0", 64), ""},
		{"/assets/app.js", "wrong"},
		{"/ws", ""},
	} {
		if resp := h.get(t, tc.path, tc.cookie, nil); resp.StatusCode != http.StatusForbidden {
			t.Errorf("GET %s cookie=%q: status %d, want 403", tc.path, tc.cookie, resp.StatusCode)
		}
	}
}

func TestCookieOrQueryGrantsAccess(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	if resp := h.get(t, "/", h.token, nil); resp.StatusCode != 200 || resp.Body != "<h1>orion app</h1>" {
		t.Fatalf("GET / with cookie: %d", resp.StatusCode)
	}
	if resp := h.get(t, "/assets/app.js?t="+h.token, "", nil); resp.StatusCode != 200 {
		t.Fatalf("GET asset with query token: %d", resp.StatusCode)
	}
}

func TestRejectsForeignHostHeader(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	port := h.host[strings.LastIndex(h.host, ":")+1:]
	for host, want := range map[string]int{
		"127.0.0.1:" + port:          200,
		"localhost:" + port:          200,
		"evil.example:" + port:       403,
		"127.0.0.1:1":                403,
		"localhost":                  403,
		"attacker.localhost:" + port: 403,
	} {
		resp := h.get(t, "/", h.token, func(r *http.Request) { r.Host = host })
		if resp.StatusCode != want {
			t.Errorf("Host %q: status %d, want %d", host, resp.StatusCode, want)
		}
	}
}

func TestStaticSPAFallback(t *testing.T) {
	h := startServer(t, Options{Assets: uiFS})
	cases := []struct {
		path   string
		status int
		body   string
	}{
		{"/assets/app.js", 200, "console.log(1)"},
		{"/some/deep/link", 200, "<h1>orion app</h1>"},
		{"/missing.js", 404, ""},
	}
	for _, c := range cases {
		resp := h.get(t, c.path, h.token, nil)
		b := resp.Body
		if resp.StatusCode != c.status || (c.body != "" && b != c.body) {
			t.Errorf("GET %s: %d %q, want %d %q", c.path, resp.StatusCode, b, c.status, c.body)
		}
	}
}

func TestServesFallbackWhenUINotBuilt(t *testing.T) {
	h := startServer(t, Options{Assets: fstest.MapFS{"fallback.html": {Data: []byte("<p>run make web</p>")}}})
	resp := h.get(t, "/anything", h.token, nil)
	if b := resp.Body; resp.StatusCode != 200 || b != "<p>run make web</p>" {
		t.Fatalf("got %d %q", resp.StatusCode, b)
	}

	h2 := startServer(t, Options{})
	resp = h2.get(t, "/", h2.token, nil)
	if b := resp.Body; resp.StatusCode != 200 || !strings.Contains(b, "make web") {
		t.Fatalf("nil Assets: got %d %q", resp.StatusCode, b)
	}
}

func TestDevModeServesNoStatic(t *testing.T) {
	h := startServer(t, Options{Dev: true, Assets: uiFS})
	if resp := h.get(t, "/", h.token, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("dev GET /: %d, want 404", resp.StatusCode)
	}
}

func TestWaitReturnsAfterCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	srv, err := Start(ctx, newFakeSource(1), Options{})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	done := make(chan error, 1)
	go func() { done <- srv.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Wait = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after ctx was cancelled")
	}
}
```

- [ ] **Step 8: Write the failing WebSocket tests**

`internal/server/hub_test.go`:

```go
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/olliejudge/orion/internal/model"
)

type msg struct {
	Type string `json:"type"`
	Seq  uint64 `json:"seq"`
}

// dial opens /ws with the given Origin and cookie ("" = header absent). It
// returns the handshake's HTTP status (0 when there was no response).
func (h *harness) dial(t *testing.T, origin, cookie string) (*websocket.Conn, int, error) {
	t.Helper()
	hdr := http.Header{}
	if origin != "" {
		hdr.Set("Origin", origin)
	}
	if cookie != "" {
		hdr.Set("Cookie", "orion_t="+cookie)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, "ws://"+h.host+"/ws", &websocket.DialOptions{HTTPHeader: hdr}) //nolint:bodyclose // coder/websocket owns resp.Body ("You never need to close resp.Body yourself")
	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	if c != nil {
		t.Cleanup(func() { _ = c.CloseNow() })
	}
	return c, status, err
}

func (h *harness) mustDial(t *testing.T) *websocket.Conn {
	t.Helper()
	c, _, err := h.dial(t, h.base, h.token)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func read(t *testing.T, c *websocket.Conn) msg {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var m msg
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestWSRejectsForeignOrigin(t *testing.T) {
	h := startServer(t, Options{})
	for _, origin := range []string{"", "http://evil.example", "http://127.0.0.1:1", "https://" + h.host} {
		_, status, err := h.dial(t, origin, h.token)
		if err == nil || status != http.StatusForbidden {
			t.Errorf("Origin %q: err=%v status=%d, want 403", origin, err, status)
		}
	}
}

func TestWSAcceptsQueryToken(t *testing.T) {
	h := startServer(t, Options{})
	hdr := http.Header{"Origin": {"http://localhost:" + h.host[len("127.0.0.1:"):]}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws://"+h.host+"/ws?t="+h.token, &websocket.DialOptions{HTTPHeader: hdr}) //nolint:bodyclose // coder/websocket owns resp.Body ("You never need to close resp.Body yourself")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if m := read(t, c); m.Type != "snapshot" {
		t.Fatalf("first message %+v, want snapshot", m)
	}
}

func TestWSSnapshotThenPatches(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	if m := read(t, c); m.Type != "snapshot" || m.Seq != 5 {
		t.Fatalf("first message %+v, want snapshot seq 5", m)
	}
	waitSubs(t, h.src, 1)
	h.src.publish(model.Patch{Type: "patch", Seq: 5}) // already covered by the snapshot: dropped
	h.src.publish(model.Patch{Type: "patch", Seq: 6})
	if m := read(t, c); m.Type != "patch" || m.Seq != 6 {
		t.Fatalf("got %+v, want patch seq 6", m)
	}
}

func TestWSResyncSendsFreshSnapshot(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	read(t, c)
	h.src.setSeq(9)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, map[string]string{"type": "resync"}); err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m.Type != "snapshot" || m.Seq != 9 {
		t.Fatalf("got %+v, want snapshot seq 9", m)
	}
}

func TestWSResubscribesWhenDropped(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	read(t, c)
	waitSubs(t, h.src, 1)
	h.src.setSeq(20)
	h.src.dropAll()
	if m := read(t, c); m.Type != "snapshot" || m.Seq != 20 {
		t.Fatalf("got %+v, want fresh snapshot seq 20 after drop", m)
	}
	waitSubs(t, h.src, 1)
	h.src.publish(model.Patch{Type: "patch", Seq: 21})
	if m := read(t, c); m.Type != "patch" || m.Seq != 21 {
		t.Fatalf("got %+v, want patch 21 on the new subscription", m)
	}
}

func TestWSUnsubscribesOnDisconnect(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	read(t, c)
	waitSubs(t, h.src, 1)
	_ = c.Close(websocket.StatusNormalClosure, "bye")
	waitSubs(t, h.src, 0)
}

func TestWSShutdownSendsGoingAway(t *testing.T) {
	h := startServer(t, Options{})
	c := h.mustDial(t)
	read(t, c)
	h.cancel()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := c.Read(ctx)
	if got := websocket.CloseStatus(err); got != websocket.StatusGoingAway {
		t.Fatalf("close status = %v (err %v), want StatusGoingAway", got, err)
	}
}

func TestWSDevModeAllowsViteOrigin(t *testing.T) {
	h := startServer(t, Options{Dev: true})
	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.1:5173", h.base} {
		c, _, err := h.dial(t, origin, h.token)
		if err != nil {
			t.Fatalf("dev Origin %q: %v", origin, err)
		}
		if m := read(t, c); m.Type != "snapshot" {
			t.Fatalf("dev Origin %q: got %+v, want snapshot", origin, m)
		}
	}
	for _, origin := range []string{"http://evil.example:5173", "http://localhost:3000"} {
		if _, status, _ := h.dial(t, origin, h.token); status != http.StatusForbidden {
			t.Errorf("dev Origin %q: status %d, want 403", origin, status)
		}
	}
}

func TestWSRejectsViteOriginWithoutDev(t *testing.T) {
	h := startServer(t, Options{})
	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.1:5173"} {
		if _, status, _ := h.dial(t, origin, h.token); status != http.StatusForbidden {
			t.Errorf("non-dev Origin %q: status %d, want 403", origin, status)
		}
	}
}

func waitSubs(t *testing.T, f *fakeSource, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for f.subscribers() != n {
		if time.Now().After(deadline) {
			t.Fatalf("subscribers = %d, want %d", f.subscribers(), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
```

- [ ] **Step 9: Run them to verify they fail**

Run: `go test ./internal/server/ 2>&1 | head -5`
Expected: build failure, `undefined: Options` / `undefined: Start` / `undefined: Server`.

- [ ] **Step 10: Implement the HTTP server**

`internal/server/server.go`:

```go
// Package server serves the embedded UI and streams model patches over a
// WebSocket, guarded by a per-run token and Host/Origin checks.
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/olliejudge/orion/internal/model"
)

const cookieName = "orion_t"

// VitePort is the Vite dev server's port. With Options.Dev the browser page
// comes from there and Vite proxies /ws to us, so its origin is allowed too.
const VitePort = 5173

// builtinFallback is served when Assets has neither index.html nor fallback.html.
const builtinFallback = `<!doctype html><meta charset="utf-8"><title>orion</title>` +
	`<p>The orion UI is not built. Run <code>make web</code> and rebuild.</p>`

// Source is what the server streams: a snapshot plus a patch subscription.
type Source interface {
	Snapshot() model.Snapshot
	Subscribe() (<-chan model.Patch, func())
}

// Options configures Start. Port 0 picks any free port. Dev serves only /ws
// (Vite serves the UI on VitePort and proxies /ws). Assets is the built UI;
// when it has no index.html, its fallback.html (or a built-in page) is served.
type Options struct {
	Port   int
	Dev    bool
	Assets fs.FS
}

// Server is a running orion HTTP server.
type Server struct {
	URL string // http://127.0.0.1:PORT/?t=TOKEN

	ctx      context.Context
	src      Source
	opt      Options
	port     string
	token    string
	hasUI    bool
	fallback []byte
	http     *http.Server
	done     chan struct{}
	err      error

	mu      sync.Mutex
	closing bool
	conns   sync.WaitGroup
}

// Start listens on 127.0.0.1 (with port fallback) and serves until ctx is done.
func Start(ctx context.Context, src Source, opt Options) (*Server, error) {
	ln, err := listen(opt.Port)
	if err != nil {
		return nil, err
	}
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("generate token: %w", err)
	}
	s := &Server{
		ctx:   ctx,
		src:   src,
		opt:   opt,
		port:  strconv.Itoa(ln.Addr().(*net.TCPAddr).Port),
		token: hex.EncodeToString(tok),
		done:  make(chan struct{}),
	}
	s.URL = "http://127.0.0.1:" + s.port + "/?t=" + s.token
	s.hasUI, s.fallback = inspectAssets(opt.Assets)
	s.http = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go func() {
		err := s.http.Serve(ln)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		s.err = err
		s.markClosing()
		close(s.done)
	}()
	go func() {
		<-ctx.Done()
		s.markClosing()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.http.Shutdown(sctx)
	}()
	return s, nil
}

// Wait blocks until the server has stopped and every WebSocket has closed.
func (s *Server) Wait() error {
	<-s.done
	s.conns.Wait()
	return s.err
}

func (s *Server) markClosing() {
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
}

func inspectAssets(a fs.FS) (bool, []byte) {
	if a != nil {
		if _, err := fs.Stat(a, "index.html"); err == nil {
			return true, nil
		}
		if b, err := fs.ReadFile(a, "fallback.html"); err == nil {
			return false, b
		}
	}
	return false, []byte(builtinFallback)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !s.loopback(r.Host) {
		http.Error(w, "forbidden host", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/" && s.validToken(r.URL.Query().Get("t")) {
		http.SetCookie(w, &http.Cookie{
			Name: cookieName, Value: s.token, Path: "/",
			HttpOnly: true, SameSite: http.SameSiteStrictMode,
		})
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	switch {
	case r.URL.Path == "/ws":
		s.serveWS(w, r)
	case s.opt.Dev:
		http.Error(w, "orion --dev: the UI is served by the Vite dev server", http.StatusNotFound)
	default:
		s.serveStatic(w, r)
	}
}

func (s *Server) validToken(t string) bool {
	return t != "" && subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
}

func (s *Server) authorized(r *http.Request) bool {
	if s.validToken(r.URL.Query().Get("t")) {
		return true
	}
	c, err := r.Cookie(cookieName)
	return err == nil && s.validToken(c.Value)
}

// loopback reports whether hostport is 127.0.0.1:PORT or localhost:PORT, or
// (Dev only) the same hosts on VitePort.
func (s *Server) loopback(hostport string) bool {
	h, p, err := net.SplitHostPort(hostport)
	if err != nil || (h != "127.0.0.1" && h != "localhost") {
		return false
	}
	return p == s.port || (s.opt.Dev && p == strconv.Itoa(VitePort))
}

func (s *Server) originOK(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Path != "" || u.RawQuery != "" || u.User != nil {
		return false
	}
	return s.loopback(u.Host)
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.hasUI {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(s.fallback)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if fi, err := fs.Stat(s.opt.Assets, name); err != nil || fi.IsDir() {
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		name = "index.html" // SPA route
	}
	http.ServeFileFS(w, r, s.opt.Assets, name)
}
```

- [ ] **Step 11: Implement the WebSocket hub**

`internal/server/hub.go`:

```go
package server

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const writeTimeout = 10 * time.Second

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	if !s.originOK(r.Header.Get("Origin")) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	}
	s.conns.Add(1)
	s.mu.Unlock()
	defer s.conns.Done()

	// Origin was verified above against the exact loopback host:port; the
	// library's own same-host check would reject Vite's origin in --dev.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()
	s.stream(c)
}

// stream sends a snapshot, then every newer patch, until the client goes away
// or the server shuts down. {"type":"resync"} from the client, or the source
// dropping our subscription, triggers a fresh snapshot.
func (s *Server) stream(c *websocket.Conn) {
	resync := make(chan struct{}, 1)
	gone := make(chan struct{})
	readCtx, stopRead := context.WithCancel(context.Background())
	defer stopRead()
	go func() {
		defer close(gone)
		for {
			var m struct {
				Type string `json:"type"`
			}
			if err := wsjson.Read(readCtx, c, &m); err != nil {
				return
			}
			if m.Type == "resync" {
				select {
				case resync <- struct{}{}:
				default:
				}
			}
		}
	}()

	ch, unsub := s.src.Subscribe()
	defer func() { unsub() }()
	last, err := s.sendSnapshot(c)
	if err != nil {
		return
	}
	for {
		select {
		case <-s.ctx.Done():
			_ = c.Close(websocket.StatusGoingAway, "orion is shutting down")
			return
		case <-gone:
			return
		case <-resync:
			if last, err = s.sendSnapshot(c); err != nil {
				return
			}
		case p, ok := <-ch:
			if !ok { // dropped as a slow subscriber: start over
				unsub()
				ch, unsub = s.src.Subscribe()
				if last, err = s.sendSnapshot(c); err != nil {
					return
				}
				continue
			}
			if p.Seq <= last {
				continue // already covered by the snapshot we sent
			}
			if err := write(c, p); err != nil {
				return
			}
			last = p.Seq
		}
	}
}

func (s *Server) sendSnapshot(c *websocket.Conn) (uint64, error) {
	snap := s.src.Snapshot()
	return snap.Seq, write(c, snap)
}

func write(c *websocket.Conn, v any) error {
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	return wsjson.Write(ctx, c, v)
}
```

- [ ] **Step 12: Tidy modules and run the tests under the race detector**

Run: `go mod tidy && go test -race -count=1 -v ./internal/server/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: `--- PASS` for all 20 tests: the two `TestListen…`, `TestStartURLHasLoopbackAndToken`, `TestTokenQuerySetsCookieAndRedirects`, `TestRejectsMissingOrWrongToken`, `TestCookieOrQueryGrantsAccess`, `TestRejectsForeignHostHeader`, `TestStaticSPAFallback`, `TestServesFallbackWhenUINotBuilt`, `TestDevModeServesNoStatic`, `TestWaitReturnsAfterCancel`, `TestWSRejectsForeignOrigin`, `TestWSAcceptsQueryToken`, `TestWSSnapshotThenPatches`, `TestWSResyncSendsFreshSnapshot`, `TestWSResubscribesWhenDropped`, `TestWSUnsubscribesOnDisconnect`, `TestWSShutdownSendsGoingAway`, `TestWSDevModeAllowsViteOrigin` and `TestWSRejectsViteOriginWithoutDev`. Then `ok`, in about 1–2 s.

- [ ] **Step 13: Lint and run the whole module's tests**

Run: `make lint && go test -race ./...`
Expected: `0 issues.` and every package `ok`.

- [ ] **Step 14: Commit**

```bash
git add go.mod go.sum internal/server
git commit -m "feat(server): serve UI and stream patches over a token-guarded WebSocket" \
  -m "Per-run 32-byte token (query once, then HttpOnly SameSite=Strict cookie), Host and Origin pinned to the loopback port against DNS rebinding, SPA static serving with the not-built fallback, and a snapshot-then-patches hub with resync and resubscribe-after-drop." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 15: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin feat/server
gh pr create --base main --title "feat(server): HTTP + WebSocket server with token, Host and Origin checks" --body "$(cat <<'EOF'
Adds `internal/server` (spec §7):

- Binds `127.0.0.1`, falling back from the requested port to the next free one (up to +20).
- A per-run 32-byte token: `/?t=` sets an HttpOnly SameSite=Strict cookie and redirects to `/`. Every other request needs the cookie or the token, or it gets a 403.
- The `Host` header must be `127.0.0.1:PORT` or `localhost:PORT`, and the WebSocket `Origin` must match. This blocks DNS rebinding and cross-site reads. `--dev` additionally allows Vite's origin on port 5173.
- Static files with an SPA fallback, or the "UI not built" page.
- `/ws` sends a snapshot and then every newer patch. `{"type":"resync"}` gets a fresh snapshot, and so does a subscription the source dropped. On shutdown, clients get a `going away` close frame.

Pins `github.com/coder/websocket v1.8.15`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 8a: `repo` Engine core: compute, Open, recompute, publish

**Branch:** `feat/engine` · **Depends on:** Tasks 3b, 4, 6

Task 8 is split into three reviewable PRs: 8a (state computation and recompute logic, driven directly in tests), 8b (the watcher loop and the end-to-end engine tests) and 8c (CLI wiring and the WebSocket integration test).

**Files:**
- Create: `internal/repo/compute.go` (gitx → overlay and tree builders, plus the per-worktree cache type)
- Create: `internal/repo/engine.go` (`Engine`, `Open`, `Snapshot`, `Subscribe`, worktree sync, routing rebuild, publish)
- Create: `internal/repo/recompute.go` (`fire`: the per-key recompute of spec §4 step 5)
- Test: `internal/repo/engine_test.go`, `internal/repo/recompute_test.go`

**Interfaces:**
- Consumes:
  - From `gitx` (Tasks 3a and 3b): `Runner`, `CheckVersion`, `MainRoot`, `CommonDir`, `ResolveBase` (short ref names; an unknown override is an error; `"", "", nil` when there are no commits), `MergeBase` (`"", nil` for unrelated histories), `CommitSubject`, `ListWorktrees` (symlink-resolved `Path`), `WorktreeAdminDir`, `LsTree`, `DiffNameStatus`, `Status` and `PairMoves`. Also the `Change` / `ChangeKind` values `Added`, `Modified`, `Deleted` and `Renamed`, whose strings equal `model.Kind`'s.
  - From `model` (Task 4): `IDFor`, `NewStore`, `(*Store).Apply`, `(*Store).Snapshot`, `(*Store).State` and every state type. The Store assigns `ColorIndex` itself; the engine passes `-1`.
  - From Task 6: `NewRouter`, `RouteTarget`, `Route`, `FileEvent`, `under` and the `Reason*` constants.
  - From `testrepo` (Task 2), in tests.
- Produces: `Open`, `(*Engine).Snapshot` and `(*Engine).Subscribe` exactly as in Shared Interfaces, plus these package-internal pieces that Task 8b uses:
  - `Engine` fields: `work sync.Mutex` (serialises recomputes), `router atomic.Pointer[Router]`, `ready chan struct{}` (made in `Open`; Task 8b closes it), and `watchRoots func(map[string]model.WorktreeID)` (nil until Task 8b's `Run` sets it; called with `e.work` held whenever the worktree set changes, with the roots outside the main root).
  - `func (e *Engine) fire(ctx context.Context, key string, r Reason)`, and the scheduler keys `keyRefs = "refs"` and `keyWorktrees = "worktrees"`. Every other key is a `model.WorktreeID` string.
  - `func (e *Engine) rebuildRouting()` (call with `e.work` held), `func canon(p string) string`, and `const subBuffer = 256`.
  - Test helpers in `engine_test.go`: `initRepo(t, files map[string]string) *testrepo.Repo` (one commit on `main`), `wtID(path string) model.WorktreeID` and `openState(t, path, base string) model.State`.
- Rules implemented here:
  - **Label:** branch, else the 7-char sha, else `"main"`.
  - **Base tree:** `LsTree(baseSha)`, or empty when `baseSha == ""`.
  - **Committed overlay:** empty when `Head` is unborn, `baseSha == ""`, `Head == baseSha`, `MergeBase == ""` (an unrelated history: an orphan branch would otherwise paint its whole tree as "committed") or `MergeBase == Head`. Otherwise it is `DiffNameStatus(mergeBase, Head)`, with sizes from one `LsTree(Head)` map lookup and 0 for deleted files.
  - **Uncommitted overlay:** `PairMoves(Status(root))`, with sizes from `os.Stat` (0 for deleted or unreadable files). Uncommitted entries override committed ones.
  - **Worktrees:** prunable worktrees are skipped. A worktree whose directory vanished triggers rediscovery.
  - **When a worktree's HEAD moves**, its subject, committed overlay **and** uncommitted overlay are recomputed together, so one patch shows uncommitted → committed with the new HEAD. That patch is what makes Task 4's Store emit the `commit` row.
  - **Ref events** re-check the base first, so a commit on the base branch appears as merged rather than briefly as committed-on-branch.
  - **Unknown `--base`:** warn once, then use the main worktree's HEAD (spec §8). The override is kept, so creating that branch later makes it the base.
  - **Git failures** (spec §8): an error is logged, and each cache keeps its last good value. A base that "vanishes" (sha `""` after having one) is treated as a git failure.
  - **Publishing:** `publish` applies the new state and fans the patch out while holding `e.mu`, and it is always called with `e.work` held, so patches go out in recompute order. `Subscribe` and `Snapshot` take the same `e.mu`, so subscribing and then snapshotting leaves no gap. A subscriber whose 256-slot buffer is full is closed and dropped.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-engine -b feat/engine main
cd .claude/worktrees/feat-engine
```

- [ ] **Step 2: Write the failing Open tests**

These tests build synthetic repos with `testrepo`, and check the initial `model.State` (base tree, both overlay stages, sizes, labels, prunable and orphan worktrees, the `--base` fallback) plus the slow-subscriber drop.

`internal/repo/engine_test.go`:

```go
package repo

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
	"github.com/olliejudge/orion/internal/testrepo"
)

// initRepo returns a repo with one commit (testrepo starts on branch main).
func initRepo(t *testing.T, files map[string]string) *testrepo.Repo {
	t.Helper()
	r := testrepo.New(t)
	var paths []string
	for p, c := range files {
		r.Write(p, c)
		paths = append(paths, p)
	}
	r.Add(paths...)
	r.Commit("init")
	return r
}

func wtID(p string) model.WorktreeID { return model.IDFor(canon(p)) }

func openState(t *testing.T, path, base string) model.State {
	t.Helper()
	e, err := Open(context.Background(), path, base, gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	return e.store.State()
}

func TestOpenBuildsBaseTreeAndOverlays(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n", "old.txt": "old\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	wt.Write("lib.go", "package lib\n")
	wt.Write("README.md", "# demo v2\n")
	wt.Remove("old.txt")
	wt.Add("lib.go", "README.md", "old.txt")
	wt.Commit("feature work")
	wt.Write("README.md", "# demo v3, uncommitted\n") // uncommitted overrides committed
	wt.Write("new.txt", "brand new\n")

	st := openState(t, r.Path(), "")

	if len(st.Tree) != 2 || st.Tree["README.md"] != 7 || st.Tree["old.txt"] != 4 {
		t.Fatalf("Tree = %v", st.Tree)
	}
	id := wtID(wt.Path())
	want := map[string]model.ChangeEntry{
		"lib.go":    {Path: "lib.go", Kind: model.Added, Stage: model.Committed, Size: 12},
		"old.txt":   {Path: "old.txt", Kind: model.Deleted, Stage: model.Committed, Size: 0},
		"README.md": {Path: "README.md", Kind: model.Modified, Stage: model.Uncommitted, Size: 23},
		"new.txt":   {Path: "new.txt", Kind: model.Added, Stage: model.Uncommitted, Size: 10},
	}
	got := st.Overlays[id]
	if len(got) != len(want) {
		t.Fatalf("overlay = %+v, want %+v", got, want)
	}
	for p, w := range want {
		if got[p] != w {
			t.Errorf("overlay[%q] = %+v, want %+v", p, got[p], w)
		}
	}
	if len(st.Overlays[wtID(r.Path())]) != 0 {
		t.Errorf("main overlay = %v, want empty", st.Overlays[wtID(r.Path())])
	}
	if len(st.Worktrees) != 2 || !st.Worktrees[0].IsMain || st.Worktrees[0].Label != "main" {
		t.Fatalf("Worktrees = %+v, want main first", st.Worktrees)
	}
	if w := st.Worktrees[1]; w.ID != id || w.Label != "feature" || w.Branch != "feature" || w.HeadSubject != "feature work" {
		t.Errorf("feature worktree = %+v", w)
	}
	if st.Repo.Name != filepath.Base(canon(r.Path())) || st.Repo.BaseSha == "" {
		t.Errorf("Repo = %+v", st.Repo)
	}
}

func TestOpenEmptyRepo(t *testing.T) {
	r := testrepo.New(t)
	r.Write("a.txt", "abc")
	st := openState(t, r.Path(), "")
	if len(st.Tree) != 0 || st.Repo.BaseSha != "" {
		t.Fatalf("Tree = %v, BaseSha = %q; want empty", st.Tree, st.Repo.BaseSha)
	}
	e := st.Overlays[wtID(r.Path())]["a.txt"]
	if e != (model.ChangeEntry{Path: "a.txt", Kind: model.Added, Stage: model.Uncommitted, Size: 3}) {
		t.Fatalf("a.txt entry = %+v", e)
	}
}

func TestOpenDetachedWorktreeLabel(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	dir := filepath.Join(t.TempDir(), "detached")
	r.Git("worktree", "add", "--detach", dir)
	head := r.Git("rev-parse", "HEAD")
	st := openState(t, r.Path(), "")
	for _, w := range st.Worktrees {
		if w.ID == wtID(dir) {
			if w.Label != head[:7] || w.Branch != "" {
				t.Fatalf("detached worktree = %+v, want label %q", w, head[:7])
			}
			return
		}
	}
	t.Fatalf("detached worktree missing from %+v", st.Worktrees)
}

func TestOpenSkipsPrunableWorktree(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "gone"), "gone")
	if err := os.RemoveAll(wt.Path()); err != nil {
		t.Fatal(err)
	}
	st := openState(t, r.Path(), "")
	if len(st.Worktrees) != 1 || !st.Worktrees[0].IsMain {
		t.Fatalf("Worktrees = %+v, want only main", st.Worktrees)
	}
}

func TestOpenUnknownBaseFallsBack(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	r.Branch("work")
	r.Checkout("work")
	r.Write("b.txt", "b")
	r.Add("b.txt")
	head := r.Commit("work")
	st := openState(t, r.Path(), "no-such-branch")
	// spec §8: fall back to the main worktree's HEAD (not the default order, which would pick main)
	if st.Repo.BaseSha != head || st.Repo.Base != "work" {
		t.Fatalf("Repo = %+v, want base work at %s", st.Repo, head)
	}
}

func TestOpenNotARepo(t *testing.T) {
	if _, err := Open(context.Background(), t.TempDir(), "", gitx.Runner{}); err == nil {
		t.Fatal("Open outside a repo: want error")
	}
}

func TestEngineDropsSlowSubscriber(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	e, err := Open(context.Background(), r.Path(), "", gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	ch, unsub := e.Subscribe()
	defer unsub()
	for i := 0; i < subBuffer+10; i++ {
		st := e.state()
		tree := map[string]int64{"a.txt": 1}
		tree[fmt.Sprintf("gen/%d", i)] = int64(i)
		st.Tree = tree
		e.publish(st)
	}
	n := 0
	for range ch { // must terminate: the engine closed the channel
		n++
	}
	if n != subBuffer {
		t.Fatalf("received %d patches before the drop, want %d", n, subBuffer)
	}
	unsub() // safe after a drop
}

func TestOpenUnrelatedHistoryHasNoCommittedOverlay(t *testing.T) {
	r := initRepo(t, map[string]string{"a.txt": "a"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "lonely"), "lonely")
	wt.Git("checkout", "--quiet", "--orphan", "orphan")
	wt.Git("rm", "-rf", "--quiet", ".")
	wt.Write("b.txt", "b")
	wt.Add("b.txt")
	wt.Commit("orphan root")
	st := openState(t, r.Path(), "")
	if got := st.Overlays[wtID(wt.Path())]; len(got) != 0 {
		t.Fatalf("orphan worktree overlay = %+v, want empty", got)
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/repo/ 2>&1 | head -5`
Expected: build failure, `undefined: Open` / `undefined: canon`.

- [ ] **Step 4: Implement the state builders**

`internal/repo/compute.go`:

```go
package repo

import (
	"context"
	"os"
	"path/filepath"
	"sort"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
)

// wtState is the engine's cached view of one worktree. Maps are replaced,
// never mutated, because model.Store keeps references to published States.
type wtState struct {
	g           gitx.Worktree // g.Path is canonical (symlinks resolved)
	subject     string        // subject of g.Head
	subjectFor  string        // the Head that subject belongs to
	committed   map[string]model.ChangeEntry
	uncommitted map[string]model.ChangeEntry
}

// canon returns p with symlinks resolved (macOS: /var → /private/var), or p
// cleaned when it does not exist.
func canon(p string) string {
	if c, err := filepath.EvalSymlinks(p); err == nil {
		return c
	}
	return filepath.Clean(p)
}

// label implements model.Worktree.Label: branch, else short sha, else "main".
func label(g gitx.Worktree) string {
	switch {
	case g.Branch != "":
		return g.Branch
	case len(g.Head) >= 7:
		return g.Head[:7]
	case g.Head != "":
		return g.Head
	default:
		return "main"
	}
}

// baseTree lists the files of sha. An empty sha (no commits) is an empty tree.
func baseTree(ctx context.Context, r gitx.Runner, dir, sha string) (map[string]int64, error) {
	tree := map[string]int64{}
	if sha == "" {
		return tree, nil
	}
	files, err := gitx.LsTree(ctx, r, dir, sha)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		tree[f.Path] = f.Size
	}
	return tree, nil
}

// committedOverlay is what head has on top of merge-base(baseSha, head).
// It is empty when head is unborn, has no base to compare with, is already
// contained in base, or shares no history with base (orphan branch: showing
// its whole tree as "committed" would drown the map).
func committedOverlay(ctx context.Context, r gitx.Runner, dir, baseSha, head string) (map[string]model.ChangeEntry, error) {
	out := map[string]model.ChangeEntry{}
	if head == "" || baseSha == "" || head == baseSha {
		return out, nil
	}
	mb, err := gitx.MergeBase(ctx, r, dir, baseSha, head)
	if err != nil {
		return nil, err
	}
	if mb == "" || mb == head {
		return out, nil
	}
	changes, err := gitx.DiffNameStatus(ctx, r, dir, mb, head)
	if err != nil {
		return nil, err
	}
	if len(changes) == 0 {
		return out, nil
	}
	files, err := gitx.LsTree(ctx, r, dir, head)
	if err != nil {
		return nil, err
	}
	sizes := make(map[string]int64, len(files))
	for _, f := range files {
		sizes[f.Path] = f.Size
	}
	for _, c := range changes {
		e := model.ChangeEntry{Path: c.Path, Kind: model.Kind(c.Kind), From: c.From, Stage: model.Committed}
		if c.Kind != gitx.Deleted {
			e.Size = sizes[c.Path]
		}
		out[c.Path] = e
	}
	return out, nil
}

// uncommittedOverlay is `git status` for the worktree at root, with plain
// moves paired into renames and sizes taken from the working tree.
func uncommittedOverlay(ctx context.Context, r gitx.Runner, root string) (map[string]model.ChangeEntry, error) {
	changes, err := gitx.Status(ctx, r, root)
	if err != nil {
		return nil, err
	}
	out := map[string]model.ChangeEntry{}
	for _, c := range gitx.PairMoves(changes) {
		e := model.ChangeEntry{Path: c.Path, Kind: model.Kind(c.Kind), From: c.From, Stage: model.Uncommitted}
		if c.Kind != gitx.Deleted {
			if fi, err := os.Stat(filepath.Join(root, filepath.FromSlash(c.Path))); err == nil {
				e.Size = fi.Size()
			}
		}
		out[c.Path] = e
	}
	return out, nil
}

// mergeOverlays returns a new map: committed entries, overridden by uncommitted ones.
func mergeOverlays(committed, uncommitted map[string]model.ChangeEntry) map[string]model.ChangeEntry {
	out := make(map[string]model.ChangeEntry, len(committed)+len(uncommitted))
	for p, e := range committed {
		out[p] = e
	}
	for p, e := range uncommitted {
		out[p] = e
	}
	return out
}

func (ws *wtState) model(id model.WorktreeID) model.Worktree {
	return model.Worktree{
		ID:          id,
		Path:        ws.g.Path,
		Label:       label(ws.g),
		Branch:      ws.g.Branch,
		Head:        ws.g.Head,
		IsMain:      ws.g.IsMain,
		Locked:      ws.g.Locked,
		ColorIndex:  -1, // the Store assigns colours
		HeadSubject: ws.subject,
	}
}

// buildState assembles a fresh model.State from the engine caches.
func buildState(info model.RepoInfo, tree map[string]int64, wts map[model.WorktreeID]*wtState) model.State {
	st := model.State{Repo: info, Tree: tree, Overlays: map[model.WorktreeID]map[string]model.ChangeEntry{}}
	for id, ws := range wts {
		st.Worktrees = append(st.Worktrees, ws.model(id))
		if m := mergeOverlays(ws.committed, ws.uncommitted); len(m) > 0 {
			st.Overlays[id] = m
		}
	}
	sort.Slice(st.Worktrees, func(i, j int) bool {
		a, b := st.Worktrees[i], st.Worktrees[j]
		if a.IsMain != b.IsMain {
			return a.IsMain
		}
		return a.Path < b.Path
	})
	return st
}
```

- [ ] **Step 5: Implement the engine core**

`internal/repo/engine.go`:

```go
package repo

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
)

// subBuffer is each subscriber's channel capacity; a subscriber that falls
// this far behind is dropped and must resync.
const subBuffer = 256

// Engine owns the live model of one repo: it watches the filesystem,
// recomputes the affected parts with gitx and broadcasts model patches.
type Engine struct {
	r            gitx.Runner
	baseOverride string
	warnedBase   bool
	mainRoot     string // canonical
	commonDir    string // canonical
	name         string

	work    sync.Mutex // serialises recomputes; guards the fields below
	baseRef string
	baseSha string
	tree    map[string]int64
	wts     map[model.WorktreeID]*wtState
	// watchRoots is set by Run: it receives the roots (outside the main
	// root) that must be watched, mapped to their worktree.
	watchRoots func(roots map[string]model.WorktreeID)

	router atomic.Pointer[Router]
	ready  chan struct{} // closed once Run's watchers are live

	mu      sync.Mutex // guards store and subs
	store   *model.Store
	subs    map[int]chan model.Patch
	nextSub int
}

// Open resolves the repo containing path and computes its initial state.
func Open(ctx context.Context, path, baseOverride string, r gitx.Runner) (*Engine, error) {
	if _, err := gitx.CheckVersion(ctx, r); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	mainRoot, err := gitx.MainRoot(ctx, r, abs)
	if err != nil {
		return nil, fmt.Errorf("not a git repository: %s: %w", abs, err)
	}
	commonDir, err := gitx.CommonDir(ctx, r, abs)
	if err != nil {
		return nil, err
	}
	e := &Engine{
		r:            r,
		baseOverride: baseOverride,
		mainRoot:     canon(mainRoot),
		commonDir:    canon(commonDir),
		wts:          map[model.WorktreeID]*wtState{},
		ready:        make(chan struct{}),
		subs:         map[int]chan model.Patch{},
	}
	e.name = filepath.Base(e.mainRoot)
	ref, sha, err := e.lookupBase(ctx)
	if err != nil {
		return nil, err
	}
	tree, err := baseTree(ctx, r, e.mainRoot, sha)
	if err != nil {
		return nil, err
	}
	e.baseRef, e.baseSha, e.tree = ref, sha, tree
	e.work.Lock()
	defer e.work.Unlock()
	if err := e.syncWorktrees(ctx, true); err != nil { // also builds the router
		return nil, err
	}
	e.store = model.NewStore(e.state(), time.Now())
	return e, nil
}

// Snapshot returns the current full state.
func (e *Engine) Snapshot() model.Snapshot {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.store.Snapshot()
}

// Subscribe returns a channel of every future patch. When the buffer fills,
// the channel is closed and dropped; the subscriber must Subscribe again and
// take a fresh Snapshot. The returned func unsubscribes (safe to call twice).
func (e *Engine) Subscribe() (<-chan model.Patch, func()) {
	e.mu.Lock()
	defer e.mu.Unlock()
	id := e.nextSub
	e.nextSub++
	ch := make(chan model.Patch, subBuffer)
	e.subs[id] = ch
	return ch, func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if c, ok := e.subs[id]; ok {
			delete(e.subs, id)
			close(c)
		}
	}
}

// syncWorktrees reconciles e.wts with `git worktree list`: adds new worktrees
// (fully computed), drops removed or prunable ones, refreshes metadata, and
// recomputes committed overlays for moved HEADs (all of them when force).
func (e *Engine) syncWorktrees(ctx context.Context, force bool) error {
	list, err := gitx.ListWorktrees(ctx, e.r, e.mainRoot)
	if err != nil {
		return err
	}
	seen := map[model.WorktreeID]bool{}
	changed := false
	for _, g := range list {
		if g.Prunable {
			continue
		}
		g.Path = canon(g.Path)
		id := model.IDFor(g.Path)
		seen[id] = true
		ws, ok := e.wts[id]
		if !ok {
			ws = &wtState{g: g, uncommitted: map[string]model.ChangeEntry{}}
			e.wts[id] = ws
			changed = true
			e.refreshHead(ctx, ws)
			e.refreshStatus(ctx, ws)
			continue
		}
		moved := ws.g.Head != g.Head
		ws.g = g
		if moved || force {
			e.refreshHead(ctx, ws)
		}
		if moved {
			// A commit moves HEAD and empties status together; recompute both
			// so one patch shows uncommitted → committed with the new HEAD.
			e.refreshStatus(ctx, ws)
		}
	}
	for id := range e.wts {
		if !seen[id] {
			delete(e.wts, id)
			changed = true
		}
	}
	if changed {
		e.rebuildRouting()
	}
	return nil
}

// refreshHead recomputes ws's HEAD subject and committed overlay.
func (e *Engine) refreshHead(ctx context.Context, ws *wtState) {
	if ws.subjectFor != ws.g.Head {
		ws.subject, ws.subjectFor = "", ws.g.Head
		if ws.g.Head != "" {
			if s, err := gitx.CommitSubject(ctx, e.r, e.mainRoot, ws.g.Head); err == nil {
				ws.subject = s
			} else {
				log.Printf("orion: subject of %s: %v", ws.g.Head, err)
			}
		}
	}
	m, err := committedOverlay(ctx, e.r, e.mainRoot, e.baseSha, ws.g.Head)
	if err != nil {
		log.Printf("orion: committed changes of %s: %v", ws.g.Path, err)
		return
	}
	ws.committed = m
}

// refreshStatus recomputes ws's uncommitted overlay, keeping the last good
// one on error.
func (e *Engine) refreshStatus(ctx context.Context, ws *wtState) {
	m, err := uncommittedOverlay(ctx, e.r, ws.g.Path)
	if err != nil {
		log.Printf("orion: status %s: %v", ws.g.Path, err)
		return
	}
	ws.uncommitted = m
}

// rebuildRouting installs a Router for the current worktrees and reports the
// roots that need their own watch (linked worktrees outside the main root) to
// e.watchRoots, which Run sets. e.work must be held.
func (e *Engine) rebuildRouting() {
	var targets []RouteTarget
	outside := map[string]model.WorktreeID{}
	for id, ws := range e.wts {
		t := RouteTarget{ID: id, Root: ws.g.Path}
		if ws.g.IsMain {
			t.AdminDir = e.commonDir
		} else if admin, err := gitx.WorktreeAdminDir(ws.g.Path); err == nil {
			t.AdminDir = canon(admin)
		}
		targets = append(targets, t)
		if _, inside := under(ws.g.Path, e.mainRoot); !inside {
			outside[ws.g.Path] = id
		}
	}
	e.router.Store(NewRouter(e.commonDir, targets))
	if e.watchRoots != nil {
		e.watchRoots(outside)
	}
}

// lookupBase resolves the base branch. When --base cannot be resolved it
// warns (once) and falls back to the main worktree's HEAD (spec §8). The
// override is kept, so creating that branch later makes it the base.
func (e *Engine) lookupBase(ctx context.Context) (string, string, error) {
	ref, sha, err := gitx.ResolveBase(ctx, e.r, e.mainRoot, e.baseOverride)
	if err == nil || e.baseOverride == "" {
		return ref, sha, err
	}
	if !e.warnedBase {
		log.Printf("orion: %v; falling back to the main worktree's HEAD", err)
		e.warnedBase = true
	}
	wts, err := gitx.ListWorktrees(ctx, e.r, e.mainRoot)
	if err != nil {
		return "", "", err
	}
	for _, w := range wts {
		if w.IsMain {
			return label(w), w.Head, nil
		}
	}
	return "", "", nil
}

func (e *Engine) state() model.State {
	return buildState(model.RepoInfo{Name: e.name, Base: e.baseRef, BaseSha: e.baseSha}, e.tree, e.wts)
}

// publish applies st to the store and fans the patch out. A subscriber whose
// buffer is full is closed and dropped.
func (e *Engine) publish(st model.State) {
	e.mu.Lock()
	defer e.mu.Unlock()
	p, ok := e.store.Apply(st, time.Now())
	if !ok {
		return
	}
	for id, ch := range e.subs {
		select {
		case ch <- p:
		default:
			delete(e.subs, id)
			close(ch)
		}
	}
}
```

- [ ] **Step 6: Run the Open tests to verify they pass**

Run: `go test -race -count=1 -v -run 'TestOpen|TestEngineDropsSlowSubscriber' ./internal/repo/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: `--- PASS` for `TestOpenBuildsBaseTreeAndOverlays`, `TestOpenEmptyRepo`, `TestOpenDetachedWorktreeLabel`, `TestOpenSkipsPrunableWorktree`, `TestOpenUnknownBaseFallsBack`, `TestOpenNotARepo`, `TestOpenUnrelatedHistoryHasNoCommittedOverlay` and `TestEngineDropsSlowSubscriber`, then `ok`.

- [ ] **Step 7: Commit**

```bash
git add internal/repo/compute.go internal/repo/engine.go internal/repo/engine_test.go
git commit -m "feat(repo): build base tree and worktree overlays into the model" \
  -m "Open resolves the repo, base and worktrees and computes committed (merge-base diff) and uncommitted (status + move pairing) overlays. Subscribe hands out 256-slot channels and drops subscribers that fall behind." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Write the failing recompute tests**

These call `e.fire` directly, with no watcher, so each recompute rule of spec §4 step 5 is tested deterministically.

`internal/repo/recompute_test.go`:

```go
package repo

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/model"
)

// openEngine opens path and subscribes; Run is NOT started, so tests drive
// recomputes deterministically by calling e.fire.
func openEngine(t *testing.T, path string) (*Engine, <-chan model.Patch) {
	t.Helper()
	e, err := Open(context.Background(), path, "", gitx.Runner{})
	if err != nil {
		t.Fatal(err)
	}
	ch, unsub := e.Subscribe()
	t.Cleanup(unsub)
	return e, ch
}

// nextPatch returns the patch published by the fire that just ran.
func nextPatch(t *testing.T, ch <-chan model.Patch) model.Patch {
	t.Helper()
	select {
	case p := <-ch:
		return p
	case <-time.After(time.Second):
		t.Fatal("no patch published")
		return model.Patch{}
	}
}

func noPatch(t *testing.T, ch <-chan model.Patch) {
	t.Helper()
	select {
	case p := <-ch:
		t.Fatalf("unexpected patch %+v", p)
	default:
	}
}

func findUpsert(p model.Patch, id model.WorktreeID, path string) (model.ChangeEntry, bool) {
	for _, c := range p.Overlays[id].Upsert {
		if c.Path == path {
			return c, true
		}
	}
	return model.ChangeEntry{}, false
}

func hasActivity(p model.Patch, kind string, id model.WorktreeID) bool {
	for _, a := range p.Activity {
		if a.Kind == kind && a.Worktree == id {
			return true
		}
	}
	return false
}

func TestFireFilesRecomputesStatus(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, ch := openEngine(t, r.Path())
	id := wtID(r.Path())

	e.fire(context.Background(), string(id), ReasonFiles)
	noPatch(t, ch) // nothing changed

	r.Write("notes.md", "hi\n")
	e.fire(context.Background(), string(id), ReasonFiles)
	c, ok := findUpsert(nextPatch(t, ch), id, "notes.md")
	if !ok || c.Stage != model.Uncommitted || c.Kind != model.Added || c.Size != 3 {
		t.Fatalf("notes.md = %+v (found %v)", c, ok)
	}
}

func TestFireRefMakesCommitAtomic(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	wt.Write("feature.txt", "hello\n")
	e, ch := openEngine(t, r.Path())
	id := wtID(wt.Path())

	wt.Add("feature.txt")
	sha := wt.Commit("add feature")
	e.fire(context.Background(), string(id), ReasonRef)
	p := nextPatch(t, ch)
	if c, ok := findUpsert(p, id, "feature.txt"); !ok || c.Stage != model.Committed {
		t.Fatalf("feature.txt = %+v (found %v), want committed in the same patch", c, ok)
	}
	if !hasActivity(p, "commit", id) {
		t.Fatalf("activity = %+v, want a commit item", p.Activity)
	}
	for _, w := range p.Worktrees {
		if w.ID == id && w.Head != sha {
			t.Errorf("head = %s, want %s", w.Head, sha)
		}
	}
}

func TestFireRefsBaseMovedMerges(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "feature"), "feature")
	wt.Write("feature.txt", "hello\n")
	wt.Add("feature.txt")
	wt.Commit("add feature")
	e, ch := openEngine(t, r.Path())
	id := wtID(wt.Path())

	r.Merge("feature")
	e.fire(context.Background(), keyRefs, ReasonRefs)
	p := nextPatch(t, ch)
	if p.Base == nil || len(p.Base.Upsert) != 1 || p.Base.Upsert[0].Path != "feature.txt" {
		t.Fatalf("base patch = %+v, want feature.txt upserted", p.Base)
	}
	if rm := p.Overlays[id].Remove; len(rm) != 1 || rm[0] != "feature.txt" {
		t.Fatalf("overlay remove = %v, want [feature.txt]", rm)
	}
	if !hasActivity(p, "merge", id) {
		t.Fatalf("activity = %+v, want a merge item", p.Activity)
	}
	if n := len(e.Snapshot().Overlays[wtID(r.Path())]); n != 0 {
		t.Errorf("main overlay has %d entries after a merge into base, want 0", n)
	}
}

func TestFireWorktreesAddedAndRemoved(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, ch := openEngine(t, r.Path())

	wt := r.WorktreeAdd(filepath.Join(t.TempDir(), "agent"), "agent")
	wt.Write("a.txt", "a")
	e.fire(context.Background(), keyWorktrees, ReasonWorktrees)
	p := nextPatch(t, ch)
	id := wtID(wt.Path())
	if len(p.Worktrees) != 2 || p.Worktrees[1].ID != id || p.Worktrees[1].Label != "agent" {
		t.Fatalf("worktrees = %+v, want main + agent", p.Worktrees)
	}
	if _, ok := findUpsert(p, id, "a.txt"); !ok {
		t.Fatalf("new worktree's overlay not published: %+v", p.Overlays)
	}
	if got := e.router.Load().Route(filepath.Join(canon(wt.Path()), "a.txt")); got != (Route{FileEvent, id}) {
		t.Fatalf("router not rebuilt: %+v", got)
	}

	r.WorktreeRemove(wt.Path())
	e.fire(context.Background(), keyWorktrees, ReasonWorktrees)
	p = nextPatch(t, ch)
	if len(p.Worktrees) != 1 || !p.Worktrees[0].IsMain {
		t.Fatalf("worktrees = %+v, want only main", p.Worktrees)
	}
	if rm := p.Overlays[id].Remove; len(rm) != 1 || rm[0] != "a.txt" {
		t.Fatalf("overlay remove = %v, want [a.txt]", rm)
	}
}

func TestFireKeepsLastGoodStateWhenGitFails(t *testing.T) {
	r := initRepo(t, map[string]string{"README.md": "# demo\n"})
	e, ch := openEngine(t, r.Path())
	before := e.Snapshot()
	e.r = gitx.Runner{Git: filepath.Join(t.TempDir(), "no-such-git")}
	r.Write("x.txt", "x")
	for _, key := range []string{string(wtID(r.Path())), keyRefs, keyWorktrees} {
		e.fire(context.Background(), key, ReasonFiles|ReasonRef|ReasonRefs|ReasonWorktrees)
	}
	noPatch(t, ch)
	if after := e.Snapshot(); after.Seq != before.Seq {
		t.Fatalf("seq moved from %d to %d on git failure", before.Seq, after.Seq)
	}
}
```

- [ ] **Step 9: Run them to verify they fail**

Run: `go test ./internal/repo/ 2>&1 | head -5`
Expected: build failure, `e.fire undefined (type *Engine has no field or method fire)` and `undefined: keyRefs`.

- [ ] **Step 10: Implement the recompute dispatcher**

`internal/repo/recompute.go`:

```go
package repo

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/olliejudge/orion/internal/model"
)

// Scheduler keys besides worktree IDs.
const (
	keyRefs      = "refs"
	keyWorktrees = "worktrees"
)

// fire recomputes the part of the state named by key (spec §4 step 5) and
// publishes the result. On a git error the error is logged and whatever was
// recomputed successfully is published; the rest keeps its last good value.
func (e *Engine) fire(ctx context.Context, key string, r Reason) {
	if ctx.Err() != nil {
		return
	}
	e.work.Lock()
	defer e.work.Unlock()
	var err error
	switch key {
	case keyRefs:
		err = e.recomputeRefs(ctx, r&ReasonRescan != 0)
	case keyWorktrees:
		err = e.syncWorktrees(ctx, false)
	default:
		id := model.WorktreeID(key)
		if r&ReasonRef != 0 {
			// HEAD or index moved: check base first so a commit on the base
			// branch is seen as "merged", not briefly as "committed on branch".
			err = e.recomputeRefs(ctx, false)
		}
		if err == nil {
			err = e.recomputeUncommitted(ctx, id)
		}
	}
	if err != nil && ctx.Err() == nil {
		log.Printf("orion: recompute %s: %v", key, err)
	}
	e.publish(e.state()) // under e.work, so publishes happen in recompute order
}

// recomputeRefs re-resolves base; if it moved (or full), rebuilds the base
// tree and every committed overlay, else only those whose HEAD moved.
func (e *Engine) recomputeRefs(ctx context.Context, full bool) error {
	ref, sha, err := e.lookupBase(ctx)
	if err != nil {
		return err
	}
	if sha == "" && e.baseSha != "" {
		// A repo that had commits cannot become empty: git failed. Keep the last good base.
		return fmt.Errorf("base %q no longer resolves", e.baseRef)
	}
	moved := full || sha != e.baseSha
	if moved {
		tree, err := baseTree(ctx, e.r, e.mainRoot, sha)
		if err != nil {
			return err
		}
		e.tree = tree
	}
	e.baseRef, e.baseSha = ref, sha
	return e.syncWorktrees(ctx, moved)
}

func (e *Engine) recomputeUncommitted(ctx context.Context, id model.WorktreeID) error {
	ws, ok := e.wts[id]
	if !ok {
		return nil
	}
	if _, err := os.Stat(ws.g.Path); err != nil {
		return e.syncWorktrees(ctx, false) // directory gone: git now reports it prunable
	}
	m, err := uncommittedOverlay(ctx, e.r, ws.g.Path)
	if err != nil {
		return err
	}
	ws.uncommitted = m
	return nil
}
```

- [ ] **Step 11: Run the package tests to verify they pass**

Run: `go test -race -count=1 -v ./internal/repo/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: `--- PASS` for all the Task 6 tests, the Step 6 tests, and `TestFireFilesRecomputesStatus`, `TestFireRefMakesCommitAtomic`, `TestFireRefsBaseMovedMerges`, `TestFireWorktreesAddedAndRemoved` and `TestFireKeepsLastGoodStateWhenGitFails`. Then `ok`.

- [ ] **Step 12: Lint and run the whole module's tests**

Run: `make lint && go test -race ./...`
Expected: `0 issues.` and every package `ok`.

- [ ] **Step 13: Commit**

```bash
git add internal/repo/recompute.go internal/repo/recompute_test.go
git commit -m "feat(repo): recompute only what an event affects" \
  -m "File events re-run status; ref events re-check base and the worktree's HEAD; refs events rebuild the base tree when base moved; worktree-set events rediscover worktrees. A moved HEAD refreshes status in the same pass so commits arrive as one patch. Git failures keep the last good state." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 14: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin feat/engine
gh pr create --base main --title "feat(repo): engine core — state computation and targeted recomputes" --body "$(cat <<'EOF'
Adds the core of `repo.Engine`, without the watcher loop, which comes in the next PR:

- `Open` builds the initial `model.State`: the base tree, and per-worktree committed overlays (a merge-base diff, with blob sizes) and uncommitted overlays (status plus plain-move pairing, with working-tree sizes). Prunable worktrees and orphan histories are handled, and an unknown `--base` falls back to HEAD (spec §8).
- `fire(key, reason)` implements spec §4 step 5 and is tested deterministically without a watcher. A commit arrives as one patch (uncommitted → committed with the new HEAD), and a merge into base removes the entries and upserts the base tree.
- `Subscribe` and `Snapshot` are gap-free, and a slow subscriber is dropped.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 8b: `repo` Engine Run loop + end-to-end engine tests

**Branch:** `feat/engine-run` · **Depends on:** Tasks 5, 8a

**Files:**
- Create: `internal/repo/run.go`
- Test: `internal/repo/run_test.go`

**Interfaces:**
- Consumes: `watch.New`, `watch.Watcher` and `watch.Event` (Task 5). Event paths are symlink-resolved; `Rescan` means "recompute everything"; `Add` may fail (for example the Linux inotify limit); `Close` closes both channels. Also everything Task 8a produced (`fire`, `rebuildRouting`, `watchRoots`, `ready`, `router`, `keyRefs`, `keyWorktrees`, `canon`, `initRepo` and `wtID`), plus `NewScheduler` and `waitFor` from Task 6.
- Produces: `func (e *Engine) Run(ctx context.Context) error` as in Shared Interfaces. It returns nil when `ctx` is done, and an error only if `watch.New` fails. Also `var newWatcher = watch.New`, which tests swap for a fake. Behaviour:
  - **Watches:** it watches the main root recursively (which covers `.git/` and nested worktrees), plus the common dir if it lies outside the main root, plus every linked worktree root outside the main root. Added and removed worktrees are watched and unwatched as the set changes. After that it closes `e.ready`, then triggers a rescan of everything to catch changes made between `Open` and `Run`.
  - **Scheduling:** events are routed with the current Router into the Scheduler (150 ms debounce, 250 ms minimum interval), keyed by worktree ID, `"refs"` or `"worktrees"`. `Rescan` triggers every worktree key and `"refs"` with `ReasonRescan`.
  - **Watcher failure** (spec §8): a failed `Add`, an `Errors()` item or a closed event stream is logged once. The worktree is then polled every 2 s. When the error is a `*fs.PathError`, only the worktree it routes to is polled; otherwise everything is polled (status and HEAD for each worktree, plus refs).
- Pinned tests: `TestEngineNestedWorktree` (Review Focus 1), `TestEngineWorktreeRemoved` (Review Focus 3) and `TestEngineCheckoutStorm` (Review Focus 4: ≤ 10 patches within 3 s of checking out a branch that differs by 300 files, ending equal to a freshly opened engine). `TestEngineUnstagedMove` exercises Review Focus 5 end to end.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-engine-run -b feat/engine-run main
cd .claude/worktrees/feat-engine-run
```

- [ ] **Step 2: Write the failing end-to-end engine tests**

These use the real platform watcher on synthetic repos, except the last four, which use `fakeWatcher` to force a rescan and watcher failures. Correctness never depends on a sleep: every assertion polls with `waitFor`. The only sleeps let the startup rescan settle, and set `TestEngineCheckoutStorm`'s 3 s measurement window.

`internal/repo/run_test.go`:

```go
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
	waitFor(t, 10*time.Second, func() bool { _, ok := snapEntry(e, mainID, "notes.md"); return ok })

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
		return !has
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
	events chan watch.Event
	errs   chan error
	addErr error // returned by every Add when set
	mu     sync.Mutex
	added  []string
}

func (f *fakeWatcher) Events() <-chan watch.Event { return f.events }
func (f *fakeWatcher) Errors() <-chan error       { return f.errs }
func (f *fakeWatcher) Remove(string) error        { return nil }
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

	got := fw.roots()
	want := []string{canon(r.Path()), canon(outside.Path())}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("watched roots = %v, want %v (nested worktree covered by main)", got, want)
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
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/repo/ 2>&1 | head -5`
Expected: build failure, `e.Run undefined (type *Engine has no field or method Run)` and `undefined: newWatcher`.

- [ ] **Step 4: Implement the run loop**

`internal/repo/run.go`:

```go
package repo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"sync"
	"time"

	"github.com/olliejudge/orion/internal/model"
	"github.com/olliejudge/orion/internal/watch"
)

const (
	debounce     = 150 * time.Millisecond // Global Constraints
	minInterval  = 250 * time.Millisecond // ≤ 4 recomputes/s per key
	pollInterval = 2 * time.Second        // spec §8 watcher-failure fallback
)

// newWatcher is swapped by tests that need a fake watcher.
var newWatcher = watch.New

// pollSet records which worktrees the watcher failed for (spec §8: log once,
// then poll their status every 2 s). all means the failure could not be
// pinned to one worktree, so everything is polled.
type pollSet struct {
	mu     sync.Mutex
	warned bool
	all    bool
	ids    map[model.WorktreeID]bool
}

func (p *pollSet) add(id model.WorktreeID, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.warned {
		log.Printf("orion: file watcher: %v; polling git status every %v instead", err, pollInterval)
		p.warned = true
	}
	if id == "" {
		p.all = true
		return
	}
	if p.ids == nil {
		p.ids = map[model.WorktreeID]bool{}
	}
	p.ids[id] = true
}

func (p *pollSet) targets() (bool, map[model.WorktreeID]bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	ids := make(map[model.WorktreeID]bool, len(p.ids))
	for id := range p.ids {
		ids[id] = true
	}
	return p.all, ids
}

// Run watches the repo and keeps the model live until ctx is done. Watcher
// failures never stop it: the affected worktrees are polled instead.
func (e *Engine) Run(ctx context.Context) error {
	w, err := newWatcher()
	if err != nil {
		return fmt.Errorf("start watcher: %w", err)
	}
	sched := NewScheduler(debounce, minInterval, func(key string, r Reason) { e.fire(ctx, key, r) })
	polls := &pollSet{}
	ticker := time.NewTicker(pollInterval)
	defer func() {
		ticker.Stop()
		sched.Close() // waits for in-flight recomputes, which may still call e.watchRoots
		e.work.Lock()
		e.watchRoots = nil
		e.work.Unlock()
		_ = w.Close()
	}()

	watched := map[string]bool{} // guarded by e.work, like every watchRoots call
	e.work.Lock()
	if err := w.Add(e.mainRoot); err != nil {
		polls.add("", fmt.Errorf("watch %s: %w", e.mainRoot, err))
	}
	if _, inside := under(e.commonDir, e.mainRoot); !inside {
		if err := w.Add(e.commonDir); err != nil {
			polls.add("", fmt.Errorf("watch %s: %w", e.commonDir, err))
		}
	}
	e.watchRoots = func(roots map[string]model.WorktreeID) {
		for root, id := range roots {
			if watched[root] {
				continue
			}
			if err := w.Add(root); err != nil {
				polls.add(id, fmt.Errorf("watch %s: %w", root, err))
				continue
			}
			watched[root] = true
		}
		for root := range watched {
			if _, ok := roots[root]; !ok {
				_ = w.Remove(root)
				delete(watched, root)
			}
		}
	}
	e.rebuildRouting() // watches linked worktrees outside the main root
	e.work.Unlock()
	close(e.ready)
	e.triggerAll(sched, ReasonRescan) // catch changes made between Open and now

	events, errs := w.Events(), w.Errors()
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-events:
			if !ok {
				events = nil
				polls.add("", errors.New("watcher event stream closed"))
				continue
			}
			e.dispatch(sched, ev)
		case err, ok := <-errs:
			if !ok {
				errs = nil
				continue
			}
			var id model.WorktreeID
			var pe *fs.PathError
			if errors.As(err, &pe) {
				id = e.router.Load().Route(pe.Path).Worktree
			}
			polls.add(id, err)
		case <-ticker.C:
			all, ids := polls.targets()
			for _, id := range e.router.Load().ids() {
				switch {
				case all:
					sched.Trigger(string(id), ReasonFiles|ReasonRef)
				case ids[id]:
					sched.Trigger(string(id), ReasonFiles)
				}
			}
			if all {
				sched.Trigger(keyRefs, ReasonRefs)
			}
		}
	}
}

func (e *Engine) dispatch(s *Scheduler, ev watch.Event) {
	if ev.Rescan {
		e.triggerAll(s, ReasonRescan)
		return
	}
	rt := e.router.Load().Route(ev.Path)
	switch rt.Class {
	case FileEvent:
		s.Trigger(string(rt.Worktree), ReasonFiles)
	case WorktreeRefEvent:
		s.Trigger(string(rt.Worktree), ReasonRef)
	case RefsEvent:
		s.Trigger(keyRefs, ReasonRefs)
	case WorktreesChanged:
		s.Trigger(keyWorktrees, ReasonWorktrees)
	}
}

func (e *Engine) triggerAll(s *Scheduler, r Reason) {
	for _, id := range e.router.Load().ids() {
		s.Trigger(string(id), r)
	}
	s.Trigger(keyRefs, r)
}
```

- [ ] **Step 5: Run the engine tests to verify they pass**

Run: `go test -race -count=1 -v -run 'TestEngine|TestRun' ./internal/repo/ 2>&1 | grep -E '^(--- |ok|FAIL)|patches:'`
Expected: `--- PASS` for `TestEngineLifecycle`, `TestEngineNestedWorktree`, `TestEngineWorktreeRemoved`, `TestEngineWorktreeDirDeleted`, `TestEngineCheckoutStorm` (its log line reports about 2 patches), `TestEngineUnstagedMove`, `TestEngineDropsSlowSubscriber`, `TestRunWatchesMainAndOutsideRoots`, `TestRunRescanEventRecomputesEverything`, `TestRunFallsBackToPollingOnWatcherError` and `TestRunPollsWhenAddFails`. Then `ok`, in about 15 s.

- [ ] **Step 6: Check stability**

Run: `go test -race -count=3 -run 'TestEngine|TestRun' ./internal/repo/`
Expected: `ok` (all three runs pass). If CI provides Linux, the same command must pass there too; it exercises the inotify watcher.

- [ ] **Step 7: Lint and run the whole module's tests**

Run: `make lint && go test -race ./...`
Expected: `0 issues.` and every package `ok`.

- [ ] **Step 8: Commit**

```bash
git add internal/repo/run.go internal/repo/run_test.go
git commit -m "feat(repo): drive recomputes from the filesystem watcher" \
  -m "Watches the main root plus linked worktrees outside it, routes events through the scheduler, rescans on overflow, and falls back to 2 s polling when the watcher fails. End-to-end tests cover the uncommitted → committed → merged lifecycle, nested worktrees, worktree removal, a 300-file checkout storm and plain mv." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin feat/engine-run
gh pr create --base main --title "feat(repo): live engine loop with watcher, scheduler and polling fallback" --body "$(cat <<'EOF'
Adds `Engine.Run`. It watches the main worktree root (which covers `.git` and nested worktrees) and every linked worktree outside it. Events are routed through the scheduler into targeted recomputes. Overflow triggers a full rescan, and a watcher failure falls back to 2 s polling (spec §8).

End-to-end tests on synthetic repos:
- Uncommitted → committed (with a commit activity) → merged into base (the entries are removed, and the base tree gains the file, with a merge activity).
- A nested `.claude/worktrees/*` worktree never leaks into the main overlay (pinned).
- A worktree that is removed, or whose directory is deleted, disappears from the legend (pinned).
- A 300-file checkout stays at 10 patches or fewer and ends equal to a fresh snapshot (pinned).
- A plain `mv` shows up as a rename.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 8c: CLI wiring + WebSocket integration test

**Branch:** `feat/cli-wiring` · **Depends on:** Tasks 7, 8b

**Files:**
- Modify (replace entirely): `cmd/orion/main.go`, the Task 1 stub
- Modify (replace entirely): `cmd/orion/main_test.go`. Task 1's `TestRunVersion` and `TestRunUnknownFlag` are kept unchanged.

**Interfaces:**
- Consumes: `repo.Open`, `(*Engine).Run` and `(*Engine).Snapshot` (Tasks 8a and 8b); `server.Start`, `server.Options`, `(*Server).Wait` and `server.VitePort` (Task 7); `webassets.FS()` (Task 1; it always contains `index.html`); `version.Version` (Task 1); and `testrepo` (Task 2).
- Produces:
  - The CLI of spec §7: `orion [path] [--port 7070] [--no-open] [--base BRANCH] [--dev] [--version]`. Flags may come before or after the path.
  - It keeps Task 1's `func run(args []string, stdout, stderr io.Writer) int`, with `main` calling `os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))`.
  - Exit codes: 0 on success and on Ctrl-C/SIGTERM (after a graceful shutdown in which clients get a close frame); 1 with a one-line `orion: …` error on stderr (not a repo, git missing or too old, bind failure); 2 for usage errors.
  - Output: stdout gets `orion <version> serving <repo>`, then an indented `http://127.0.0.1:PORT/?t=TOKEN` line. This is the first match of `http://127\.0\.0\.1:\d+/\?t=\S+`, which Task 14 parses. With `--dev`, a later line `  dev UI (Vite): http://localhost:5173/?t=TOKEN` follows. The browser opens with `open` (darwin) or `xdg-open` (linux) unless `--no-open` or `--dev` is set.
  - Requests without the token get 403. SIGINT and SIGTERM exit 0 after a graceful shutdown (pinned by `TestRunExitsZeroOnSIGINT`, which sends a real SIGINT to the test process).
  - Package-internal `var baseContext = context.Background`: the parent of the signal context, which tests replace with a cancellable one.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-cli-wiring -b feat/cli-wiring main
cd .claude/worktrees/feat-cli-wiring
```

- [ ] **Step 2: Replace the CLI tests with the failing full set**

`TestRunEndToEnd` is the spec §9 integration test. It runs orion in-process on a synthetic repo with a nested linked worktree, checks that a request without the token is refused, performs the browser's token → cookie flow, connects a real WebSocket, writes a file in the nested worktree, and waits for the matching uncommitted patch.

`cmd/orion/main_test.go`:

```go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/olliejudge/orion/internal/model"
	"github.com/olliejudge/orion/internal/server"
	"github.com/olliejudge/orion/internal/testrepo"
	"github.com/olliejudge/orion/internal/version"
)

// syncBuffer is a bytes.Buffer safe for concurrent Write and String.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestRunVersion(t *testing.T) {
	for _, arg := range []string{"--version", "-version"} {
		var stdout, stderr bytes.Buffer
		code := run([]string{arg}, &stdout, &stderr)
		if code != 0 {
			t.Fatalf("run(%q) exit code = %d, want 0 (stderr: %q)", arg, code, stderr.String())
		}
		want := "orion " + version.Version + "\n"
		if stdout.String() != want {
			t.Fatalf("run(%q) stdout = %q, want %q", arg, stdout.String(), want)
		}
	}
}

func TestRunUnknownFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--nope"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "nope") {
		t.Fatalf("stderr %q does not mention the bad flag", stderr.String())
	}
}

func TestRunTwoPathsIsUsageError(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := run([]string{"a", "b"}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
}

func TestRunNotARepo(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"--no-open", "--port", "0", t.TempDir()}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	msg := stderr.String()
	if !strings.HasPrefix(msg, "orion: ") || strings.Count(msg, "\n") != 1 {
		t.Fatalf("stderr = %q, want one line starting with \"orion: \"", msg)
	}
}

var urlRe = regexp.MustCompile(`http://127\.0\.0\.1:\d+/\?t=[0-9a-f]{64}`)

// testRepo is a synthetic repo with one commit and a nested linked worktree.
func testRepo(t *testing.T) (*testrepo.Repo, *testrepo.Repo) {
	t.Helper()
	r := testrepo.New(t)
	r.Write("README.md", "# demo\n")
	r.Add("README.md")
	r.Commit("init")
	agent := r.WorktreeAdd(".claude/worktrees/agent-a", "agent-a")
	return r, agent
}

// running is an in-process `orion` started by startRun.
type running struct {
	out, errOut *syncBuffer
	url         string // the first http://127.0.0.1:PORT/?t=TOKEN on stdout
	exit        chan int
	cancel      context.CancelFunc // plays Ctrl-C
}

// startRun runs the CLI with args in the background, waits for its URL and
// cancels it (asserting exit code 0) when the test ends.
func startRun(t *testing.T, args ...string) *running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	orig := baseContext
	baseContext = func() context.Context { return ctx }
	rn := &running{out: &syncBuffer{}, errOut: &syncBuffer{}, exit: make(chan int, 1), cancel: cancel}
	go func() { rn.exit <- run(args, rn.out, rn.errOut) }()
	t.Cleanup(func() {
		cancel()
		select {
		case code := <-rn.exit:
			if code != 0 {
				t.Errorf("exit %d, stderr %q", code, rn.errOut.String())
			}
		case <-time.After(10 * time.Second):
			t.Error("run did not return after cancel")
		}
		baseContext = orig
	})
	deadline := time.Now().Add(10 * time.Second)
	for rn.url = urlRe.FindString(rn.out.String()); rn.url == ""; rn.url = urlRe.FindString(rn.out.String()) {
		if time.Now().After(deadline) {
			t.Fatalf("no URL printed; stdout %q stderr %q", rn.out.String(), rn.errOut.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	return rn
}

// TestRunEndToEnd is the spec §9 integration test: orion in-process on a
// synthetic repo with a nested linked worktree, driven over a real WebSocket.
func TestRunEndToEnd(t *testing.T) {
	r, agent := testRepo(t)
	rn := startRun(t, r.Path(), "--no-open", "--port", "0") // flags after the path work too
	u, err := url.Parse(rn.url)
	if err != nil {
		t.Fatal(err)
	}

	// No token → refused.
	resp, err := http.Get("http://" + u.Host + "/")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("GET / without token: %d, want 403", resp.StatusCode)
	}

	// The browser flow: ?t= → cookie → page.
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	resp, err = client.Get(rn.url)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || resp.Request.URL.RawQuery != "" {
		t.Fatalf("GET %s: %d at %s, want 200 at /", rn.url, resp.StatusCode, resp.Request.URL)
	}

	hdr := http.Header{"Origin": {"http://" + u.Host}}
	for _, c := range jar.Cookies(&url.URL{Scheme: "http", Host: u.Host, Path: "/"}) {
		hdr.Add("Cookie", c.Name+"="+c.Value)
	}
	dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dcancel()
	conn, _, err := websocket.Dial(dctx, "ws://"+u.Host+"/ws", &websocket.DialOptions{HTTPHeader: hdr}) //nolint:bodyclose // coder/websocket owns resp.Body ("You never need to close resp.Body yourself")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.CloseNow() }()

	var snap model.Snapshot
	readJSON(t, conn, &snap)
	if snap.Type != "snapshot" || len(snap.Worktrees) != 2 {
		t.Fatalf("first message: %+v", snap)
	}
	agentID := model.IDFor(agent.Path())

	agent.Write("plan.md", "step 1\n")
	for {
		var p model.Patch
		readJSON(t, conn, &p)
		if p.Type != "patch" {
			continue
		}
		for _, c := range p.Overlays[agentID].Upsert {
			if c.Path == "plan.md" && c.Stage == model.Uncommitted {
				return
			}
		}
	}
}

func TestRunDevPrintsViteURLAfterServerURL(t *testing.T) {
	r, _ := testRepo(t)
	rn := startRun(t, "--dev", "--no-open", "--port", "0", r.Path())
	u, err := url.Parse(rn.url)
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("http://localhost:%d/?t=%s", server.VitePort, u.Query().Get("t"))
	waitUntil(t, func() bool {
		out := rn.out.String()
		i, j := strings.Index(out, rn.url), strings.Index(out, want)
		return i >= 0 && j > i // Task 14 parses the first 127.0.0.1 URL; Vite's comes later
	})
}

func TestRunExitsZeroOnSIGINT(t *testing.T) {
	r, _ := testRepo(t)
	out, errOut := &syncBuffer{}, &syncBuffer{}
	exit := make(chan int, 1)
	go func() { exit <- run([]string{"--no-open", "--port", "0", r.Path()}, out, errOut) }()
	waitUntil(t, func() bool { return urlRe.MatchString(out.String()) })
	if err := syscall.Kill(os.Getpid(), syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-exit:
		if code != 0 {
			t.Fatalf("exit %d after SIGINT, want 0 (stderr %q)", code, errOut.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run did not exit after SIGINT")
	}
}

// waitUntil polls cond every 10 ms for up to 10 s.
func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within 10s")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readJSON(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatal(err)
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./cmd/orion/ 2>&1 | head -5`
Expected: build failure, `undefined: baseContext`.

- [ ] **Step 4: Replace the CLI**

`cmd/orion/main.go`:

```go
// Command orion serves a live, animated map of a git repository.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"github.com/olliejudge/orion/internal/gitx"
	"github.com/olliejudge/orion/internal/repo"
	"github.com/olliejudge/orion/internal/server"
	"github.com/olliejudge/orion/internal/version"
	"github.com/olliejudge/orion/internal/webassets"
)

// baseContext is the parent of run's signal context; tests replace it with a
// cancellable one to stand in for Ctrl-C.
var baseContext = context.Background

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses args and executes the CLI, returning the process exit code:
// 0 ok (including Ctrl-C), 1 runtime error, 2 usage error.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("orion", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: orion [path] [--port N] [--no-open] [--base BRANCH] [--dev] [--version]")
		fs.PrintDefaults()
	}
	port := fs.Int("port", 7070, "port to listen on (the next free port is used if taken)")
	noOpen := fs.Bool("no-open", false, "do not open the browser")
	base := fs.String("base", "", "branch to compare against (default: origin/HEAD, main, master, current)")
	dev := fs.Bool("dev", false, "serve only /ws; the UI comes from the Vite dev server")
	showVersion := fs.Bool("version", false, "print the version and exit")

	// Go's flag package stops at the first positional argument; keep parsing
	// so `orion . --port 8080` works as well as `orion --port 8080 .`.
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return 0
			}
			return 2
		}
		if fs.NArg() == 0 {
			break
		}
		positional = append(positional, fs.Arg(0))
		args = fs.Args()[1:]
	}
	if *showVersion {
		fmt.Fprintf(stdout, "orion %s\n", version.Version)
		return 0
	}
	if len(positional) > 1 {
		fs.Usage()
		return 2
	}
	path := "."
	if len(positional) == 1 {
		path = positional[0]
	}

	ctx, stop := signal.NotifyContext(baseContext(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	eng, err := repo.Open(ctx, path, *base, gitx.Runner{})
	if err != nil {
		fmt.Fprintln(stderr, "orion:", firstLine(err))
		return 1
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	srv, err := server.Start(ctx, eng, server.Options{Port: *port, Dev: *dev, Assets: webassets.FS()})
	if err != nil {
		fmt.Fprintln(stderr, "orion:", firstLine(err))
		return 1
	}
	fmt.Fprintf(stdout, "orion %s serving %s\n  %s\n", version.Version, eng.Snapshot().Repo.Name, srv.URL)
	if *dev {
		u, err := url.Parse(srv.URL)
		if err != nil {
			fmt.Fprintln(stderr, "orion:", err)
			return 1
		}
		fmt.Fprintf(stdout, "  dev UI (Vite): http://localhost:%d/?t=%s\n", server.VitePort, u.Query().Get("t"))
	}
	if !*noOpen && !*dev {
		if err := openBrowser(srv.URL); err != nil {
			fmt.Fprintln(stderr, "orion: could not open a browser:", err)
		}
	}

	runErr := make(chan error, 1)
	go func() { runErr <- eng.Run(ctx) }()
	var engErr error
	select {
	case <-ctx.Done(): // Ctrl-C / SIGTERM
		engErr = <-runErr
	case engErr = <-runErr: // the engine failed on its own
		cancel()
	}
	srvErr := srv.Wait() // every client has been sent a close frame
	for _, err := range []error{engErr, srvErr} {
		if err != nil {
			fmt.Fprintln(stderr, "orion:", firstLine(err))
			return 1
		}
	}
	return 0
}

func firstLine(err error) string {
	s, _, _ := strings.Cut(err.Error(), "\n")
	return s
}

// openBrowser opens url with the platform's opener, without waiting for it.
func openBrowser(url string) error {
	var name string
	switch runtime.GOOS {
	case "darwin":
		name = "open"
	case "linux":
		name = "xdg-open"
	default:
		return fmt.Errorf("unsupported platform %s", runtime.GOOS)
	}
	cmd := exec.Command(name, url)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
```

- [ ] **Step 5: Run the CLI tests to verify they pass**

Run: `go test -race -count=1 -v ./cmd/orion/ 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected: `--- PASS` for `TestRunVersion`, `TestRunUnknownFlag`, `TestRunTwoPathsIsUsageError`, `TestRunNotARepo`, `TestRunEndToEnd`, `TestRunDevPrintsViteURLAfterServerURL` and `TestRunExitsZeroOnSIGINT`, then `ok`.

- [ ] **Step 6: Smoke-test the binary by hand**

Run:
```bash
go build -o /tmp/orion-smoke ./cmd/orion && /tmp/orion-smoke --no-open --port 0 . &
sleep 2; kill -INT %1; wait %1; echo "exit=$?"
```
Expected: a line `orion dev serving <dir>`, then `  http://127.0.0.1:<port>/?t=<64 hex>`, then `exit=0` after the interrupt. Also check that `/tmp/orion-smoke /` prints one `orion: not a git repository: …` line and exits 1. (`sleep` here only paces a manual check; it is not a test.)

- [ ] **Step 7: Lint and run the whole module's tests**

Run: `make lint && go test -race ./...`
Expected: `0 issues.` and every package `ok`.

- [ ] **Step 8: Commit**

```bash
git add cmd/orion/main.go cmd/orion/main_test.go
git commit -m "feat: wire engine and server into the orion CLI" \
  -m "orion [path] [--port N] [--no-open] [--base BRANCH] [--dev] [--version]: opens the repo, serves on 127.0.0.1 with port fallback, prints the tokenised URL (plus the Vite URL in --dev), opens the browser, and shuts down gracefully with exit 0 on Ctrl-C. Adds the in-process WebSocket integration test from spec §9." \
  -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin feat/cli-wiring
gh pr create --base main --title "feat: orion CLI serves the live map" --body "$(cat <<'EOF'
Replaces the CLI stub with the real `orion [path] [--port N] [--no-open] [--base BRANCH] [--dev] [--version]` (spec §7):

- It opens the repo engine and starts the server (127.0.0.1, with next-free-port fallback), prints the tokenised URL and opens the browser (`open` or `xdg-open`, with no new dependency).
- On Ctrl-C or SIGTERM it stops the watchers, sends clients a `going away` close frame and exits 0. Setup errors are one line on stderr with exit code 1.
- With `--dev`, it also prints the Vite URL (`http://localhost:5173/?t=…`) after the server URL.
- The spec §9 integration test drives a real WebSocket against a synthetic repo with a nested worktree.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---


---

### Task 9: Web scaffold, protocol, store, connection

**Branch:** `feat/web-scaffold` · **Depends on:** Task 1

This task creates the `web/` project and the state core that every later frontend task builds on. The whole toolchain is pinned here, including the dependencies used by Tasks 10–12 (Pixi, d3-hierarchy, Testing Library), so the lockfile is created once and later tasks never touch `package.json`.

**Files:**
- Create: `web/package.json`, `web/pnpm-lock.yaml` (generated by `pnpm install`), `web/.gitignore`, `web/tsconfig.json`, `web/svelte.config.js`, `web/vite.config.ts`, `web/eslint.config.js`, `web/index.html`
- Create: `web/src/test-setup.ts`, `web/src/protocol.ts`, `web/src/store.ts`, `web/src/connection.ts`, `web/src/main.ts`, `web/src/ui/App.svelte` (placeholder; Task 11 replaces it)
- Test: `web/src/store.test.ts`, `web/src/connection.test.ts`

**Interfaces:**
- Consumes: the wire JSON from Shared Interfaces (`internal/model` JSON tags). The Go server's `/ws` endpoint (Task 7) sends a `Snapshot` first and then `Patch`es, and accepts `{"type":"resync"}`.
- Produces (exact names; later tasks import these):
  - `protocol.ts`: every type in Shared Interfaces, plus `interface ResyncRequest { type: "resync" }`.
  - `store.ts`: `RepoState`, `Change`, `class RepoStore { get state(): RepoState | null; apply(msg: ServerMessage): { ok: true } | { ok: false; needsResync: true }; subscribe(fn: (s: RepoState, c: Change) => void): () => void }`, `const ACTIVITY_LIMIT = 200`. Each successful `apply` produces a **new** `RepoState` object (copy-on-write), so identity changes on every update.
  - `connection.ts`: `type ConnectionStatus = "connecting" | "open" | "reconnecting"`, `connect(store, opts?)`, `wsUrlFromLocation(loc: Pick<Location, "protocol" | "host" | "search">): string`, `backoffMs(attempt: number): number`.
  - npm scripts used by CI (Task 1): `lint`, `test` (non-watch), `build`.

**Design notes (read before coding):**
- **Vite output and `.gitkeep`.** `build.outDir` is `../internal/webassets/static` with `emptyOutDir: true`, which deletes the committed `.gitkeep`. The tiny `orion-keep-gitkeep` plugin in `vite.config.ts` writes `.gitkeep` back in `closeBundle`, so a build never shows up as a deletion in `git status`.
- **Dev proxy.** `pnpm -C web dev` serves on `:5173` and proxies `/ws` to `ws://127.0.0.1:7070` (Go started with `--dev`). `connect()` forwards the page's `?t=` token onto the WebSocket URL, so opening `http://localhost:5173/?t=<token>` authenticates even without the cookie.
- **Store merge rule (`Change.merged`).** A path is reported as merged when all of these hold:
  - an overlay entry for it was removed in this patch;
  - no overlay still has it;
  - base has it after the patch;
  - the removed entry was `committed`, **or** this same patch's `base` upserted or removed that path.

  The last condition stops a reverted uncommitted edit (overlay entry gone, base unchanged) from playing the merge shimmer. A worktree that disappears from `worktrees` takes its overlay with it, and those removals are not merge candidates.
- **Resync.** A patch whose `seq` is not `state.seq + 1` (or any patch before a snapshot) returns `{ ok: false, needsResync: true }` and leaves state untouched. `connect()` then sends exactly one `{"type":"resync"}` and sends no more until a snapshot arrives.
- **Version pins (verified together on 2026-09-23 with Node 24 / pnpm 12.4.2).**
  - TypeScript is pinned to **6.0.3**, not 7.x, because `typescript-eslint@8.70.1` (`<6.1.0`) and `svelte-check@4.7.6` (`^5 || ^6`) do not accept TS 7 yet.
  - `@sveltejs/vite-plugin-svelte` is pinned to 7.3.0, because 7.3.1 was published the same day and pnpm 12's minimum-release-age policy would add a `pnpm-workspace.yaml` exclusion for it.
  - `"packageManager": "pnpm@12.4.2"` matches CI's `pnpm/action-setup` `version: 12`.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-web-scaffold -b feat/web-scaffold main
cd .claude/worktrees/feat-web-scaffold
```

All later commands in this task run from the worktree root.

- [ ] **Step 2: Write the project configuration**

`web/package.json`:

```json
{
  "name": "orion-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "packageManager": "pnpm@12.4.2",
  "engines": {
    "node": ">=22.12.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . && svelte-check --tsconfig ./tsconfig.json --fail-on-warnings"
  },
  "dependencies": {
    "d3-hierarchy": "3.1.2",
    "pixi.js": "8.21.0"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@sveltejs/vite-plugin-svelte": "7.3.0",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/svelte": "5.4.2",
    "@testing-library/user-event": "14.6.7",
    "@tsconfig/svelte": "5.0.8",
    "@types/d3-hierarchy": "3.1.7",
    "@types/node": "24.13.6",
    "eslint": "10.11.0",
    "eslint-plugin-svelte": "3.23.0",
    "globals": "17.12.0",
    "jsdom": "30.1.1",
    "svelte": "5.57.1",
    "svelte-check": "4.7.6",
    "typescript": "6.0.3",
    "typescript-eslint": "8.70.1",
    "vite": "8.3.0",
    "vitest": "5.0.1"
  }
}
```

`web/.gitignore`:

```gitignore
node_modules/
test-results/
playwright-report/
```

`web/tsconfig.json`:

```json
{
  "extends": "@tsconfig/svelte/tsconfig.json",
  "compilerOptions": {
    "target": "es2022",
    "lib": ["es2022", "dom", "dom.iterable"],
    "types": ["vite/client", "node"],
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "allowJs": true,
    "checkJs": true
  },
  "include": ["src/**/*.ts", "src/**/*.svelte", "vite.config.ts", "svelte.config.js", "eslint.config.js"]
}
```

`web/svelte.config.js`:

```js
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
};
```

`web/vite.config.ts`. Vitest is configured here too: it uses jsdom, includes only `src/**/*.test.ts` (so Task 14's `web/e2e/**` is never collected), and loads the Testing Library plugin for Svelte component tests:

```ts
/// <reference types="vitest/config" />
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig, type Plugin } from "vite";

const outDir = resolve(import.meta.dirname, "../internal/webassets/static");

// emptyOutDir wipes static/ before every build, including the committed
// .gitkeep. This plugin writes it back once the bundle is on disk, so a
// build never shows up as a deleted file in `git status`.
function keepGitkeep(): Plugin {
  return {
    name: "orion-keep-gitkeep",
    apply: "build",
    closeBundle() {
      writeFileSync(resolve(outDir, ".gitkeep"), "");
    },
  };
}

export default defineConfig({
  plugins: [svelte(), svelteTesting(), keepGitkeep()],
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      "/ws": { target: "ws://127.0.0.1:7070", ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
```

`web/eslint.config.js` (flat config):

```js
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

export default defineConfig(
  { ignores: ["node_modules/", "dist/", "test-results/", "playwright-report/"] },
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
```

`web/index.html`. `data-theme="vision"` is the default theme and Task 12 switches it; the empty favicon avoids a 404 in the console, which the Task 14 smoke test watches:

```html
<!doctype html>
<html lang="en" data-theme="vision">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <link rel="icon" href="data:," />
    <title>Orion</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`web/src/test-setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Install and create the lockfile**

Run: `pnpm -C web install`
Expected: ends with `Done in …s using pnpm v12.4.2`, and `web/pnpm-lock.yaml` exists. No `web/pnpm-workspace.yaml` is created. If one appears, a pin is newer than pnpm's minimum release age: delete it and re-check the versions above.

- [ ] **Step 4: Write the protocol types**

`web/src/protocol.ts` (types only; it is checked by `svelte-check` in `pnpm lint`):

```ts
// Mirrors the Go `internal/model` wire types exactly (spec §5).
// Field names and optionality must match the JSON tags in internal/model/types.go.

export type WorktreeId = string;
export type Kind = "added" | "modified" | "deleted" | "renamed";
export type Stage = "uncommitted" | "committed";

export interface ChangeEntry {
  path: string;
  kind: Kind;
  from?: string;
  stage: Stage;
  size: number;
}

export interface FileEntry {
  path: string;
  size: number;
}

export interface Worktree {
  id: WorktreeId;
  path: string;
  label: string;
  branch?: string;
  head: string;
  isMain: boolean;
  locked: boolean;
  colorIndex: number;
}

export interface RepoInfo {
  name: string;
  base: string;
  baseSha: string;
}

export interface Activity {
  ts: number;
  worktree: WorktreeId;
  kind: Kind | "commit" | "merge";
  path?: string;
  from?: string;
  sha?: string;
  subject?: string;
  files?: number;
}

export interface Snapshot {
  type: "snapshot";
  seq: number;
  repo: RepoInfo;
  worktrees: Worktree[];
  tree: FileEntry[];
  overlays: Record<WorktreeId, ChangeEntry[]>;
  activity: Activity[];
}

export interface Patch {
  type: "patch";
  seq: number;
  worktrees?: Worktree[];
  base?: { sha: string; upsert: FileEntry[]; remove: string[] };
  overlays?: Record<WorktreeId, { upsert: ChangeEntry[]; remove: string[] }>;
  activity?: Activity[];
}

export type ServerMessage = Snapshot | Patch;

/** The only client → server message (spec §5). */
export interface ResyncRequest {
  type: "resync";
}
```

- [ ] **Step 5: Write the failing store test**

`web/src/store.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Activity, Patch, Snapshot } from "./protocol";
import { RepoStore, type Change, type RepoState } from "./store";

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    type: "snapshot",
    seq: 5,
    repo: { name: "sample-app", base: "origin/main", baseSha: "b1" },
    worktrees: [
      { id: "w0", path: "/r", label: "main", branch: "main", head: "h0", isMain: true, locked: false, colorIndex: 0 },
      { id: "w1", path: "/r/.claude/worktrees/a", label: "feat/a", branch: "feat/a", head: "h1", isMain: false, locked: false, colorIndex: 1 },
    ],
    tree: [
      { path: "README.md", size: 120 },
      { path: "src/app.ts", size: 900 },
    ],
    overlays: {
      w1: [
        { path: "src/app.ts", kind: "modified", stage: "committed", size: 950 },
        { path: "src/new.ts", kind: "added", stage: "uncommitted", size: 40 },
      ],
    },
    activity: [],
    ...over,
  };
}

function patch(seq: number, over: Partial<Patch> = {}): Patch {
  return { type: "patch", seq, ...over };
}

function act(ts: number): Activity {
  return { ts, worktree: "w1", kind: "modified", path: `f${ts}.ts` };
}

describe("RepoStore", () => {
  it("starts empty", () => {
    expect(new RepoStore().state).toBeNull();
  });

  it("replaces all state on snapshot", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    const res = store.apply(snapshot({ seq: 9, tree: [{ path: "only.txt", size: 1 }], overlays: {} }));
    expect(res).toEqual({ ok: true });
    const s = store.state!;
    expect(s.seq).toBe(9);
    expect([...s.tree.keys()]).toEqual(["only.txt"]);
    expect(s.overlays.size).toBe(0);
    expect(s.worktrees.get("w1")?.label).toBe("feat/a");
  });

  it("rejects a patch before any snapshot", () => {
    expect(new RepoStore().apply(patch(1))).toEqual({ ok: false, needsResync: true });
  });

  it("rejects a patch with a seq gap and leaves state untouched", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    const before = store.state;
    const fn = vi.fn();
    store.subscribe(fn);
    expect(store.apply(patch(7, { base: { sha: "b2", upsert: [], remove: ["README.md"] } }))).toEqual({
      ok: false,
      needsResync: true,
    });
    expect(store.apply(patch(5))).toEqual({ ok: false, needsResync: true });
    expect(store.state).toBe(before);
    expect(store.state!.tree.has("README.md")).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it("applies base and overlay upserts/removes without mutating the previous state", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    const before = store.state!;
    store.apply(
      patch(6, {
        base: { sha: "b2", upsert: [{ path: "docs/guide.md", size: 10 }], remove: ["README.md"] },
        overlays: { w1: { upsert: [{ path: "src/x.ts", kind: "added", stage: "uncommitted", size: 3 }], remove: ["src/new.ts"] } },
      }),
    );
    const s = store.state!;
    expect(s.seq).toBe(6);
    expect(s.repo.baseSha).toBe("b2");
    expect(s.tree.has("README.md")).toBe(false);
    expect(s.tree.get("docs/guide.md")).toBe(10);
    expect([...s.overlays.get("w1")!.keys()].sort()).toEqual(["src/app.ts", "src/x.ts"]);
    expect(before.tree.has("README.md")).toBe(true);
    expect(before.overlays.get("w1")!.has("src/new.ts")).toBe(true);
  });

  it("drops a worktree's overlay map when it becomes empty", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    store.apply(patch(6, { overlays: { w1: { upsert: [], remove: ["src/app.ts", "src/new.ts"] } } }));
    expect(store.state!.overlays.has("w1")).toBe(false);
  });

  it("replaces the worktree list and drops overlays of vanished worktrees", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    store.apply(patch(6, { worktrees: [snapshot().worktrees[0]!] }));
    expect([...store.state!.worktrees.keys()]).toEqual(["w0"]);
    expect(store.state!.overlays.has("w1")).toBe(false);
  });

  it("keeps activity newest-last and capped at 200", () => {
    const store = new RepoStore();
    store.apply(snapshot({ activity: Array.from({ length: 150 }, (_, i) => act(i)) }));
    store.apply(patch(6, { activity: Array.from({ length: 100 }, (_, i) => act(150 + i)) }));
    const a = store.state!.activity;
    expect(a).toHaveLength(200);
    expect(a[0]!.ts).toBe(50);
    expect(a[199]!.ts).toBe(249);
  });

  it("caps snapshot activity at 200", () => {
    const store = new RepoStore();
    store.apply(snapshot({ activity: Array.from({ length: 250 }, (_, i) => act(i)) }));
    expect(store.state!.activity).toHaveLength(200);
    expect(store.state!.activity[0]!.ts).toBe(50);
  });

  describe("merged", () => {
    function lastChange(store: RepoStore): () => Change {
      let c: Change | null = null;
      store.subscribe((_s: RepoState, change: Change) => {
        c = change;
      });
      return () => c!;
    }

    it("reports a committed entry that left every overlay while base kept the path", () => {
      const store = new RepoStore();
      store.apply(snapshot());
      const last = lastChange(store);
      store.apply(
        patch(6, {
          base: { sha: "b2", upsert: [{ path: "src/app.ts", size: 950 }], remove: [] },
          overlays: { w1: { upsert: [], remove: ["src/app.ts"] } },
        }),
      );
      expect(last()).toMatchObject({ kind: "patch", merged: ["src/app.ts"] });
    });

    it("reports an uncommitted entry that left the overlay when base changed that path in the same patch", () => {
      const store = new RepoStore();
      store.apply(snapshot());
      const last = lastChange(store);
      store.apply(
        patch(6, {
          base: { sha: "b2", upsert: [{ path: "src/new.ts", size: 40 }], remove: [] },
          overlays: { w1: { upsert: [], remove: ["src/new.ts"] } },
        }),
      );
      expect(last().merged).toEqual(["src/new.ts"]);
    });

    it("does not report a reverted uncommitted edit (base unchanged)", () => {
      const store = new RepoStore();
      store.apply(
        snapshot({ overlays: { w1: [{ path: "README.md", kind: "modified", stage: "uncommitted", size: 130 }] } }),
      );
      const last = lastChange(store);
      store.apply(patch(6, { overlays: { w1: { upsert: [], remove: ["README.md"] } } }));
      expect(last().merged).toEqual([]);
    });

    it("does not report a path another worktree still touches", () => {
      const store = new RepoStore();
      store.apply(
        snapshot({
          overlays: {
            w0: [{ path: "src/app.ts", kind: "modified", stage: "uncommitted", size: 1 }],
            w1: [{ path: "src/app.ts", kind: "modified", stage: "committed", size: 2 }],
          },
        }),
      );
      const last = lastChange(store);
      store.apply(patch(6, { overlays: { w1: { upsert: [], remove: ["src/app.ts"] } } }));
      expect(last().merged).toEqual([]);
    });

    it("does not report a path that is gone from base (a merged deletion)", () => {
      const store = new RepoStore();
      store.apply(snapshot({ overlays: { w1: [{ path: "README.md", kind: "deleted", stage: "committed", size: 0 }] } }));
      const last = lastChange(store);
      store.apply(
        patch(6, {
          base: { sha: "b2", upsert: [], remove: ["README.md"] },
          overlays: { w1: { upsert: [], remove: ["README.md"] } },
        }),
      );
      expect(last().merged).toEqual([]);
    });

    it("is empty for snapshots", () => {
      const store = new RepoStore();
      const last = lastChange(store);
      store.apply(snapshot());
      expect(last()).toEqual({ kind: "snapshot", merged: [] });
    });
  });

  it("notifies subscribers until they unsubscribe", () => {
    const store = new RepoStore();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.apply(snapshot());
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toBe(store.state);
    off();
    store.apply(patch(6));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/store.test.ts`
Expected: FAIL with `Error: Failed to resolve import "./store" from "src/store.test.ts". Does the file exist?`

- [ ] **Step 7: Implement the store**

`web/src/store.ts`:

```ts
import type { Activity, ChangeEntry, Patch, RepoInfo, ServerMessage, Snapshot, Worktree, WorktreeId } from "./protocol";

export const ACTIVITY_LIMIT = 200;

export interface RepoState {
  repo: RepoInfo;
  seq: number;
  worktrees: Map<WorktreeId, Worktree>;
  tree: Map<string, number>;
  overlays: Map<WorktreeId, Map<string, ChangeEntry>>;
  activity: Activity[]; // newest LAST, ≤200
}

export interface Change {
  kind: "snapshot" | "patch";
  patch?: Patch;
  merged: string[]; // paths that left all overlays and are now in base
}

type Listener = (s: RepoState, c: Change) => void;

/**
 * Holds the client's copy of the repo state. Every successful apply builds a
 * NEW RepoState object (copy-on-write for the maps a patch touches), so
 * consumers can compare by identity and a rejected patch leaves state intact.
 */
export class RepoStore {
  #state: RepoState | null = null;
  #listeners = new Set<Listener>();

  get state(): RepoState | null {
    return this.#state;
  }

  apply(msg: ServerMessage): { ok: true } | { ok: false; needsResync: true } {
    if (msg.type === "snapshot") {
      this.#state = fromSnapshot(msg);
      this.#emit({ kind: "snapshot", merged: [] });
      return { ok: true };
    }
    const prev = this.#state;
    if (prev === null || msg.seq !== prev.seq + 1) {
      return { ok: false, needsResync: true };
    }
    const { state, merged } = applyPatch(prev, msg);
    this.#state = state;
    this.#emit({ kind: "patch", patch: msg, merged });
    return { ok: true };
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  #emit(c: Change): void {
    const s = this.#state;
    if (s === null) return;
    for (const fn of this.#listeners) fn(s, c);
  }
}

function fromSnapshot(s: Snapshot): RepoState {
  const overlays = new Map<WorktreeId, Map<string, ChangeEntry>>();
  for (const [id, entries] of Object.entries(s.overlays ?? {})) {
    if (!entries || entries.length === 0) continue;
    overlays.set(id, new Map(entries.map((e) => [e.path, e])));
  }
  return {
    repo: { ...s.repo },
    seq: s.seq,
    worktrees: new Map((s.worktrees ?? []).map((w) => [w.id, w])),
    tree: new Map((s.tree ?? []).map((f) => [f.path, f.size])),
    overlays,
    activity: (s.activity ?? []).slice(-ACTIVITY_LIMIT),
  };
}

function applyPatch(prev: RepoState, p: Patch): { state: RepoState; merged: string[] } {
  const next: RepoState = { ...prev, seq: p.seq };

  if (p.worktrees) {
    next.worktrees = new Map(p.worktrees.map((w) => [w.id, w]));
  }

  const baseTouched = new Set<string>();
  if (p.base) {
    const tree = new Map(prev.tree);
    for (const f of p.base.upsert ?? []) {
      tree.set(f.path, f.size);
      baseTouched.add(f.path);
    }
    for (const path of p.base.remove ?? []) {
      tree.delete(path);
      baseTouched.add(path);
    }
    next.tree = tree;
    next.repo = { ...prev.repo, baseSha: p.base.sha };
  }

  // Entries removed by this patch, remembered with their previous stage.
  const removed: ChangeEntry[] = [];
  if (p.overlays || p.worktrees) {
    const overlays = new Map(prev.overlays);
    for (const [id, op] of Object.entries(p.overlays ?? {})) {
      const m = new Map(overlays.get(id) ?? []);
      for (const path of op.remove ?? []) {
        const old = m.get(path);
        if (old) removed.push(old);
        m.delete(path);
      }
      for (const e of op.upsert ?? []) m.set(e.path, e);
      if (m.size === 0) overlays.delete(id);
      else overlays.set(id, m);
    }
    // Defensive: a worktree that left the list takes its overlay with it.
    // These removals are NOT merge candidates (the worktree went away).
    for (const id of [...overlays.keys()]) {
      if (!next.worktrees.has(id)) overlays.delete(id);
    }
    next.overlays = overlays;
  }

  if (p.activity && p.activity.length > 0) {
    next.activity = prev.activity.concat(p.activity).slice(-ACTIVITY_LIMIT);
  }

  return { state: next, merged: mergedPaths(next, removed, baseTouched) };
}

// A removed overlay entry counts as "merged into base" when no overlay still
// touches the path, base has the path after the patch, and either the entry
// was already committed on its branch or this same patch changed the base
// entry. The last rule stops a reverted uncommitted edit from shimmering.
function mergedPaths(s: RepoState, removed: ChangeEntry[], baseTouched: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of removed) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    if (!s.tree.has(e.path)) continue;
    if (e.stage !== "committed" && !baseTouched.has(e.path)) continue;
    let stillTouched = false;
    for (const m of s.overlays.values()) {
      if (m.has(e.path)) {
        stillTouched = true;
        break;
      }
    }
    if (!stillTouched) out.push(e.path);
  }
  return out;
}
```

- [ ] **Step 8: Run the store tests to verify they pass**

Run: `pnpm -C web exec vitest run src/store.test.ts`
Expected: PASS, `Tests  16 passed (16)`.

- [ ] **Step 9: Commit**

```bash
git add web/package.json web/pnpm-lock.yaml web/.gitignore web/tsconfig.json web/svelte.config.js web/vite.config.ts web/eslint.config.js web/index.html web/src/test-setup.ts web/src/protocol.ts web/src/store.ts web/src/store.test.ts
git commit -m "$(cat <<'EOF'
feat(web): scaffold Vite + Svelte 5 project with protocol and store

The store applies snapshots and seq-checked patches copy-on-write and
reports paths merged into base so the renderer can shimmer them.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10: Write the failing connection test**

`web/src/connection.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs, connect, wsUrlFromLocation } from "./connection";
import type { Patch, Snapshot } from "./protocol";
import { RepoStore } from "./store";

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  // test helpers
  open(): void {
    this.onopen?.();
  }
  message(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(): void {
    this.onclose?.();
  }
}

const snap: Snapshot = {
  type: "snapshot",
  seq: 1,
  repo: { name: "sample-app", base: "main", baseSha: "b" },
  worktrees: [],
  tree: [],
  overlays: {},
  activity: [],
};
const patch = (seq: number): Patch => ({ type: "patch", seq });
const last = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]!;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("wsUrlFromLocation", () => {
  it("maps http to ws and https to wss on the same host", () => {
    expect(wsUrlFromLocation(new URL("http://127.0.0.1:7070/"))).toBe("ws://127.0.0.1:7070/ws");
    expect(wsUrlFromLocation(new URL("https://localhost:9000/x"))).toBe("wss://localhost:9000/ws");
  });

  it("forwards the ?t= token so a cookie-less first load still authenticates", () => {
    expect(wsUrlFromLocation(new URL("http://127.0.0.1:7070/?t=abc%2F1"))).toBe("ws://127.0.0.1:7070/ws?t=abc%2F1");
  });
});

describe("backoffMs", () => {
  it("doubles from 250ms and caps at 5s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 30].map(backoffMs)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });
});

describe("connect", () => {
  it("applies messages to the store and reports status", () => {
    const store = new RepoStore();
    const statuses: string[] = [];
    connect(store, { url: "ws://x/ws", onStatus: (s) => statuses.push(s) });
    expect(last().url).toBe("ws://x/ws");
    last().open();
    last().message(snap);
    last().message(patch(2));
    expect(store.state?.seq).toBe(2);
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("sends one resync on a seq gap and none again until a snapshot arrives", () => {
    const store = new RepoStore();
    connect(store, { url: "ws://x/ws" });
    last().open();
    last().message(snap);
    last().message(patch(3));
    last().message(patch(4));
    expect(last().sent).toEqual([JSON.stringify({ type: "resync" })]);
    last().message({ ...snap, seq: 4 });
    last().message(patch(9));
    expect(last().sent).toHaveLength(2);
  });

  it("ignores frames that are not valid JSON", () => {
    const store = new RepoStore();
    connect(store, { url: "ws://x/ws" });
    last().open();
    last().onmessage?.({ data: "{nope" });
    expect(store.state).toBeNull();
  });

  it("reconnects with exponential backoff and resets after a successful open", () => {
    const store = new RepoStore();
    const statuses: string[] = [];
    connect(store, { url: "ws://x/ws", onStatus: (s) => statuses.push(s) });
    last().drop();
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(249);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    last().drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    last().open();
    last().drop();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("stops reconnecting and closes the socket when disposed", () => {
    const store = new RepoStore();
    const stop = connect(store, { url: "ws://x/ws" });
    const sock = last();
    stop();
    expect(sock.closed).toBe(true);
    sock.drop();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/connection.test.ts`
Expected: FAIL with `Error: Failed to resolve import "./connection" from "src/connection.test.ts". Does the file exist?`

- [ ] **Step 12: Implement the connection**

`web/src/connection.ts`:

```ts
import type { ResyncRequest, ServerMessage } from "./protocol";
import type { RepoStore } from "./store";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 5000;

/** ws(s)://<same host>/ws, carrying the page's ?t= token if present. */
export function wsUrlFromLocation(loc: Pick<Location, "protocol" | "host" | "search">): string {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const token = new URLSearchParams(loc.search).get("t");
  const query = token ? `?t=${encodeURIComponent(token)}` : "";
  return `${proto}//${loc.host}/ws${query}`;
}

/** Delay before reconnect attempt `attempt` (0-based): 250ms doubling, capped at 5s. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 16));
}

/**
 * Keeps a WebSocket open to the Orion server and feeds every message into
 * `store`. Returns a function that closes the socket and stops reconnecting.
 */
export function connect(
  store: RepoStore,
  opts?: { url?: string; onStatus?: (s: ConnectionStatus) => void },
): () => void {
  const url = opts?.url ?? wsUrlFromLocation(window.location);
  const onStatus = opts?.onStatus ?? (() => {});
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let socket: WebSocket | null = null;

  const open = (): void => {
    let awaitingSnapshot = false;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      onStatus("open");
    };
    ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type !== "snapshot" && msg.type !== "patch") return;
      if (msg.type === "snapshot") awaitingSnapshot = false;
      const res = store.apply(msg);
      if (!res.ok && !awaitingSnapshot) {
        awaitingSnapshot = true;
        const req: ResyncRequest = { type: "resync" };
        ws.send(JSON.stringify(req));
      }
    };
    ws.onclose = () => {
      if (stopped || socket !== ws) return;
      onStatus("reconnecting");
      timer = setTimeout(open, backoffMs(attempt));
      attempt++;
    };
  };

  onStatus("connecting");
  open();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    socket?.close();
  };
}
```

- [ ] **Step 13: Run the connection tests to verify they pass**

Run: `pnpm -C web exec vitest run src/connection.test.ts`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 14: Add the entry point and a placeholder app**

`web/src/main.ts`:

```ts
import { mount } from "svelte";
import App from "./ui/App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app element missing from index.html");

export default mount(App, { target });
```

`web/src/ui/App.svelte`. This placeholder only proves the store and connection are wired; Task 11 replaces it:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { connect, type ConnectionStatus } from "../connection";
  import { RepoStore, type RepoState } from "../store";

  const store = new RepoStore();
  let repo: RepoState | null = $state.raw(null);
  let status: ConnectionStatus = $state("connecting");

  onMount(() => {
    const off = store.subscribe((s) => (repo = s));
    const stop = connect(store, { onStatus: (s) => (status = s) });
    return () => {
      off();
      stop();
    };
  });
</script>

<main>
  <h1>{repo?.repo.name ?? "Orion"}</h1>
  <p>{status === "open" ? `${repo?.tree.size ?? 0} files` : status}</p>
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #07070a;
    color: #f2f2f7;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  }
  main {
    padding: 24px;
  }
  h1 {
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 4px;
  }
  p {
    margin: 0;
    opacity: 0.55;
    font-size: 12px;
  }
</style>
```

- [ ] **Step 15: Run the full web check (what CI runs)**

Run: `pnpm -C web lint && pnpm -C web test && pnpm -C web build && ls -a internal/webassets/static && git status --short internal/webassets`

Expected:
- `svelte-check` prints `COMPLETED … 0 ERRORS 0 WARNINGS`.
- Tests print `Test Files  2 passed (2)` and `Tests  24 passed (24)`.
- Vite prints `✓ built in …` and writes `../internal/webassets/static/index.html` plus `assets/`.
- `ls` shows `.gitkeep` still present.
- `git status` prints nothing, because Task 1 gitignores `static/*` except `.gitkeep`.

- [ ] **Step 16: Commit**

```bash
git add web/src/connection.ts web/src/connection.test.ts web/src/main.ts web/src/ui/App.svelte
git commit -m "$(cat <<'EOF'
feat(web): add WebSocket connection with backoff and resync

Reconnects with 250ms→5s exponential backoff and requests a fresh
snapshot once per detected seq gap.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 17: Rebase, push and open the PR**

```bash
git fetch origin && git rebase origin/main
pnpm -C web lint && pnpm -C web test && pnpm -C web build
git push -u origin feat/web-scaffold
gh pr create --base main --head feat/web-scaffold --title "feat(web): scaffold frontend with protocol, store and connection" --body "$(cat <<'EOF'
## Summary
- Vite 8 + Svelte 5 + TypeScript 6 project in `web/`, building into `internal/webassets/static/` while preserving `.gitkeep`.
- `protocol.ts` mirrors the Go wire types; `RepoStore` applies snapshots and seq-checked patches (copy-on-write) and computes merged paths.
- `connect()` keeps a WebSocket open with 250ms→5s backoff and sends one `resync` per seq gap.

## Test plan
- [x] `pnpm -C web lint` (eslint + svelte-check, 0 warnings)
- [x] `pnpm -C web test` (24 tests)
- [x] `pnpm -C web build` (writes static/, keeps .gitkeep)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 10: Layout: node set, stable pack, encoding, colours

**Branch:** `feat/web-layout` · **Depends on:** Task 9

**Files:**
- Create: `web/src/colors.ts`, `web/src/layout/nodes.ts`, `web/src/layout/pack.ts`, `web/src/layout/encoding.ts`, `web/src/layout/frame.ts`, `web/src/layout/fixtures.ts` (test helper)
- Test: `web/src/colors.test.ts`, `web/src/layout/nodes.test.ts`, `web/src/layout/pack.test.ts`, `web/src/layout/encoding.test.ts`, `web/src/layout/frame.test.ts`

**Interfaces:**
- Consumes: `RepoState` from `web/src/store.ts`; `ChangeEntry`, `Kind`, `Stage`, `WorktreeId`, `Worktree` from `web/src/protocol.ts` (Task 9).
- Produces:
  - `colors.ts`: `WORKTREE_COLORS: readonly string[]`, `colorForExt(ext): { base; light }`, plus the additions `worktreeColor(index: number): string` (modulo 10; `-1` → `#8e8e93`), `extOf(path: string): string`, `lighten(hex: string, amount: number): string`, `hexToNumber(hex: string): number`, `EXT_GROUPS`, `type ExtColor = { base: string; light: string }`.
  - `layout/nodes.ts`: `TreeNode`, `buildTree(state: RepoState): TreeNode`.
  - `layout/pack.ts`: `Circle`, `computeLayout(root, width, height, opts?)`, `MIN_FILE_R = 1.5`, `MIN_DIR_R = 6`, `packValue(size: number): number`. The map is in pre-order: parents come before children.
  - `layout/encoding.ts`: `Touch`, `NodeVisual`, `encode(state, path)`, plus the addition `encodeAll(state: RepoState, layout: Map<string, Circle>): Map<string, NodeVisual>`.
  - `layout/frame.ts` (addition): `interface Frame { layout: Map<string, Circle>; visuals: Map<string, NodeVisual> }`, `computeFrame(state: RepoState, width: number, height: number, scale: number, pad?: number): Frame`.
  - `layout/fixtures.ts` (test helper): `wt(id, colorIndex, label?)`, `makeState(tree, overlays?, worktrees?)`.

**Design notes (read before coding):**
- **Node set.** The nodes are base paths ∪ every overlay entry's `path`.
  - Deleted entries stay as nodes so they can render as outlines. Their size is the base size, or 0 when the path is not in base.
  - A renamed entry contributes only its new path. Its `from` path is never added by the overlay. It shows only while base still has it, and there `encode()` marks it as moved away: a synthetic `deleted` touch from the renaming worktree, so it renders as a faint outline until the rename reaches base. A `from` path that is not in base (for example, a file created and renamed on a branch) simply disappears, and the renderer glides the new node out of the old node's position.
  - This is how "excluded unless still in base" is interpreted. The alternative, hiding a base file because one worktree renamed it, would misrepresent every other worktree.
- **File size** is the maximum of the base size and any non-deleted overlay size, so an edit that grows a file grows its bubble live.
- **Path conflicts.** If a path is both a file and a directory prefix (a file replaced by a folder in some worktree), the directory wins.
- **Stability.**
  - Children are sorted by name with a code-point comparison (never by size, never locale-dependent).
  - Sizes are snapped to quarter-octave buckets (`packValue`) before packing. d3's front-chain packer keeps sibling order, but any size change nudges every later sibling. Measured on the test repo, a 747 → 1300 byte edit moved a neighbour 183 px. With snapping, ordinary small edits leave the layout pixel-identical.
  - `sum` uses `max(1, size)` so empty files stay visible.
- **Culling.**
  - Files with `r < minFileR` are omitted.
  - A directory other than the root collapses into one aggregate circle (`aggregate` = descendant **file** count, no descendants emitted) when `r < minDirR` **or** when every child is a file that would be culled. The second rule avoids empty rings: because d3 adds padding to folders, a nested folder is almost never smaller than 6 px.
  - Thresholds are on-screen pixels. `computeFrame` divides them by the camera scale, so zooming in reveals smaller files.
- **Aggregates carry touches.** `encodeAll` rolls up one touch per worktree for everything under a collapsed folder, so agent activity deep in a big repo still glows at the top level.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-web-layout -b feat/web-layout main
cd .claude/worktrees/feat-web-layout
pnpm -C web install --frozen-lockfile
```

- [ ] **Step 2: Write the failing colour test**

`web/src/colors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EXT_GROUPS, WORKTREE_COLORS, colorForExt, extOf, lighten, worktreeColor } from "./colors";

describe("WORKTREE_COLORS", () => {
  it("is exactly the 10 Apple system colours, main (index 0) blue", () => {
    expect(WORKTREE_COLORS).toEqual([
      "#0a84ff", "#ff9f0a", "#30d158", "#ff375f", "#bf5af2",
      "#40c8e0", "#ffd60a", "#5e5ce6", "#ff453a", "#63e6e2",
    ]);
  });
});

describe("worktreeColor", () => {
  it("wraps past 10 and greys out unassigned (-1)", () => {
    expect(worktreeColor(0)).toBe("#0a84ff");
    expect(worktreeColor(11)).toBe("#ff9f0a");
    expect(worktreeColor(-1)).toBe("#8e8e93");
  });
});

describe("extOf", () => {
  it("lower-cases the last extension of the base name", () => {
    expect(extOf("src/App.Svelte")).toBe("svelte");
    expect(extOf("a.b/c.tar.GZ")).toBe("gz");
  });
  it("uses the whole base name when there is no extension or it is a dotfile", () => {
    expect(extOf("Makefile")).toBe("makefile");
    expect(extOf("dir.d/Dockerfile")).toBe("dockerfile");
    expect(extOf(".gitignore")).toBe(".gitignore");
  });
});

describe("colorForExt", () => {
  it("groups related extensions", () => {
    expect(colorForExt("ts")).toEqual(colorForExt("tsx"));
    expect(colorForExt("go")).toEqual(colorForExt("rs"));
    expect(colorForExt("md")).toEqual(EXT_GROUPS.docs);
    expect(colorForExt("makefile")).toEqual(EXT_GROUPS.config);
  });
  it("falls back to the neutral group", () => {
    expect(colorForExt("zzz")).toEqual(EXT_GROUPS.other);
  });
  it("returns hex stops", () => {
    const { base, light } = colorForExt("ts");
    expect(base).toMatch(/^#[0-9a-f]{6}$/);
    expect(light).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("lighten", () => {
  it("mixes towards white", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080");
    expect(lighten("#ff9f0a", 0)).toBe("#ff9f0a");
    expect(lighten("#0a84ff", 1)).toBe("#ffffff");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/colors.test.ts`
Expected: FAIL with `Failed to resolve import "./colors" from "src/colors.test.ts"`.

- [ ] **Step 4: Implement the colours**

`web/src/colors.ts`:

```ts
// Worktree palette: Apple system colours (dark mode). Index 0 = main worktree.
export const WORKTREE_COLORS: readonly string[] = [
  "#0a84ff", // blue
  "#ff9f0a", // orange
  "#30d158", // green
  "#ff375f", // pink
  "#bf5af2", // purple
  "#40c8e0", // teal
  "#ffd60a", // yellow
  "#5e5ce6", // indigo
  "#ff453a", // red
  "#63e6e2", // mint
];

const UNASSIGNED = "#8e8e93";

/** Colour for a worktree colour index; reused modulo 10; -1 (not yet active) is grey. */
export function worktreeColor(index: number): string {
  if (index < 0) return UNASSIGNED;
  return WORKTREE_COLORS[index % WORKTREE_COLORS.length] ?? UNASSIGNED;
}

export interface ExtColor {
  base: string; // outer (darker) gradient stop
  light: string; // highlight stop at 35%/30%
}

// Curated file-type groups. Purple, blue and yellow are the exact stops from
// the approved Vision mockup; the rest are tuned to sit beside them.
export const EXT_GROUPS = {
  web: { light: "#8cc4ff", base: "#2f6fe6" },
  systems: { light: "#b5a6ff", base: "#6a4fe0" },
  scripting: { light: "#8fe3d9", base: "#1f9e93" },
  docs: { light: "#ffe08a", base: "#e8a820" },
  styles: { light: "#ffb3c7", base: "#d9507a" },
  config: { light: "#c9ccd8", base: "#737891" },
  media: { light: "#a9eeb4", base: "#35a353" },
  other: { light: "#a4a4b0", base: "#5c5c68" },
} as const satisfies Record<string, ExtColor>;

type Group = keyof typeof EXT_GROUPS;

const BY_EXT: Record<string, Group> = {};
function add(group: Group, exts: string): void {
  for (const e of exts.split(" ")) BY_EXT[e] = group;
}
add("web", "ts tsx js jsx mjs cjs mts cts svelte vue astro html htm");
add("systems", "go rs c h cc cpp hpp cxx swift m mm java kt kts scala zig cs fs");
add("scripting", "py rb ex exs erl hrl php lua sh bash zsh fish pl r jl clj dart");
add("docs", "md mdx txt rst adoc org tex license");
add("styles", "css scss sass less styl pcss");
add("config", "json jsonc yaml yml toml xml ini cfg conf env lock sum mod sql graphql proto makefile dockerfile gitignore .gitignore .gitattributes .editorconfig .npmrc");
add("media", "png jpg jpeg gif webp svg ico bmp avif mp4 mov webm mp3 wav ogg woff woff2 ttf otf eot pdf");

/** Lower-cased extension of the base name; the whole base name if it has none (or is a dotfile). */
export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : name;
}

export function colorForExt(ext: string): { base: string; light: string } {
  return EXT_GROUPS[BY_EXT[ext.toLowerCase()] ?? "other"];
}

/** Mix `hex` towards white by `amount` (0..1). */
export function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number): number => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** "#rrggbb" → 0xrrggbb for Pixi tints. */
export function hexToNumber(hex: string): number {
  return parseInt(hex.slice(1), 16);
}
```

- [ ] **Step 5: Run the colour tests to verify they pass**

Run: `pnpm -C web exec vitest run src/colors.test.ts`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 6: Write the test fixture helper and the failing node-set test**

`web/src/layout/fixtures.ts`:

```ts
// Test helper: builds a RepoState by hand. Synthetic paths only.
import type { ChangeEntry, Worktree } from "../protocol";
import type { RepoState } from "../store";

export function wt(id: string, colorIndex: number, label = id): Worktree {
  return { id, path: `/repo/${id}`, label, head: "0000000", isMain: colorIndex === 0, locked: false, colorIndex };
}

export function makeState(
  tree: Record<string, number>,
  overlays: Record<string, ChangeEntry[]> = {},
  worktrees: Worktree[] = [wt("w0", 0, "main"), wt("w1", 1, "feat/a"), wt("w2", 2, "fix/b")],
): RepoState {
  return {
    repo: { name: "sample-app", base: "origin/main", baseSha: "b0" },
    seq: 1,
    worktrees: new Map(worktrees.map((w) => [w.id, w])),
    tree: new Map(Object.entries(tree)),
    overlays: new Map(Object.entries(overlays).map(([id, es]) => [id, new Map(es.map((e) => [e.path, e]))])),
    activity: [],
  };
}
```

`web/src/layout/nodes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeState } from "./fixtures";
import { buildTree, type TreeNode } from "./nodes";

function find(root: TreeNode, path: string): TreeNode | undefined {
  if (root.path === path) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, path);
    if (hit) return hit;
  }
  return undefined;
}

function paths(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode): void => {
    out.push(n.path);
    n.children?.forEach(walk);
  };
  walk(root);
  return out;
}

describe("buildTree", () => {
  it("nests base files under directory nodes, children sorted by name", () => {
    const root = buildTree(makeState({ "src/z.ts": 5, "src/a.ts": 7, "README.md": 3, "src/lib/b.ts": 1 }));
    expect(root).toMatchObject({ path: "", name: "sample-app", isDir: true });
    expect(paths(root)).toEqual(["", "README.md", "src", "src/a.ts", "src/lib", "src/lib/b.ts", "src/z.ts"]);
    expect(find(root, "src")).toMatchObject({ name: "src", isDir: true, size: 0 });
    expect(find(root, "src/a.ts")).toMatchObject({ name: "a.ts", isDir: false, size: 7 });
    expect(find(root, "src/a.ts")!.children).toBeUndefined();
  });

  it("sorts by code point, not locale or size", () => {
    const root = buildTree(makeState({ "b.ts": 1, "B.ts": 999, "a.ts": 50 }));
    expect(root.children!.map((c) => c.name)).toEqual(["B.ts", "a.ts", "b.ts"]);
  });

  it("adds overlay-only paths and sizes a file by the largest live version", () => {
    const root = buildTree(
      makeState({ "src/a.ts": 10 }, {
        w1: [
          { path: "src/a.ts", kind: "modified", stage: "committed", size: 30 },
          { path: "src/new/x.ts", kind: "added", stage: "uncommitted", size: 4 },
        ],
        w2: [{ path: "src/a.ts", kind: "modified", stage: "uncommitted", size: 20 }],
      }),
    );
    expect(find(root, "src/a.ts")!.size).toBe(30);
    expect(find(root, "src/new")).toMatchObject({ isDir: true });
    expect(find(root, "src/new/x.ts")).toMatchObject({ size: 4 });
  });

  it("keeps deleted paths as nodes: base size when in base, else 0", () => {
    const root = buildTree(
      makeState({ "gone.ts": 12 }, {
        w1: [
          { path: "gone.ts", kind: "deleted", stage: "uncommitted", size: 0 },
          { path: "tmp/ghost.ts", kind: "deleted", stage: "uncommitted", size: 0 },
        ],
      }),
    );
    expect(find(root, "gone.ts")!.size).toBe(12);
    expect(find(root, "tmp/ghost.ts")!.size).toBe(0);
  });

  it("never adds a rename's `from` path; it shows only while base still has it", () => {
    const root = buildTree(
      makeState({ "old/name.ts": 8 }, {
        w1: [
          { path: "new/name.ts", kind: "renamed", from: "old/name.ts", stage: "uncommitted", size: 8 },
          { path: "b.ts", kind: "renamed", from: "a-not-in-base.ts", stage: "committed", size: 3 },
        ],
      }),
    );
    expect(find(root, "old/name.ts")).toBeDefined();
    expect(find(root, "new/name.ts")).toBeDefined();
    expect(find(root, "a-not-in-base.ts")).toBeUndefined();
  });

  it("lets a directory win when a path is both a file and a directory", () => {
    const root = buildTree(makeState({ docs: 5 }, { w1: [{ path: "docs/intro.md", kind: "added", stage: "uncommitted", size: 2 }] }));
    expect(find(root, "docs")).toMatchObject({ isDir: true });
    expect(find(root, "docs/intro.md")).toBeDefined();
  });

  it("returns an empty root for an empty repo", () => {
    expect(buildTree(makeState({}))).toEqual({ path: "", name: "sample-app", isDir: true, size: 0, children: [] });
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/layout/nodes.test.ts`
Expected: FAIL with `Failed to resolve import "./nodes"`.

- [ ] **Step 8: Implement `buildTree`**

`web/src/layout/nodes.ts`:

```ts
import type { RepoState } from "../store";

export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  children?: TreeNode[];
}

/**
 * The node set is base ∪ every overlay entry's `path` (spec §6).
 *
 * - Deleted entries stay as nodes so they can render as faint outlines until
 *   the deletion reaches base. Their size is the base size (0 if not in base)
 *   so their siblings do not reshuffle.
 * - A renamed entry contributes only its NEW path. Its `from` path is never
 *   added by the overlay: it appears only while base still has it (where
 *   encode() marks it as moved-away, i.e. deleted for that worktree). A `from`
 *   path that is not in base simply vanishes, and the renderer glides the new
 *   node out of the old node's last position.
 * - A file's size is the largest of its base size and any non-deleted overlay
 *   size, so edits grow bubbles live.
 * - If a path is both a file and a directory prefix, the directory wins.
 */
export function buildTree(state: RepoState): TreeNode {
  const sizes = new Map<string, number>(state.tree);
  for (const entries of state.overlays.values()) {
    for (const e of entries.values()) {
      if (e.kind === "deleted") {
        if (!sizes.has(e.path)) sizes.set(e.path, 0);
      } else {
        sizes.set(e.path, Math.max(sizes.get(e.path) ?? 0, e.size));
      }
    }
  }

  const root: TreeNode = { path: "", name: state.repo.name, isDir: true, size: 0, children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  const dirFor = (dirPath: string): TreeNode => {
    const hit = dirs.get(dirPath);
    if (hit) return hit;
    const slash = dirPath.lastIndexOf("/");
    const parent = dirFor(slash < 0 ? "" : dirPath.slice(0, slash));
    const node: TreeNode = { path: dirPath, name: dirPath.slice(slash + 1), isDir: true, size: 0, children: [] };
    parent.children!.push(node);
    dirs.set(dirPath, node);
    return node;
  };

  // Directories first, so a file path that is also a directory is skipped.
  for (const path of sizes.keys()) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) dirFor(path.slice(0, slash));
  }
  for (const [path, size] of sizes) {
    if (path === "" || dirs.has(path)) continue;
    const slash = path.lastIndexOf("/");
    const parent = dirs.get(slash < 0 ? "" : path.slice(0, slash))!;
    parent.children!.push({ path, name: path.slice(slash + 1), isDir: false, size });
  }

  for (const d of dirs.values()) d.children!.sort(byName);
  return root;
}

function byName(a: TreeNode, b: TreeNode): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
```

- [ ] **Step 9: Run the node-set tests to verify they pass**

Run: `pnpm -C web exec vitest run src/layout/nodes.test.ts`
Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 10: Commit**

```bash
git add web/src/colors.ts web/src/colors.test.ts web/src/layout/fixtures.ts web/src/layout/nodes.ts web/src/layout/nodes.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add worktree/file-type colours and the map node set

Node set is base ∪ overlay paths; deletions stay as nodes and rename
sources only persist while base still has them.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Write the failing pack test**

`web/src/layout/pack.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeState } from "./fixtures";
import { buildTree } from "./nodes";
import { computeLayout, type Circle } from "./pack";

function repo(overrides: Record<string, number> = {}): Record<string, number> {
  const files: Record<string, number> = {};
  for (let d = 0; d < 6; d++) {
    for (let f = 0; f < 8; f++) files[`pkg${d}/file${f}.ts`] = 400 + ((d * 37 + f * 91) % 900);
  }
  files["README.md"] = 800;
  return { ...files, ...overrides };
}

function layoutOf(files: Record<string, number>, w = 1000, h = 800, opts?: { minFileR?: number; minDirR?: number }) {
  return computeLayout(buildTree(makeState(files)), w, h, opts);
}

function inside(child: Circle, parent: Circle): boolean {
  return Math.hypot(child.x - parent.x, child.y - parent.y) + child.r <= parent.r + 1e-6;
}

describe("computeLayout", () => {
  it("centres the root and fits it in the viewport", () => {
    const l = layoutOf(repo());
    const root = l.get("")!;
    expect(root).toMatchObject({ depth: 0, isDir: true });
    expect(root.x).toBeCloseTo(500);
    expect(root.y).toBeCloseTo(400);
    expect(root.r).toBeLessThanOrEqual(400);
    expect(root.r).toBeGreaterThan(390);
  });

  it("nests every child inside its parent, parents listed before children", () => {
    const l = layoutOf(repo());
    const keys = [...l.keys()];
    for (const [path, c] of l) {
      if (path === "") continue;
      const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      expect(inside(c, l.get(parentPath)!)).toBe(true);
      expect(keys.indexOf(parentPath)).toBeLessThan(keys.indexOf(path));
    }
  });

  it("is deterministic", () => {
    expect([...layoutOf(repo())]).toEqual([...layoutOf(repo())]);
  });

  it("keeps sibling order when a file grows a lot", () => {
    const before = layoutOf(repo());
    const after = layoutOf(repo({ "pkg2/file3.ts": 5000 }));
    expect([...after.keys()]).toEqual([...before.keys()]);
  });

  it("does not move anything when an edit stays inside the file's size bucket", () => {
    // pkg2/file3.ts starts at 747 bytes; 747 and 760 share a quarter-octave bucket.
    const before = layoutOf(repo());
    const after = layoutOf(repo({ "pkg2/file3.ts": 760 }));
    expect([...after]).toEqual([...before]);
  });

  it("gives empty files a visible minimum size", () => {
    const l = layoutOf({ "a.txt": 0, "b.txt": 0 }, 200, 200);
    expect(l.get("a.txt")!.r).toBeGreaterThan(10);
    expect(l.get("b.txt")!.r).toBeGreaterThan(10);
  });

  it("culls files whose radius is under minFileR", () => {
    const l = layoutOf({ "big.bin": 10_000_000, "tiny.txt": 1 }, 400, 400);
    expect(l.has("big.bin")).toBe(true);
    expect(l.has("tiny.txt")).toBe(false);
    const finer = layoutOf({ "big.bin": 10_000_000, "tiny.txt": 1 }, 400, 400, { minFileR: 0.01 });
    expect(finer.has("tiny.txt")).toBe(true);
  });

  it("collapses directories under minDirR into one aggregate circle with their file count", () => {
    const files: Record<string, number> = { "big.bin": 50_000_000 };
    for (let i = 0; i < 2; i++) files[`vendor/f${i}.js`] = 10;
    const l = layoutOf(files, 400, 400);
    const vendor = l.get("vendor")!;
    expect(vendor).toMatchObject({ isDir: true, aggregate: 2 });
    expect(vendor.r).toBeLessThan(6);
    expect([...l.keys()].filter((k) => k.startsWith("vendor/"))).toEqual([]);
  });

  it("also collapses a larger directory when every file in it would be culled", () => {
    const files: Record<string, number> = { "big.bin": 50_000_000 };
    for (let i = 0; i < 3; i++) files[`vendor/sub/f${i}.js`] = 10;
    files["vendor/g.js"] = 10;
    const l = layoutOf(files, 400, 400);
    const vendor = l.get("vendor")!;
    expect(vendor.r).toBeGreaterThanOrEqual(6);
    expect(vendor.aggregate).toBeUndefined();
    expect(l.get("vendor/sub")).toMatchObject({ aggregate: 3 });
    expect(l.has("vendor/g.js")).toBe(false);
  });

  it("never aggregates the root and does not set aggregate on normal dirs", () => {
    const l = layoutOf(repo(), 10, 10);
    expect(l.get("")!.aggregate).toBeUndefined();
    expect(layoutOf(repo()).get("pkg0")!.aggregate).toBeUndefined();
  });

  it("lays out an empty repo as just the root", () => {
    const l = computeLayout(buildTree(makeState({})), 300, 200);
    expect([...l.keys()]).toEqual([""]);
    expect(l.get("")).toMatchObject({ x: 150, y: 100, depth: 0, isDir: true });
    expect(l.get("")!.r).toBeGreaterThan(90);
  });
});
```

- [ ] **Step 12: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/layout/pack.test.ts`
Expected: FAIL with `Failed to resolve import "./pack"`.

- [ ] **Step 13: Implement the stable pack**

`web/src/layout/pack.ts`:

```ts
import { hierarchy, pack, type HierarchyCircularNode } from "d3-hierarchy";
import type { TreeNode } from "./nodes";

export interface Circle {
  path: string;
  x: number;
  y: number;
  r: number;
  depth: number;
  isDir: boolean;
  aggregate?: number; // collapsed dir: number of descendant files
}

export const MIN_FILE_R = 1.5;
export const MIN_DIR_R = 6;
const PADDING = 3;

/**
 * Sizes are snapped to quarter-octave buckets (×1.19 in area, ≈9% in radius)
 * before packing. d3's front-chain packer is order-stable but a single size
 * change can nudge every later sibling; snapping means ordinary small edits
 * leave the layout pixel-identical, and only real growth moves anything.
 */
export function packValue(size: number): number {
  const v = Math.max(1, size);
  return 2 ** (Math.round(Math.log2(v) * 4) / 4);
}

/**
 * Stable circle packing. Children are ordered by name (never by size).
 * Radii are in layout pixels; to cull at a zoom scale k, pass
 * minFileR/minDirR divided by k.
 *
 * Culling: files with r < minFileR are omitted. A directory (other than the
 * root) collapses to one aggregate circle, and none of its descendants are
 * emitted, when r < minDirR or when every child is a file that would be
 * culled. `aggregate` is its descendant file count.
 *
 * The returned map is in pre-order (parents before children), which the
 * renderer relies on for draw order.
 */
export function computeLayout(
  root: TreeNode,
  width: number,
  height: number,
  opts?: { minFileR?: number; minDirR?: number },
): Map<string, Circle> {
  const minFileR = opts?.minFileR ?? MIN_FILE_R;
  const minDirR = opts?.minDirR ?? MIN_DIR_R;
  const out = new Map<string, Circle>();

  if (!root.children || root.children.length === 0) {
    const r = Math.max(0, Math.min(width, height) / 2 - PADDING);
    out.set(root.path, { path: root.path, x: width / 2, y: height / 2, r, depth: 0, isDir: true });
    return out;
  }

  const h = hierarchy<TreeNode>(root, (d) => d.children)
    .sum((d) => (d.isDir ? 0 : packValue(d.size)))
    .sort((a, b) => (a.data.name < b.data.name ? -1 : a.data.name > b.data.name ? 1 : 0));
  const packed = pack<TreeNode>().size([width, height]).padding(PADDING)(h);

  const visit = (n: HierarchyCircularNode<TreeNode>): void => {
    const c: Circle = { path: n.data.path, x: n.x, y: n.y, r: n.r, depth: n.depth, isDir: n.data.isDir };
    if (!n.data.isDir) {
      if (n.r >= minFileR) out.set(c.path, c);
      return;
    }
    const kids = n.children ?? [];
    const allCulled = kids.every((k) => !k.data.isDir && k.r < minFileR);
    if (n.depth > 0 && (n.r < minDirR || allCulled)) {
      c.aggregate = n.leaves().filter((l) => !l.data.isDir).length;
      out.set(c.path, c);
      return;
    }
    out.set(c.path, c);
    for (const k of kids) visit(k);
  };
  visit(packed);
  return out;
}
```

- [ ] **Step 14: Run the pack tests to verify they pass**

Run: `pnpm -C web exec vitest run src/layout/pack.test.ts`
Expected: PASS, `Tests  11 passed (11)`.

- [ ] **Step 15: Write the failing encoding test**

`web/src/layout/encoding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChangeEntry } from "../protocol";
import { encode, encodeAll } from "./encoding";
import { makeState } from "./fixtures";
import type { Circle } from "./pack";

const e = (path: string, kind: ChangeEntry["kind"], stage: ChangeEntry["stage"], from?: string): ChangeEntry => ({
  path,
  kind,
  stage,
  size: 10,
  ...(from ? { from } : {}),
});

describe("encode", () => {
  it("leaves an untouched base file plain", () => {
    expect(encode(makeState({ "src/a.ts": 5 }), "src/a.ts")).toEqual({
      path: "src/a.ts",
      ext: "ts",
      touches: [],
      ghost: false,
      deleted: false,
      tinted: false,
    });
  });

  it("uncommitted modified: one touch, normal fill (not ghost, not tinted)", () => {
    const v = encode(makeState({ "a.ts": 5 }, { w1: [e("a.ts", "modified", "uncommitted")] }), "a.ts");
    expect(v.touches).toEqual([{ worktree: "w1", colorIndex: 1, stage: "uncommitted", kind: "modified" }]);
    expect(v).toMatchObject({ ghost: false, tinted: false, deleted: false });
  });

  it("uncommitted added: ghost", () => {
    expect(encode(makeState({}, { w1: [e("n.ts", "added", "uncommitted")] }), "n.ts")).toMatchObject({ ghost: true, tinted: false });
  });

  it("committed added: tinted, not ghost", () => {
    expect(encode(makeState({}, { w1: [e("n.ts", "added", "committed")] }), "n.ts")).toMatchObject({ ghost: false, tinted: true });
  });

  it("committed touch plus someone's uncommitted touch is not tinted", () => {
    const s = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "modified", "committed")], w2: [e("a.ts", "modified", "uncommitted")] });
    expect(encode(s, "a.ts").tinted).toBe(false);
  });

  it("ghost wins even when another worktree has committed the file", () => {
    const s = makeState({}, { w1: [e("n.ts", "added", "committed")], w2: [e("n.ts", "added", "uncommitted")] });
    expect(encode(s, "n.ts")).toMatchObject({ ghost: true, tinted: false });
  });

  it("deleted only when every touch is a deletion", () => {
    const gone = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "deleted", "uncommitted")] });
    expect(encode(gone, "a.ts").deleted).toBe(true);
    const mixed = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "deleted", "committed")], w2: [e("a.ts", "modified", "uncommitted")] });
    expect(encode(mixed, "a.ts").deleted).toBe(false);
  });

  it("orders touches by colour index (split ring order)", () => {
    const s = makeState({ "a.ts": 5 }, { w2: [e("a.ts", "modified", "uncommitted")], w0: [e("a.ts", "modified", "committed")] });
    expect(encode(s, "a.ts").touches.map((t) => t.worktree)).toEqual(["w0", "w2"]);
  });

  it("reports renamedFrom on the new path and marks a base `from` path as moved away (deleted)", () => {
    const s = makeState({ "old/a.ts": 5 }, { w1: [e("new/a.ts", "renamed", "uncommitted", "old/a.ts")] });
    expect(encode(s, "new/a.ts")).toMatchObject({ renamedFrom: "old/a.ts", ghost: false, deleted: false });
    const from = encode(s, "old/a.ts");
    expect(from.touches).toEqual([{ worktree: "w1", colorIndex: 1, stage: "uncommitted", kind: "deleted" }]);
    expect(from.deleted).toBe(true);
  });

  it("uses colorIndex -1 for a worktree missing from the list", () => {
    const s = makeState({}, { ghost: [e("x.ts", "added", "uncommitted")] });
    expect(encode(s, "x.ts").touches[0]!.colorIndex).toBe(-1);
  });
});

describe("encodeAll", () => {
  const circle = (path: string, isDir: boolean, aggregate?: number): Circle => ({
    path, x: 0, y: 0, r: 10, depth: 1, isDir, ...(aggregate ? { aggregate } : {}),
  });

  it("encodes files, leaves plain dirs untouched, and rolls touches up into aggregates", () => {
    const s = makeState(
      { "src/a.ts": 1, "vendor/x/y.js": 1, "vendor/z.js": 1 },
      {
        w1: [e("vendor/x/y.js", "modified", "committed"), e("src/a.ts", "added", "uncommitted")],
        w2: [e("vendor/z.js", "modified", "uncommitted"), e("vendor/new.js", "added", "committed")],
      },
    );
    const layout = new Map<string, Circle>([
      ["", circle("", true)],
      ["src", circle("src", true)],
      ["src/a.ts", circle("src/a.ts", false)],
      ["vendor", circle("vendor", true, 3)],
    ]);
    const v = encodeAll(s, layout);
    expect([...v.keys()]).toEqual(["", "src", "src/a.ts", "vendor"]);
    expect(v.get("src")!.touches).toEqual([]);
    expect(v.get("src/a.ts")!.ghost).toBe(true);
    expect(v.get("vendor")!.touches).toEqual([
      { worktree: "w1", colorIndex: 1, stage: "committed", kind: "modified" },
      { worktree: "w2", colorIndex: 2, stage: "uncommitted", kind: "modified" },
    ]);
    expect(v.get("vendor")).toMatchObject({ ghost: false, deleted: false, tinted: false });
  });
});
```

- [ ] **Step 16: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/layout/encoding.test.ts`
Expected: FAIL with `Failed to resolve import "./encoding"`.

- [ ] **Step 17: Implement the encoding**

`web/src/layout/encoding.ts`:

```ts
import { extOf } from "../colors";
import type { ChangeEntry, Kind, Stage, WorktreeId } from "../protocol";
import type { RepoState } from "../store";
import type { Circle } from "./pack";

export interface Touch {
  worktree: WorktreeId;
  colorIndex: number;
  stage: Stage;
  kind: Kind;
}

export interface NodeVisual {
  path: string;
  ext: string;
  touches: Touch[];
  ghost: boolean;
  deleted: boolean;
  tinted: boolean;
  renamedFrom?: string;
}

// `from` paths of renames, per state. Built lazily once per RepoState object
// (the store makes a new object per patch, so identity is a safe cache key).
const fromIndexCache = new WeakMap<RepoState, Map<string, Touch[]>>();

function fromIndex(state: RepoState): Map<string, Touch[]> {
  let idx = fromIndexCache.get(state);
  if (idx) return idx;
  idx = new Map();
  for (const [id, entries] of state.overlays) {
    for (const e of entries.values()) {
      if (e.kind !== "renamed" || !e.from || entries.has(e.from)) continue;
      const list = idx.get(e.from) ?? [];
      list.push({ worktree: id, colorIndex: colorIndexOf(state, id), stage: e.stage, kind: "deleted" });
      idx.set(e.from, list);
    }
  }
  fromIndexCache.set(state, idx);
  return idx;
}

function colorIndexOf(state: RepoState, id: WorktreeId): number {
  return state.worktrees.get(id)?.colorIndex ?? -1;
}

function byColor(a: Touch, b: Touch): number {
  return a.colorIndex - b.colorIndex || (a.worktree < b.worktree ? -1 : a.worktree > b.worktree ? 1 : 0);
}

function finish(path: string, ext: string, touches: Touch[], renamedFrom?: string): NodeVisual {
  touches.sort(byColor);
  const hasUncommitted = touches.some((t) => t.stage === "uncommitted");
  const v: NodeVisual = {
    path,
    ext,
    touches,
    ghost: touches.some((t) => t.stage === "uncommitted" && t.kind === "added"),
    deleted: touches.length > 0 && touches.every((t) => t.kind === "deleted"),
    tinted: !hasUncommitted && touches.some((t) => t.stage === "committed"),
  };
  if (renamedFrom !== undefined) v.renamedFrom = renamedFrom;
  return v;
}

/**
 * Visual encoding of one file path (spec §6 table):
 * - touches: one per worktree whose overlay has the path, sorted by colour index.
 *   A base path that some worktree renamed away gets a "deleted" touch from it.
 * - ghost: some worktree has it as an uncommitted add.
 * - tinted: at least one committed touch and no uncommitted touch.
 * - deleted: every touch is a deletion.
 */
export function encode(state: RepoState, path: string): NodeVisual {
  const touches: Touch[] = [];
  let renamed: { e: ChangeEntry; colorIndex: number } | null = null;
  for (const [id, entries] of state.overlays) {
    const e = entries.get(path);
    if (!e) continue;
    const colorIndex = colorIndexOf(state, id);
    touches.push({ worktree: id, colorIndex, stage: e.stage, kind: e.kind });
    if (e.kind === "renamed" && e.from && (renamed === null || colorIndex < renamed.colorIndex)) {
      renamed = { e, colorIndex };
    }
  }
  const moved = fromIndex(state).get(path);
  if (moved) {
    for (const t of moved) if (!touches.some((x) => x.worktree === t.worktree)) touches.push({ ...t });
  }
  return finish(path, extOf(path), touches, renamed?.e.from);
}

/** Rolled-up touches for a collapsed directory: one per worktree touching anything below it. */
function encodeAggregate(state: RepoState, dir: string): NodeVisual {
  const prefix = dir === "" ? "" : `${dir}/`;
  const touches: Touch[] = [];
  for (const [id, entries] of state.overlays) {
    let stage: Stage | null = null;
    for (const p of entries.keys()) {
      if (!p.startsWith(prefix)) continue;
      stage = entries.get(p)!.stage;
      if (stage === "uncommitted") break;
    }
    if (stage) touches.push({ worktree: id, colorIndex: colorIndexOf(state, id), stage, kind: "modified" });
  }
  return finish(dir, "", touches);
}

/** Visuals for every circle in a layout: files encoded, aggregates rolled up, plain dirs empty. */
export function encodeAll(state: RepoState, layout: Map<string, Circle>): Map<string, NodeVisual> {
  const out = new Map<string, NodeVisual>();
  for (const c of layout.values()) {
    if (!c.isDir) out.set(c.path, encode(state, c.path));
    else if (c.aggregate !== undefined) out.set(c.path, encodeAggregate(state, c.path));
    else out.set(c.path, finish(c.path, "", []));
  }
  return out;
}
```

- [ ] **Step 18: Run the encoding tests to verify they pass**

Run: `pnpm -C web exec vitest run src/layout/encoding.test.ts`
Expected: PASS, `Tests  11 passed (11)`.

- [ ] **Step 19: Write the failing frame test**

`web/src/layout/frame.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeState } from "./fixtures";
import { computeFrame } from "./frame";

describe("computeFrame", () => {
  const files: Record<string, number> = { "big.bin": 10_000_000, "tiny.txt": 1 };

  it("returns a visual for every circle in the layout", () => {
    const f = computeFrame(makeState(files, { w1: [{ path: "big.bin", kind: "modified", stage: "uncommitted", size: 1 }] }), 400, 400, 1);
    expect([...f.visuals.keys()]).toEqual([...f.layout.keys()]);
    expect(f.visuals.get("big.bin")!.touches).toHaveLength(1);
  });

  it("culls against on-screen radius: zooming in (scale > 1) reveals smaller files", () => {
    expect(computeFrame(makeState(files), 400, 400, 1).layout.has("tiny.txt")).toBe(false);
    expect(computeFrame(makeState(files), 400, 400, 1000).layout.has("tiny.txt")).toBe(true);
  });

  it("pads the root inside the viewport while keeping it centred", () => {
    const f = computeFrame(makeState(files), 1000, 800, 1, 48);
    const root = f.layout.get("")!;
    expect(root.x).toBeCloseTo(500);
    expect(root.y).toBeCloseTo(400);
    expect(root.r).toBeLessThanOrEqual(400 - 48);
  });

  it("never pads away more than half the viewport", () => {
    const root = computeFrame(makeState(files), 100, 100, 1, 500).layout.get("")!;
    expect(root.r).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 20: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/layout/frame.test.ts`
Expected: FAIL with `Failed to resolve import "./frame"`.

- [ ] **Step 21: Implement `computeFrame`**

`web/src/layout/frame.ts`:

```ts
import type { RepoState } from "../store";
import { encodeAll, type NodeVisual } from "./encoding";
import { buildTree } from "./nodes";
import { MIN_DIR_R, MIN_FILE_R, computeLayout, type Circle } from "./pack";

export interface Frame {
  layout: Map<string, Circle>;
  visuals: Map<string, NodeVisual>;
}

/**
 * state → layout + visuals for a viewport of width×height CSS px, viewed at
 * camera `scale` (1 = whole repo fits). Culling thresholds are on-screen
 * pixels, so they are divided by the scale. `pad` keeps the root circle that
 * far inside the viewport (room for the floating panels); the root stays
 * centred on the viewport so the identity camera still fits it.
 */
export function computeFrame(state: RepoState, width: number, height: number, scale: number, pad = 0): Frame {
  const k = Math.max(scale, 1e-6);
  const p = Math.max(0, Math.min(pad, width / 4, height / 4));
  const layout = computeLayout(buildTree(state), width - 2 * p, height - 2 * p, { minFileR: MIN_FILE_R / k, minDirR: MIN_DIR_R / k });
  if (p > 0) {
    for (const c of layout.values()) {
      c.x += p;
      c.y += p;
    }
  }
  return { layout, visuals: encodeAll(state, layout) };
}
```

- [ ] **Step 22: Run the full web check**

Run: `pnpm -C web lint && pnpm -C web test && pnpm -C web build`
Expected: lint prints `0 ERRORS 0 WARNINGS`; tests print `Test Files  7 passed (7)` and `Tests  65 passed (65)`; build prints `✓ built in`.

- [ ] **Step 23: Commit**

```bash
git add web/src/layout/pack.ts web/src/layout/pack.test.ts web/src/layout/encoding.ts web/src/layout/encoding.test.ts web/src/layout/frame.ts web/src/layout/frame.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add stable circle packing, culling and visual encoding

Children sort by name and sizes snap to quarter-octave buckets so small
edits never reshuffle the map; tiny folders collapse into aggregates
that still carry their worktrees' touches.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 24: Rebase, push and open the PR**

```bash
git fetch origin && git rebase origin/main
pnpm -C web lint && pnpm -C web test && pnpm -C web build
git push -u origin feat/web-layout
gh pr create --base main --head feat/web-layout --title "feat(web): layout, stable pack and lifecycle encoding" --body "$(cat <<'EOF'
## Summary
- `buildTree`: base ∪ overlay paths; deletions kept; rename sources shown only while base has them (encoded as moved-away outlines).
- `computeLayout`: d3 pack sorted by name with size bucketing for stability; culls sub-1.5px files and collapses sub-6px (or all-culled) folders into aggregates.
- `encode`/`encodeAll`: spec §6 table (ghost, tinted, deleted, split-ring order) plus rolled-up touches for aggregates.
- `computeFrame`: state → layout + visuals at a given zoom scale.

## Test plan
- [x] `pnpm -C web test` (65 tests, incl. stability, aggregation, rename/delete handling)
- [x] `pnpm -C web lint`, `pnpm -C web build`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 11a: Renderer core: springs, geometry, scene model

**Branch:** `feat/web-renderer-core` · **Depends on:** Task 10

Task 11 is split in two so each part gets its own review. 11a is all the pure, unit-tested logic the renderer needs: springs, picking, the zoom camera, label and ring geometry, and the lifecycle state machine. 11b is the thin PixiJS binding. The Task Graph's single `feat/web-renderer` branch becomes `feat/web-renderer-core` (11a) and then `feat/web-renderer` (11b, branched from `main` after 11a merges).

**Files:**
- Create: `web/src/render/springs.ts`, `web/src/render/geometry.ts`, `web/src/render/scene.ts`
- Test: `web/src/render/springs.test.ts`, `web/src/render/geometry.test.ts`, `web/src/render/scene.test.ts`

**Interfaces:**
- Consumes: `Circle` (`layout/pack.ts`), `NodeVisual` (`layout/encoding.ts`), `Change` (`store.ts`).
- Produces (all additions; internal to `render/` and the app shell):
  - `springs.ts`: `interface Spring { value; velocity; target }`, `SPRING_OMEGA = 20`, `makeSpring(value, target?)`, `retarget(s, target)`, `stepSpring(s, dtSec, omega?)`, `isSettled(s, eps?)`.
  - `geometry.ts`:
    - `pick(layout, x, y): string | null`
    - `parentDir(path): string`
    - `interface Camera { cx; cy; k }`, `fitCamera(c: Circle, width, height): Camera`, `worldToScreen(cam, w, h, x, y)`, `screenToWorld(cam, w, h, x, y)`
    - `arcLetterAngles(widths, radius): number[]`, `fitLabel(widths, radius, maxSpan, ellipsisWidth): number`
    - `splitSegments(n, gap): [number, number][]`, `dashArcs(radius, dash, gap, a0, a1): [number, number][]`
    - `interface Glide { fromX; fromY; toX; toY }`, `glideOffset(g, x, y)`
    - `clickTarget(path, layout, current): string`, `labelNames(layout): Map<string, string>`
  - `scene.ts`: `DELETED_SCALE = 0.85`, `SHIMMER_MS = 600`, `interface SceneNode`, `class Scene { nodes; get(path); update(layout, visuals, change, now); step(dtMs, now): boolean; drawPosition(n); shimmer(n, now): number | null }`.

**Design notes:**
- **Springs** are critically damped and stepped with the exact closed-form solution, so any `dt` is stable and frame-rate independent. With ω = 20 rad/s, a move from rest is within 2% of its target after 300 ms and never overshoots.
- **Camera.**
  - The camera is `{cx, cy, k}`: the world point at the viewport centre, and the scale. Fitting the root always gives the identity (`k = 1`), so "zoom out" returns to the unscaled layout exactly.
  - Any other circle is fitted to 90% of the viewport's short side, with `k` capped at 1000.
  - The renderer springs `log k`, so zooming by 50× feels as even as zooming by 2×.
- **Picking** runs in JS over the layout map, not Pixi hit-testing. The deepest circle containing the point wins; ties go to the smaller radius.
- **Scene lifecycle.**
  - New nodes grow from r = 0.
  - A node whose `renamedFrom` source is on screen starts at the source's current position and radius, then glides to its target on an arc: the sideways bow is `sin(πp)·15%` of the travel distance.
  - Nodes missing from the layout shrink and fade out, then are dropped.
  - Deleted files shrink to 0.85 r.
  - `change.merged` paths shimmer for 600 ms.
  - `step()` returns `false` once everything is at rest, which lets the renderer stop its ticker. This is important for an ambient dashboard.
- **Folder labels.** `labelNames` compresses single-folder chains (`web` › `src` becomes one label, "web/src", on the inner circle) because nested rims nearly coincide and their labels would overprint.
- **Clicks.**
  - Clicking a folder zooms into it.
  - Clicking a file zooms to its folder.
  - Clicking the folder already in view steps out one level.
  - Clicking outside the repo circle returns to the root.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-web-renderer-core -b feat/web-renderer-core main
cd .claude/worktrees/feat-web-renderer-core
pnpm -C web install --frozen-lockfile
```

- [ ] **Step 2: Write the failing spring test**

`web/src/render/springs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SPRING_OMEGA, isSettled, makeSpring, retarget, stepSpring } from "./springs";

function run(s: ReturnType<typeof makeSpring>, ms: number, frameMs = 1000 / 60): number[] {
  const trace: number[] = [];
  for (let t = 0; t < ms; t += frameMs) {
    stepSpring(s, frameMs / 1000);
    trace.push(s.value);
  }
  return trace;
}

describe("springs", () => {
  it("settles within ~300ms from rest (critically damped)", () => {
    const s = makeSpring(0, 100);
    run(s, 300);
    expect(Math.abs(100 - s.value)).toBeLessThan(2);
    run(s, 400);
    expect(isSettled(s)).toBe(true);
    expect(s.value).toBe(100);
    expect(s.velocity).toBe(0);
  });

  it("never overshoots when starting from rest", () => {
    const s = makeSpring(0, 100);
    const trace = run(s, 1000);
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]!).toBeGreaterThanOrEqual(trace[i - 1]!);
      expect(trace[i]!).toBeLessThanOrEqual(100);
    }
  });

  it("is frame-rate independent (exact solution per step)", () => {
    const a = makeSpring(0, 50);
    const b = makeSpring(0, 50);
    stepSpring(a, 0.12);
    for (let i = 0; i < 12; i++) stepSpring(b, 0.01);
    expect(a.value).toBeCloseTo(b.value, 9);
    expect(a.velocity).toBeCloseTo(b.velocity, 9);
  });

  it("keeps velocity when retargeted mid-flight", () => {
    const s = makeSpring(0, 100);
    stepSpring(s, 0.05);
    const v = s.velocity;
    retarget(s, -100);
    expect(s.velocity).toBe(v);
    expect(s.target).toBe(-100);
    expect(isSettled(s)).toBe(false);
  });

  it("stays put when already at target", () => {
    const s = makeSpring(7);
    stepSpring(s, 1);
    expect(s.value).toBe(7);
    expect(isSettled(s)).toBe(true);
  });

  it("exposes the tuning constant", () => {
    expect(SPRING_OMEGA).toBe(20);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/render/springs.test.ts`
Expected: FAIL with `Failed to resolve import "./springs"`.

- [ ] **Step 4: Implement the springs**

`web/src/render/springs.ts`:

```ts
/**
 * Critically damped springs, stepped with the exact closed-form solution so
 * they are stable and frame-rate independent for any dt:
 *   x(t) = (x0 + (v0 + ω·x0)·t)·e^(−ωt),  x = value − target
 * With ω = 20 rad/s a move from rest is within 2% of its target after 300 ms.
 */
export const SPRING_OMEGA = 20;
const EPS = 0.01;

export interface Spring {
  value: number;
  velocity: number;
  target: number;
}

export function makeSpring(value: number, target: number = value): Spring {
  return { value, velocity: 0, target };
}

export function retarget(s: Spring, target: number): void {
  s.target = target;
}

export function isSettled(s: Spring, eps: number = EPS): boolean {
  return Math.abs(s.value - s.target) < eps && Math.abs(s.velocity) < eps * 10;
}

export function stepSpring(s: Spring, dtSec: number, omega: number = SPRING_OMEGA): void {
  if (s.value === s.target && s.velocity === 0) return;
  const x = s.value - s.target;
  const e = Math.exp(-omega * dtSec);
  const c = s.velocity + omega * x;
  s.value = s.target + (x + c * dtSec) * e;
  s.velocity = (s.velocity - omega * c * dtSec) * e;
  if (isSettled(s)) {
    s.value = s.target;
    s.velocity = 0;
  }
}
```

- [ ] **Step 5: Run the spring tests to verify they pass**

Run: `pnpm -C web exec vitest run src/render/springs.test.ts`
Expected: PASS, `Tests  6 passed (6)`.

- [ ] **Step 6: Write the failing geometry test**

`web/src/render/geometry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Circle } from "../layout/pack";
import {
  arcLetterAngles,
  clickTarget,
  dashArcs,
  fitCamera,
  fitLabel,
  glideOffset,
  labelNames,
  parentDir,
  pick,
  screenToWorld,
  splitSegments,
  worldToScreen,
} from "./geometry";

const c = (path: string, x: number, y: number, r: number, depth: number, isDir = true): Circle => ({ path, x, y, r, depth, isDir });

describe("pick", () => {
  const layout = new Map<string, Circle>([
    ["", c("", 100, 100, 100, 0)],
    ["src", c("src", 80, 100, 50, 1)],
    ["src/a.ts", c("src/a.ts", 70, 100, 10, 2, false)],
    ["docs", c("docs", 160, 100, 30, 1)],
  ]);

  it("returns the deepest circle containing the point", () => {
    expect(pick(layout, 72, 102)).toBe("src/a.ts");
    expect(pick(layout, 110, 100)).toBe("src");
    expect(pick(layout, 160, 100)).toBe("docs");
    expect(pick(layout, 100, 190)).toBe("");
  });

  it("returns null outside the root", () => {
    expect(pick(layout, 0, 0)).toBeNull();
  });

  it("prefers the smaller circle when depths tie", () => {
    const l = new Map<string, Circle>([
      ["a", c("a", 0, 0, 10, 1)],
      ["b", c("b", 1, 0, 5, 1)],
    ]);
    expect(pick(l, 1, 0)).toBe("b");
  });
});

describe("camera", () => {
  it("fits the root to identity", () => {
    expect(fitCamera(c("", 500, 400, 397, 0), 1000, 800)).toEqual({ cx: 500, cy: 400, k: 1 });
  });

  it("fits a circle to 90% of the short side, centred", () => {
    const cam = fitCamera(c("src", 300, 200, 40, 1), 1000, 800);
    expect(cam.cx).toBe(300);
    expect(cam.cy).toBe(200);
    expect(cam.k).toBeCloseTo((800 * 0.9) / 80);
  });

  it("caps the zoom factor", () => {
    expect(fitCamera(c("x", 0, 0, 0.001, 3), 1000, 800).k).toBe(1000);
  });

  it("round-trips screen ↔ world", () => {
    const cam = { cx: 300, cy: 200, k: 4 };
    const s = worldToScreen(cam, 1000, 800, 310, 190);
    expect(s).toEqual({ x: 540, y: 360 });
    expect(screenToWorld(cam, 1000, 800, s.x, s.y)).toEqual({ x: 310, y: 190 });
  });
});

describe("labels", () => {
  it("centres glyphs on the top of the circle, left to right", () => {
    const a = arcLetterAngles([10, 10, 10], 100);
    expect(a).toHaveLength(3);
    expect(a[1]).toBeCloseTo(-Math.PI / 2);
    expect(a[0]).toBeCloseTo(-Math.PI / 2 - 0.1);
    expect(a[2]).toBeCloseTo(-Math.PI / 2 + 0.1);
  });

  it("keeps all glyphs when the label fits, else truncates to leave room for an ellipsis", () => {
    expect(fitLabel([10, 10, 10], 100, 1, 5)).toBe(3);
    expect(fitLabel([10, 10, 10, 10, 10], 20, 1.5, 5)).toBe(2);
    expect(fitLabel([10, 10], 1, 1, 5)).toBe(0);
  });
});

describe("rings", () => {
  it("splits a full ring into equal segments starting at 12 o'clock with gaps", () => {
    expect(splitSegments(1, 0.1)).toEqual([[-Math.PI / 2, (3 * Math.PI) / 2]]);
    const s = splitSegments(2, 0.1);
    expect(s[0]![0]).toBeCloseTo(-Math.PI / 2 + 0.05);
    expect(s[0]![1]).toBeCloseTo(Math.PI / 2 - 0.05);
    expect(s[1]![0]).toBeCloseTo(Math.PI / 2 + 0.05);
  });

  it("covers an arc with dashes of the requested length", () => {
    const d = dashArcs(10, 4, 3, 0, Math.PI);
    expect(d.length).toBe(Math.ceil((Math.PI * 10) / 7));
    expect(d[0]![1] - d[0]![0]).toBeCloseTo(0.4);
    expect(d[1]![0]).toBeCloseTo(0.7);
    for (const [a0, a1] of d) {
      expect(a0).toBeLessThan(a1);
      expect(a1).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });
});

describe("glideOffset", () => {
  it("is zero at the start and end, and bows sideways mid-way", () => {
    const g = { fromX: 0, fromY: 0, toX: 100, toY: 0 };
    const start = glideOffset(g, 0, 0);
    expect(start.x).toBeCloseTo(0);
    expect(start.y).toBeCloseTo(0);
    expect(glideOffset(g, 100, 0).y).toBeCloseTo(0);
    const mid = glideOffset(g, 50, 0);
    expect(Math.abs(mid.y)).toBeCloseTo(15);
    expect(mid.x).toBeCloseTo(0);
  });
});

describe("parentDir", () => {
  it("returns the containing directory ('' at the top level)", () => {
    expect(parentDir("src/lib/a.ts")).toBe("src/lib");
    expect(parentDir("a.ts")).toBe("");
    expect(parentDir("")).toBe("");
  });
});

describe("clickTarget", () => {
  const layout = new Map<string, Circle>([
    ["", c("", 0, 0, 100, 0)],
    ["src", c("src", 0, 0, 50, 1)],
    ["src/lib", c("src/lib", 0, 0, 20, 2)],
    ["src/lib/a.ts", c("src/lib/a.ts", 0, 0, 5, 3, false)],
  ]);

  it("zooms into folders and to a file's folder", () => {
    expect(clickTarget("src", layout, "")).toBe("src");
    expect(clickTarget("src/lib/a.ts", layout, "")).toBe("src/lib");
  });

  it("steps out one level when the folder in view is clicked", () => {
    expect(clickTarget("src/lib", layout, "src/lib")).toBe("src");
    expect(clickTarget("", layout, "")).toBe("");
  });

  it("returns to the root for background clicks and unknown paths", () => {
    expect(clickTarget(null, layout, "src")).toBe("");
    expect(clickTarget("gone", layout, "src")).toBe("");
  });
});

describe("labelNames", () => {
  it("labels folders by name, skipping the root and collapsed folders", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 100, 0)],
      ["src", c("src", 0, 0, 50, 1)],
      ["src/a.ts", c("src/a.ts", 0, 0, 5, 2, false)],
      ["vendor", { ...c("vendor", 0, 0, 4, 1), aggregate: 12 }],
    ]);
    expect([...labelNames(l)]).toEqual([["src", "src"]]);
  });

  it("compresses single-folder chains onto the innermost folder", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 100, 0)],
      ["web", c("web", 0, 0, 50, 1)],
      ["web/src", c("web/src", 0, 0, 47, 2)],
      ["web/src/ui", c("web/src/ui", 0, 0, 44, 3)],
      ["web/src/ui/a.ts", c("web/src/ui/a.ts", 0, 0, 5, 4, false)],
      ["web/src/ui/b.ts", c("web/src/ui/b.ts", 0, 0, 5, 4, false)],
    ]);
    expect([...labelNames(l)]).toEqual([["web/src/ui", "web/src/ui"]]);
  });

  it("keeps a parent's label when its only child is a collapsed folder", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 100, 0)],
      ["lib", c("lib", 0, 0, 50, 1)],
      ["lib/deep", { ...c("lib/deep", 0, 0, 5, 2), aggregate: 3 }],
    ]);
    expect(labelNames(l).get("lib")).toBe("lib");
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/render/geometry.test.ts`
Expected: FAIL with `Failed to resolve import "./geometry"`.

- [ ] **Step 8: Implement the geometry**

`web/src/render/geometry.ts`:

```ts
import type { Circle } from "../layout/pack";

// ---- picking -------------------------------------------------------------

/** Deepest circle containing (x, y) in world coordinates; ties → smaller radius. O(n), no Pixi hit-testing. */
export function pick(layout: Map<string, Circle>, x: number, y: number): string | null {
  let best: Circle | null = null;
  for (const c of layout.values()) {
    const dx = x - c.x;
    const dy = y - c.y;
    if (dx * dx + dy * dy > c.r * c.r) continue;
    if (best === null || c.depth > best.depth || (c.depth === best.depth && c.r < best.r)) best = c;
  }
  return best ? best.path : null;
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// ---- camera --------------------------------------------------------------

/** World point shown at the viewport centre, and scale. Identity = {w/2, h/2, 1}. */
export interface Camera {
  cx: number;
  cy: number;
  k: number;
}

const MAX_ZOOM = 1000;
const FIT = 0.9;

export function fitCamera(c: Circle, width: number, height: number): Camera {
  if (c.depth === 0) return { cx: width / 2, cy: height / 2, k: 1 };
  const k = Math.min(MAX_ZOOM, (Math.min(width, height) * FIT) / (2 * Math.max(c.r, 1e-9)));
  return { cx: c.x, cy: c.y, k };
}

export function worldToScreen(cam: Camera, width: number, height: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - cam.cx) * cam.k + width / 2, y: (y - cam.cy) * cam.k + height / 2 };
}

export function screenToWorld(cam: Camera, width: number, height: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - width / 2) / cam.k + cam.cx, y: (y - height / 2) / cam.k + cam.cy };
}

// ---- folder labels along the top arc ------------------------------------

/**
 * Centre angle of each glyph when a label is set along the top of a circle of
 * `radius`, reading left to right (y points down, so −π/2 is 12 o'clock).
 */
export function arcLetterAngles(widths: number[], radius: number): number[] {
  const total = widths.reduce((a, b) => a + b, 0);
  let angle = -Math.PI / 2 - total / radius / 2;
  return widths.map((w) => {
    const center = angle + w / radius / 2;
    angle += w / radius;
    return center;
  });
}

/** How many leading glyphs fit within `maxSpan` radians; if truncated, room is left for an ellipsis. */
export function fitLabel(widths: number[], radius: number, maxSpan: number, ellipsisWidth: number): number {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total / radius <= maxSpan) return widths.length;
  let used = ellipsisWidth;
  let n = 0;
  for (const w of widths) {
    if ((used + w) / radius > maxSpan) break;
    used += w;
    n++;
  }
  return n;
}

// ---- rings ---------------------------------------------------------------

/** One arc per worktree for a split ring, clockwise from 12 o'clock, `gap` radians between. */
export function splitSegments(n: number, gap: number): [number, number][] {
  const start = -Math.PI / 2;
  if (n <= 1) return [[start, start + Math.PI * 2]];
  const span = (Math.PI * 2) / n;
  return Array.from({ length: n }, (_, i) => [start + i * span + gap / 2, start + (i + 1) * span - gap / 2]);
}

/** Dash arcs of `dash` px separated by `gap` px (arc length) between angles a0..a1. */
export function dashArcs(radius: number, dash: number, gap: number, a0: number, a1: number): [number, number][] {
  const out: [number, number][] = [];
  if (radius <= 0) return out;
  const d = dash / radius;
  const step = (dash + gap) / radius;
  for (let a = a0; a < a1 - 1e-9; a += step) out.push([a, Math.min(a + d, a1)]);
  return out;
}

// ---- rename glide --------------------------------------------------------

export interface Glide {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

/**
 * Sideways offset that bends a straight spring path into a gentle arc: zero at
 * both ends, 15% of the travel distance at the midpoint, on the left of the
 * direction of travel. Progress is measured from the current position.
 */
export function glideOffset(g: Glide, x: number, y: number): { x: number; y: number } {
  const dx = g.toX - g.fromX;
  const dy = g.toY - g.fromY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { x: 0, y: 0 };
  const along = ((x - g.fromX) * dx + (y - g.fromY) * dy) / (dist * dist);
  const p = Math.min(1, Math.max(0, along));
  const bow = Math.sin(Math.PI * p) * 0.15 * dist;
  return { x: (dy / dist) * bow, y: (-dx / dist) * bow };
}

// ---- click-to-zoom -------------------------------------------------------

/**
 * Where a click should zoom to: a folder (or collapsed folder) zooms into
 * itself; a file zooms to its folder; clicking the folder already in view
 * steps out one level; clicking outside the repo returns to the root.
 */
export function clickTarget(path: string | null, layout: Map<string, Circle>, current: string): string {
  if (path === null) return "";
  if (path === current) return parentDir(current);
  const c = layout.get(path);
  if (!c) return "";
  return c.isDir ? path : parentDir(path);
}

// ---- label text ----------------------------------------------------------

/**
 * Folder label text per labelled directory. A folder whose only visible
 * child is another folder would draw its name on top of the child's (their
 * rims nearly coincide), so such chains are compressed: `web` › `src` is
 * labelled once, on the inner circle, as "web/src". The root and collapsed
 * (aggregate) folders get no label.
 */
export function labelNames(layout: Map<string, Circle>): Map<string, string> {
  const kids = new Map<string, Circle[]>();
  for (const c of layout.values()) {
    if (c.depth === 0) continue;
    const p = parentDir(c.path);
    const list = kids.get(p);
    if (list) list.push(c);
    else kids.set(p, [c]);
  }
  const passThrough = (path: string): boolean => {
    const k = kids.get(path);
    return k !== undefined && k.length === 1 && k[0]!.isDir && k[0]!.aggregate === undefined;
  };
  const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
  const out = new Map<string, string>();
  for (const c of layout.values()) {
    if (!c.isDir || c.depth === 0 || c.aggregate !== undefined || passThrough(c.path)) continue;
    let name = base(c.path);
    let p = parentDir(c.path);
    while (p !== "" && passThrough(p)) {
      name = `${base(p)}/${name}`;
      p = parentDir(p);
    }
    out.set(c.path, name);
  }
  return out;
}
```

- [ ] **Step 9: Run the geometry tests to verify they pass**

Run: `pnpm -C web exec vitest run src/render/geometry.test.ts`
Expected: PASS, `Tests  19 passed (19)`.

- [ ] **Step 10: Commit**

```bash
git add web/src/render/springs.ts web/src/render/springs.test.ts web/src/render/geometry.ts web/src/render/geometry.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add springs, picking, camera and label/ring geometry

Pure math for the renderer so it can be unit-tested without WebGL.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Write the failing scene test**

`web/src/render/scene.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { NodeVisual } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import type { Change } from "../store";
import { DELETED_SCALE, SHIMMER_MS, Scene } from "./scene";

const circle = (path: string, x: number, y: number, r: number, isDir = false): Circle => ({ path, x, y, r, depth: path.split("/").length, isDir });
const visual = (path: string, over: Partial<NodeVisual> = {}): NodeVisual => ({
  path, ext: "ts", touches: [], ghost: false, deleted: false, tinted: false, ...over,
});
const patch: Change = { kind: "patch", merged: [] };

function frame(circles: Circle[], visuals: NodeVisual[] = []): [Map<string, Circle>, Map<string, NodeVisual>] {
  const v = new Map(visuals.map((x) => [x.path, x]));
  for (const c of circles) if (!v.has(c.path)) v.set(c.path, visual(c.path));
  return [new Map(circles.map((c) => [c.path, c])), v];
}

function settle(scene: Scene, ms: number, start = 0): number {
  let now = start;
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    scene.step(16, now);
  }
  return now;
}

describe("Scene", () => {
  it("grows new nodes from r=0 at their target position", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 10, 20, 8)]), patch, 0);
    const n = s.get("a.ts")!;
    expect(n.x.value).toBe(10);
    expect(n.y.value).toBe(20);
    expect(n.r.value).toBe(0);
    expect(n.r.target).toBe(8);
    settle(s, 700);
    expect(n.r.value).toBe(8);
  });

  it("springs existing nodes to their new layout position", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([circle("a.ts", 100, 0, 8)]), patch, 700);
    s.step(16, 716);
    const n = s.get("a.ts")!;
    expect(n.x.value).toBeGreaterThan(0);
    expect(n.x.value).toBeLessThan(100);
    settle(s, 700, 716);
    expect(n.x.value).toBe(100);
  });

  it("shrinks removed nodes out and then forgets them", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([]), patch, 700);
    expect(s.get("a.ts")!.leaving).toBe(true);
    expect(s.get("a.ts")!.r.target).toBe(0);
    settle(s, 1000, 700);
    expect(s.get("a.ts")).toBeUndefined();
  });

  it("revives a leaving node that comes back", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([]), patch, 700);
    s.step(16, 716);
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 716);
    expect(s.get("a.ts")!.leaving).toBe(false);
    expect(s.get("a.ts")!.r.target).toBe(8);
  });

  it("shrinks deleted files to a smaller outline radius", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 10)], [visual("a.ts", { deleted: true })]), patch, 0);
    expect(s.get("a.ts")!.r.target).toBeCloseTo(10 * DELETED_SCALE);
  });

  it("starts a renamed node at the old node's position and glides along an arc", () => {
    const s = new Scene();
    s.update(...frame([circle("old.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([circle("new.ts", 100, 0, 8)], [visual("new.ts", { renamedFrom: "old.ts" })]), patch, 700);
    const n = s.get("new.ts")!;
    expect(n.x.value).toBe(0);
    expect(n.r.value).toBe(8);
    expect(n.glide).toEqual({ fromX: 0, fromY: 0, toX: 100, toY: 0 });
    let now = 700;
    while (n.x.value < 45) {
      now += 16;
      s.step(16, now);
    }
    expect(Math.abs(s.drawPosition(n).y)).toBeGreaterThan(5);
    settle(s, 800, now);
    expect(s.drawPosition(n)).toEqual({ x: 100, y: 0 });
    expect(n.glide).toBeNull();
  });

  it("falls back to growing when the rename source was never on screen", () => {
    const s = new Scene();
    s.update(...frame([circle("new.ts", 100, 0, 8)], [visual("new.ts", { renamedFrom: "culled.ts" })]), patch, 0);
    expect(s.get("new.ts")!.r.value).toBe(0);
    expect(s.get("new.ts")!.glide).toBeNull();
  });

  it("shimmers merged paths for SHIMMER_MS", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([circle("a.ts", 0, 0, 8)]), { kind: "patch", merged: ["a.ts", "not-drawn.ts"] }, 1000);
    expect(s.shimmer(s.get("a.ts")!, 1000)).toBe(0);
    expect(s.shimmer(s.get("a.ts")!, 1000 + SHIMMER_MS / 2)).toBeCloseTo(0.5);
    expect(s.step(16, 1000 + SHIMMER_MS / 2)).toBe(true);
    expect(s.step(16, 1000 + SHIMMER_MS + 1)).toBe(false);
    expect(s.shimmer(s.get("a.ts")!, 1000 + SHIMMER_MS + 1)).toBeNull();
  });

  it("reports idle once everything has settled", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    expect(s.step(16, 16)).toBe(true);
    settle(s, 700, 16);
    expect(s.step(16, 800)).toBe(false);
  });

  it("keeps layout order for iteration (parents before children)", () => {
    const s = new Scene();
    s.update(...frame([circle("", 0, 0, 100, true), circle("src", 0, 0, 50, true), circle("src/a.ts", 0, 0, 5)]), patch, 0);
    expect([...s.nodes.keys()]).toEqual(["", "src", "src/a.ts"]);
  });
});
```

- [ ] **Step 12: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/render/scene.test.ts`
Expected: FAIL with `Failed to resolve import "./scene"`.

- [ ] **Step 13: Implement the scene model**

`web/src/render/scene.ts`:

```ts
import type { NodeVisual } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import type { Change } from "../store";
import { glideOffset, type Glide } from "./geometry";
import { isSettled, makeSpring, retarget, stepSpring, type Spring } from "./springs";

export const DELETED_SCALE = 0.85;
export const SHIMMER_MS = 600;

export interface SceneNode {
  path: string;
  isDir: boolean;
  depth: number;
  aggregate?: number;
  visual: NodeVisual;
  x: Spring;
  y: Spring;
  r: Spring;
  alpha: Spring;
  leaving: boolean;
  glide: Glide | null;
  shimmerAt: number | null;
}

/**
 * Renderer-independent animation state: one node per visible circle, keyed by
 * path. Pure TypeScript so lifecycle behaviour is unit-tested without WebGL.
 *
 * - New nodes grow from r=0 at their target position.
 * - A node with `renamedFrom` whose source node is on screen starts at the
 *   source's current position/radius and glides (on an arc) to its target.
 * - Nodes missing from the layout shrink and fade out, then are dropped.
 * - Deleted files shrink to DELETED_SCALE × r (drawn as faint outlines).
 * - Paths in change.merged shimmer for SHIMMER_MS.
 */
export class Scene {
  readonly nodes = new Map<string, SceneNode>();

  get(path: string): SceneNode | undefined {
    return this.nodes.get(path);
  }

  update(layout: Map<string, Circle>, visuals: Map<string, NodeVisual>, change: Change, now: number): void {
    const next = new Map<string, SceneNode>();
    for (const c of layout.values()) {
      const visual = visuals.get(c.path) ?? { path: c.path, ext: "", touches: [], ghost: false, deleted: false, tinted: false };
      const r = c.isDir ? c.r : visual.deleted ? c.r * DELETED_SCALE : c.r;
      let n = this.nodes.get(c.path);
      if (n) {
        retarget(n.x, c.x);
        retarget(n.y, c.y);
        retarget(n.r, r);
        retarget(n.alpha, 1);
        n.leaving = false;
        if (n.glide) n.glide = { ...n.glide, toX: c.x, toY: c.y };
      } else {
        const src = visual.renamedFrom ? this.nodes.get(visual.renamedFrom) : undefined;
        if (src) {
          n = this.#make(c, visual, src.x.value, src.y.value, src.r.value);
          retarget(n.r, r);
          n.glide = { fromX: src.x.value, fromY: src.y.value, toX: c.x, toY: c.y };
        } else {
          n = this.#make(c, visual, c.x, c.y, 0);
          retarget(n.r, r);
        }
      }
      n.visual = visual;
      n.isDir = c.isDir;
      n.depth = c.depth;
      if (c.aggregate !== undefined) n.aggregate = c.aggregate;
      else delete n.aggregate;
      next.set(c.path, n);
    }
    // Leaving nodes keep animating after the live ones (drawn on top of nothing new).
    for (const [path, n] of this.nodes) {
      if (next.has(path)) continue;
      n.leaving = true;
      retarget(n.r, 0);
      retarget(n.alpha, 0);
      next.set(path, n);
    }
    this.nodes.clear();
    for (const [k, v] of next) this.nodes.set(k, v);

    for (const path of change.merged) {
      const n = this.nodes.get(path);
      if (n && !n.leaving) n.shimmerAt = now;
    }
  }

  /** Advance all springs by dtMs. Returns true while anything is still moving. */
  step(dtMs: number, now: number): boolean {
    const dt = Math.min(dtMs, 64) / 1000;
    let busy = false;
    for (const [path, n] of this.nodes) {
      stepSpring(n.x, dt);
      stepSpring(n.y, dt);
      stepSpring(n.r, dt);
      stepSpring(n.alpha, dt);
      const moving = !isSettled(n.x) || !isSettled(n.y) || !isSettled(n.r) || !isSettled(n.alpha);
      if (n.glide && !moving) n.glide = null;
      if (n.shimmerAt !== null && now - n.shimmerAt > SHIMMER_MS) n.shimmerAt = null;
      if (n.leaving && !moving) {
        this.nodes.delete(path);
        continue;
      }
      if (moving || n.shimmerAt !== null) busy = true;
    }
    return busy;
  }

  /** Current draw position, including the sideways bow of a rename glide. */
  drawPosition(n: SceneNode): { x: number; y: number } {
    if (!n.glide) return { x: n.x.value, y: n.y.value };
    const o = glideOffset(n.glide, n.x.value, n.y.value);
    return { x: n.x.value + o.x, y: n.y.value + o.y };
  }

  /** Shimmer progress 0..1, or null when not shimmering. */
  shimmer(n: SceneNode, now: number): number | null {
    if (n.shimmerAt === null) return null;
    const p = (now - n.shimmerAt) / SHIMMER_MS;
    return p > 1 ? null : Math.max(0, p);
  }

  #make(c: Circle, visual: NodeVisual, x: number, y: number, r: number): SceneNode {
    return {
      path: c.path,
      isDir: c.isDir,
      depth: c.depth,
      visual,
      x: makeSpring(x, c.x),
      y: makeSpring(y, c.y),
      r: makeSpring(r),
      alpha: makeSpring(1),
      leaving: false,
      glide: null,
      shimmerAt: null,
    };
  }
}
```

- [ ] **Step 14: Run the full web check**

Run: `pnpm -C web lint && pnpm -C web test && pnpm -C web build`
Expected: lint prints `0 ERRORS 0 WARNINGS`; tests print `Test Files  10 passed (10)` and `Tests  100 passed (100)`; build prints `✓ built in`.

- [ ] **Step 15: Commit**

```bash
git add web/src/render/scene.ts web/src/render/scene.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add scene model for grow, shrink, glide and shimmer

Renderer-independent lifecycle state keyed by path, stepped by springs
and reporting when the scene is at rest.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 16: Rebase, push and open the PR**

```bash
git fetch origin && git rebase origin/main
pnpm -C web lint && pnpm -C web test && pnpm -C web build
git push -u origin feat/web-renderer-core
gh pr create --base main --head feat/web-renderer-core --title "feat(web): renderer core (springs, geometry, scene)" --body "$(cat <<'EOF'
## Summary
- Critically damped springs (exact solution, ~300 ms settle, no overshoot).
- JS picking (deepest wins), fit-to-circle camera, click-to-zoom targets, folder-label layout along the top arc, split/dashed ring arcs, rename glide arc.
- `Scene`: grow-in, shrink-out, deleted outline radius, rename glide from the old node, 600 ms merge shimmer, idle detection.

## Test plan
- [x] `pnpm -C web test` (100 tests)
- [x] `pnpm -C web lint`, `pnpm -C web build`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 11b: PixiJS map renderer

**Branch:** `feat/web-renderer` · **Depends on:** Task 11a

**Files:**
- Create: `web/src/render/sprites.ts`, `web/src/render/MapRenderer.ts`
- Modify: `web/src/ui/App.svelte` (replace the Task 9 placeholder with the live map)
- Test: `web/src/render/MapRenderer.test.ts` (pre-init contract only; see below)

**Interfaces:**
- Consumes: everything Task 11a produces; `computeFrame` (`layout/frame.ts`); `colorForExt`, `worktreeColor`, `lighten`, `hexToNumber`, `ExtColor` (`colors.ts`); `connect` and `RepoStore` (Task 9).
- Produces:
  - `MapRenderer` exactly as in Shared Interfaces, plus the additions:
    - `onZoom(fn: (scale: number) => void): void`. It fires with the camera's **target** scale when a zoom starts, so the app can re-cull at that scale.
    - `export type Theme = "vision" | "night"`.
  - `sprites.ts`: `class TextureBank { disc; halo; sphere(c: ExtColor); worktreeSphere(hex); destroy() }`, `HALO_RING_FRAC`, `renderArcLabel(text, screenR, color, dpr): ArcLabel | null`.
  - `App.svelte` with `data-testid="map"` on the element that hosts the Pixi `<canvas>` (Task 14 relies on this).

**Design notes (PixiJS v8.21 APIs, all checked by `svelte-check`):**
- **Application setup.** `await app.init({ resizeTo: host, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: min(dpr, 2), preference: "webgl" })`, then `host.appendChild(app.canvas)`.
  - The canvas is transparent: the page background (CSS tokens in Task 12) supplies the Vision radial gradient or Night black.
- **Textures and sprites.**
  - Sphere gradients are pre-rendered per extension group and per worktree colour. Each is a 256 px canvas with a radial gradient centred at (35%, 30%) with radius 50%, exactly like the mockup's `<radialGradient cx="35%" cy="30%">`, loaded with `Texture.from(canvas, true)`, skipping the Pixi cache because the bank owns the textures' lifetimes.
  - The halo is a soft white ring texture, tinted per worktree.
  - Every file is a `Sprite` scaled to its radius, so a frame is mostly transform updates.
- **Vector parts.** Dashed rings, split rings, ghost fills and folder outlines are `Graphics` built with `moveTo(...).arc(...)` followed by one `stroke({ color, width, alpha })`. They are redrawn only when a key changes: the quantised on-screen radius, the zoom bucket, the style generation or the touch signature. Stroke widths are divided by the camera scale, so rings stay hairline at every zoom.
- **Folder labels.** Pixi has no text-on-path, so each glyph is measured and drawn rotated into a cropped 2D canvas using `arcLetterAngles`, then uploaded once as a texture and cached per folder. A label is re-rendered only when the folder's on-screen radius changes 12 px bucket while the camera is at rest, and it is hidden while the folder grows or shrinks so it never balloons.
- **Idle ticker.** The ticker stops after three idle frames, and every mutating call (`update`, `setTheme`, `isolate`, `highlight`, `zoomTo`) wakes it. A dashboard left open costs about 0% GPU when nothing changes.
- **Visual encoding (spec §6).**

  | Situation | Vision | Night |
  |---|---|---|
  | Idle file | gradient sphere of the file-type group | flat `#3a3a44` disc |
  | Uncommitted modified or renamed | normal fill, halo in the worktree colour (α .6), dashed ring (4/3 px) 2.5 px outside | worktree-colour disc, halo (α .5), dashed ring |
  | Uncommitted added (ghost) | 15% fill in the worktree colour, dashed outline (2/2 px) | dashed outline only |
  | Committed on branch (tinted) | sphere shaded in the worktree colour (α .9), thin solid ring | worktree-colour disc (α .85), solid ring |
  | Deleted | hidden fill, faint outline in the worktree colour (α .45) at 0.85 r | same |
  | 2+ worktrees | one ring arc per touch, clockwise from 12 o'clock in colour-index order, with 3 px gaps; each arc is dashed if uncommitted, solid if committed | same |
  | Merged | 600 ms white flash (`sin(πp)·.55`), growing 25% | same |
  | Isolate | other worktrees' halo, rings and ghost fill drop to α .15, and tinted files show their file-type colour | same |
  | Highlight | 2 px white ring 5 px outside the node | same |
  | Folder | fill white α .03 (root .02), stroke α .12 (root .16) | no fill, stroke α .08 (root .10) |
  | Aggregate | fill white α .07 + stroke .14, plus rolled-up halo and rings | fill α .05 |

- **Testing.** jsdom has no WebGL, so `init()` cannot run under Vitest. `MapRenderer.test.ts` pins the pre-init contract the Svelte app relies on (zoom target scales, safe destroy before init). Drawing is verified visually by the Task 14 Playwright smoke test and screenshots. While writing this plan, the renderer was checked by hand in Chromium against a synthetic snapshot for: the Vision and Night palettes (Night idle pixels are exactly `#3a3a44`), halo, ghost, split ring, rename glide, merge, zoom, isolate, highlight and arc labels.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-web-renderer -b feat/web-renderer main
cd .claude/worktrees/feat-web-renderer
pnpm -C web install --frozen-lockfile
```

- [ ] **Step 2: Write the failing renderer contract test**

`web/src/render/MapRenderer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { NodeVisual } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import { MapRenderer } from "./MapRenderer";

// jsdom has no WebGL, so init() is not called here. Drawing is verified by the
// Playwright smoke test (Task 14); this pins the pre-init contract the Svelte
// app relies on (update/zoom/destroy are safe before init resolves).
describe("MapRenderer (without WebGL)", () => {
  const circle = (path: string, x: number, y: number, r: number, depth: number, isDir: boolean): Circle => ({ path, x, y, r, depth, isDir });
  const layout = new Map<string, Circle>([
    ["", circle("", 500, 400, 397, 0, true)],
    ["src", circle("src", 400, 400, 100, 1, true)],
    ["src/a.ts", circle("src/a.ts", 400, 400, 10, 2, false)],
  ]);
  const visuals = new Map<string, NodeVisual>(
    [...layout.keys()].map((p) => [p, { path: p, ext: "ts", touches: [], ghost: false, deleted: false, tinted: false }]),
  );

  function host(): HTMLElement {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 1000 });
    Object.defineProperty(el, "clientHeight", { value: 800 });
    return el;
  }

  it("reports the target zoom scale when zooming, and 1 when zooming back out", () => {
    const r = new MapRenderer(host());
    const scales: number[] = [];
    r.onZoom((k) => scales.push(k));
    r.update(layout, visuals, { kind: "snapshot", merged: [] });
    r.zoomTo("src");
    r.zoomTo("");
    r.zoomTo("does/not/exist");
    expect(scales[0]).toBeCloseTo((800 * 0.9) / 200);
    expect(scales.slice(1)).toEqual([1, 1]);
  });

  it("can be destroyed before init", () => {
    const r = new MapRenderer(host());
    expect(() => r.destroy()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/render/MapRenderer.test.ts`
Expected: FAIL with `Failed to resolve import "./MapRenderer"`.

- [ ] **Step 4: Implement the textures**

`web/src/render/sprites.ts`:

```ts
import { Texture } from "pixi.js";
import { lighten, type ExtColor } from "../colors";
import { arcLetterAngles, fitLabel } from "./geometry";

const TEX_PX = 256; // crisp up to ~256px-wide bubbles when zoomed in

/** Radius of the bright band in the halo texture, as a fraction of the texture's half-size. */
export const HALO_RING_FRAC = 0.7;

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return { canvas, ctx };
}

/**
 * Pre-rendered textures. Every bubble is a Sprite of one of these, scaled to
 * its radius, so a frame is only transform updates (no per-node gradients).
 */
export class TextureBank {
  #spheres = new Map<string, Texture>();
  readonly disc: Texture;
  readonly halo: Texture;

  constructor() {
    this.disc = this.#discTexture();
    this.halo = this.#haloTexture();
  }

  /** Gradient-shaded sphere, same geometry as the mockup's radialGradient cx=35% cy=30% r=50%. */
  sphere(c: ExtColor): Texture {
    const key = `${c.light}|${c.base}`;
    let t = this.#spheres.get(key);
    if (!t) {
      const { canvas, ctx } = makeCanvas(TEX_PX, TEX_PX);
      const R = TEX_PX / 2;
      const g = ctx.createRadialGradient(R * 0.7, R * 0.6, 0, R * 0.7, R * 0.6, R);
      g.addColorStop(0, c.light);
      g.addColorStop(1, c.base);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(R, R, R - 1, 0, Math.PI * 2);
      ctx.fill();
      t = Texture.from(canvas, true);
      this.#spheres.set(key, t);
    }
    return t;
  }

  /** Sphere shaded in a worktree colour (committed-on-branch tint). */
  worktreeSphere(hex: string): Texture {
    return this.sphere({ light: lighten(hex, 0.45), base: hex });
  }

  destroy(): void {
    for (const t of this.#spheres.values()) t.destroy(true);
    this.#spheres.clear();
    this.disc.destroy(true);
    this.halo.destroy(true);
  }

  #discTexture(): Texture {
    const { canvas, ctx } = makeCanvas(TEX_PX, TEX_PX);
    const R = TEX_PX / 2;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.fill();
    return Texture.from(canvas, true);
  }

  /** Soft white ring (a blurred stroke) peaking at HALO_RING_FRAC; tinted per worktree. */
  #haloTexture(): Texture {
    const { canvas, ctx } = makeCanvas(TEX_PX, TEX_PX);
    const R = TEX_PX / 2;
    const inner = R * 0.4;
    const g = ctx.createRadialGradient(R, R, inner, R, R, R);
    const peak = (HALO_RING_FRAC * R - inner) / (R - inner);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(peak, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TEX_PX, TEX_PX);
    return Texture.from(canvas, true);
  }
}

export interface ArcLabel {
  texture: Texture;
  /** Circle centre inside the texture, in texture pixels. */
  originX: number;
  originY: number;
}

const LABEL_FONT_PX = 11;
const LABEL_MAX_SPAN = Math.PI * 0.8;

/**
 * A folder name set along the top arc of a circle of `screenR` CSS px.
 *
 * Pixi has no text-on-path, so each glyph is measured and drawn individually
 * into a 2D canvas, rotated to its angle from arcLetterAngles(); the canvas is
 * cropped to the glyphs' bounding box and uploaded once as a texture. The
 * renderer caches one texture per folder and re-renders only when the folder's
 * on-screen radius changes bucket while the camera is at rest.
 */
export function renderArcLabel(text: string, screenR: number, color: string, dpr: number): ArcLabel | null {
  const font = `500 ${LABEL_FONT_PX}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`;
  const radius = screenR - LABEL_FONT_PX;
  if (radius <= LABEL_FONT_PX) return null;
  const probe = makeCanvas(1, 1).ctx;
  probe.font = font;
  const chars = [...text];
  const widths = chars.map((ch) => probe.measureText(ch).width + 0.4);
  const ellipsis = probe.measureText("…").width;
  const keep = fitLabel(widths, radius, LABEL_MAX_SPAN, ellipsis);
  if (keep === 0) return null;
  const glyphs = keep < chars.length ? [...chars.slice(0, keep), "…"] : chars;
  const gw = keep < chars.length ? [...widths.slice(0, keep), ellipsis] : widths;
  const angles = arcLetterAngles(gw, radius);

  const pad = LABEL_FONT_PX;
  const pts = angles.map((a) => ({ x: Math.cos(a) * radius, y: Math.sin(a) * radius }));
  const minX = Math.min(...pts.map((p) => p.x)) - pad;
  const maxX = Math.max(...pts.map((p) => p.x)) + pad;
  const minY = Math.min(...pts.map((p) => p.y)) - pad;
  const maxY = Math.max(...pts.map((p) => p.y)) + pad;

  const { canvas, ctx } = makeCanvas((maxX - minX) * dpr, (maxY - minY) * dpr);
  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  glyphs.forEach((ch, i) => {
    const p = pts[i]!;
    ctx.save();
    ctx.translate(p.x - minX, p.y - minY);
    ctx.rotate(angles[i]! + Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
  return { texture: Texture.from(canvas, true), originX: -minX * dpr, originY: -minY * dpr };
}
```

- [ ] **Step 5: Implement the renderer**

`web/src/render/MapRenderer.ts`:

```ts
import { Application, Container, Graphics, Sprite, type Texture } from "pixi.js";
import { colorForExt, hexToNumber, lighten, worktreeColor } from "../colors";
import type { NodeVisual, Touch } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import type { WorktreeId } from "../protocol";
import type { Change } from "../store";
import { dashArcs, fitCamera, labelNames, pick, screenToWorld, splitSegments, type Camera } from "./geometry";
import { Scene, type SceneNode } from "./scene";
import { HALO_RING_FRAC, TextureBank, renderArcLabel } from "./sprites";
import { isSettled, makeSpring, retarget, stepSpring, type Spring } from "./springs";

export type Theme = "vision" | "night";

const NIGHT_IDLE = 0x3a3a44;
const LABEL_MIN_R = 48; // on-screen px before a folder gets its name
const LABEL_FADE_PX = 16;
const ISOLATE_DIM = 0.15;
const RING_GAP_PX = 2.5; // ring sits this far outside the bubble, on screen
const HALO_PX = 5; // halo peak this far outside the bubble, on screen
const SPLIT_GAP_PX = 3;

interface View {
  kind: string; // "file" | "dir" | "aggregate": a node that changes kind gets a fresh view
  root: Container;
  body: Sprite | null; // files only
  halo: Sprite | null;
  flash: Sprite | null; // merge shimmer
  g: Graphics; // dir outline, ghost fill, rings
  gKey: string;
  label: Sprite | null;
  labelKey: string;
  labelR: number; // world radius the label was rendered for
  labelK: number; // camera scale the label was rendered at
}

/**
 * Pixi v8 scene for the map. All animation state lives in Scene (pure,
 * unit-tested); this class only turns SceneNodes into display objects each
 * frame, owns the camera, and does picking in JS from the layout map.
 * Visual behaviour is verified by the Playwright smoke test (Task 14).
 */
export class MapRenderer {
  #host: HTMLElement;
  #app: Application | null = null;
  #bank: TextureBank | null = null;
  #destroyed = false;

  #world = new Container();
  #dirLayer = new Container();
  #fileLayer = new Container();
  #labelLayer = new Container();
  #fx = new Graphics();

  #scene = new Scene();
  #views = new Map<string, View>();
  #layout = new Map<string, Circle>();
  #labels = new Map<string, string>();

  #theme: Theme = "vision";
  #isolated: WorktreeId | null = null;
  #highlighted: string | null = null;
  #styleGen = 0;

  #zoomPath = "";
  #cam: { cx: Spring; cy: Spring; logk: Spring } = { cx: makeSpring(0), cy: makeSpring(0), logk: makeSpring(0) };
  #camTargetK = 1;

  #hoverFns: ((path: string | null, screen: { x: number; y: number }) => void)[] = [];
  #clickFns: ((path: string | null) => void)[] = [];
  #zoomFns: ((scale: number) => void)[] = [];
  #idleFrames = 0;
  #lastHover: string | null = null;

  constructor(host: HTMLElement) {
    this.#host = host;
  }

  async init(): Promise<void> {
    const app = new Application();
    await app.init({
      resizeTo: this.#host,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: "webgl",
    });
    if (this.#destroyed) {
      app.destroy(true);
      return;
    }
    this.#app = app;
    this.#bank = new TextureBank();
    this.#host.appendChild(app.canvas);
    app.canvas.style.display = "block";
    this.#world.addChild(this.#dirLayer, this.#fileLayer, this.#labelLayer, this.#fx);
    app.stage.addChild(this.#world);
    const { width, height } = this.#size();
    this.#cam = { cx: makeSpring(width / 2), cy: makeSpring(height / 2), logk: makeSpring(0) };

    app.canvas.addEventListener("pointermove", this.#onPointerMove);
    app.canvas.addEventListener("pointerleave", this.#onPointerLeave);
    app.canvas.addEventListener("click", this.#onClick);
    app.ticker.add((t) => this.#frame(t.deltaMS));
  }

  update(layout: Map<string, Circle>, visuals: Map<string, NodeVisual>, change: Change): void {
    this.#layout = layout;
    this.#labels = labelNames(layout);
    this.#scene.update(layout, visuals, change, performance.now());
    if (!layout.has(this.#zoomPath)) this.#zoomPath = "";
    this.#aimCamera(false);
    this.#wake();
  }

  setTheme(t: Theme): void {
    if (t === this.#theme) return;
    this.#theme = t;
    this.#styleGen++;
    this.#wake();
  }

  isolate(worktree: WorktreeId | null): void {
    this.#isolated = worktree;
    this.#styleGen++;
    this.#wake();
  }

  highlight(path: string | null): void {
    this.#highlighted = path;
    this.#wake();
  }

  zoomTo(path: string): void {
    this.#zoomPath = this.#layout.has(path) ? path : "";
    this.#aimCamera(true);
    this.#wake();
  }

  onHover(fn: (path: string | null, screen: { x: number; y: number }) => void): void {
    this.#hoverFns.push(fn);
  }

  onClick(fn: (path: string | null) => void): void {
    this.#clickFns.push(fn);
  }

  /** Fires with the camera's TARGET scale whenever a zoom starts, so the caller can re-cull. */
  onZoom(fn: (scale: number) => void): void {
    this.#zoomFns.push(fn);
  }

  destroy(): void {
    this.#destroyed = true;
    const app = this.#app;
    if (!app) return;
    app.canvas.removeEventListener("pointermove", this.#onPointerMove);
    app.canvas.removeEventListener("pointerleave", this.#onPointerLeave);
    app.canvas.removeEventListener("click", this.#onClick);
    for (const v of this.#views.values()) v.label?.texture.destroy(true);
    app.destroy(true, { children: true });
    this.#bank?.destroy();
    this.#app = null;
  }

  // ---- camera -----------------------------------------------------------

  #size(): { width: number; height: number } {
    return { width: this.#host.clientWidth || 1, height: this.#host.clientHeight || 1 };
  }

  #camera(): Camera {
    return { cx: this.#cam.cx.value, cy: this.#cam.cy.value, k: Math.exp(this.#cam.logk.value) };
  }

  #aimCamera(userInitiated: boolean): void {
    const c = this.#layout.get(this.#zoomPath);
    if (!c) return;
    const { width, height } = this.#size();
    const target = fitCamera(c, width, height);
    retarget(this.#cam.cx, target.cx);
    retarget(this.#cam.cy, target.cy);
    retarget(this.#cam.logk, Math.log(target.k));
    const changed = Math.abs(Math.log(target.k / this.#camTargetK)) > 1e-3;
    this.#camTargetK = target.k;
    if (changed || userInitiated) for (const fn of this.#zoomFns) fn(target.k);
  }

  // ---- input ------------------------------------------------------------

  #pickAt(ev: PointerEvent | MouseEvent): string | null {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const { width, height } = this.#size();
    const w = screenToWorld(this.#camera(), width, height, ev.clientX - rect.left, ev.clientY - rect.top);
    return pick(this.#layout, w.x, w.y);
  }

  #onPointerMove = (ev: PointerEvent): void => {
    const path = this.#pickAt(ev);
    if (this.#app) this.#app.canvas.style.cursor = path !== null && path !== this.#zoomPath ? "pointer" : "default";
    this.#lastHover = path;
    for (const fn of this.#hoverFns) fn(path, { x: ev.clientX, y: ev.clientY });
  };

  #onPointerLeave = (ev: PointerEvent): void => {
    if (this.#lastHover === null) return;
    this.#lastHover = null;
    for (const fn of this.#hoverFns) fn(null, { x: ev.clientX, y: ev.clientY });
  };

  #onClick = (ev: MouseEvent): void => {
    const path = this.#pickAt(ev);
    for (const fn of this.#clickFns) fn(path);
  };

  // ---- frame loop -------------------------------------------------------

  #wake(): void {
    this.#idleFrames = 0;
    if (this.#app && !this.#app.ticker.started) this.#app.ticker.start();
  }

  #frame(dtMs: number): void {
    const app = this.#app;
    const bank = this.#bank;
    if (!app || !bank) return;
    const now = performance.now();
    const dt = Math.min(dtMs, 64) / 1000;
    stepSpring(this.#cam.cx, dt);
    stepSpring(this.#cam.cy, dt);
    stepSpring(this.#cam.logk, dt);
    const camBusy = !isSettled(this.#cam.cx) || !isSettled(this.#cam.cy) || !isSettled(this.#cam.logk, 1e-4);
    const sceneBusy = this.#scene.step(dtMs, now);

    const cam = this.#camera();
    const { width, height } = this.#size();
    this.#world.scale.set(cam.k);
    this.#world.position.set(width / 2 - cam.cx * cam.k, height / 2 - cam.cy * cam.k);

    for (const n of this.#scene.nodes.values()) this.#draw(n, bank, cam.k, now, camBusy);
    for (const [path, v] of this.#views) {
      if (!this.#scene.nodes.has(path)) this.#dropView(path, v);
    }
    this.#drawHighlight(cam.k);

    // Stop the ticker once idle so an ambient dashboard costs ~0 GPU.
    if (camBusy || sceneBusy) this.#idleFrames = 0;
    else if (++this.#idleFrames > 2) app.ticker.stop();
  }

  #view(n: SceneNode, bank: TextureBank): View {
    const kind = !n.isDir ? "file" : n.aggregate !== undefined ? "aggregate" : "dir";
    let v = this.#views.get(n.path);
    if (v && v.kind === kind) return v;
    if (v) this.#dropView(n.path, v);
    const root = new Container();
    const g = new Graphics();
    let body: Sprite | null = null;
    let halo: Sprite | null = null;
    if (!n.isDir || n.aggregate !== undefined) {
      halo = new Sprite(bank.halo);
      halo.anchor.set(0.5);
      halo.visible = false;
      root.addChild(halo);
    }
    if (!n.isDir) {
      body = new Sprite(bank.disc);
      body.anchor.set(0.5);
      root.addChild(body);
    }
    root.addChild(g);
    (n.isDir ? this.#dirLayer : this.#fileLayer).addChild(root);
    v = { kind, root, body, halo, flash: null, g, gKey: "", label: null, labelKey: "", labelR: 0, labelK: 1 };
    this.#views.set(n.path, v);
    return v;
  }

  #dropView(path: string, v: View): void {
    v.label?.texture.destroy(true);
    v.label?.destroy();
    v.root.destroy({ children: true });
    this.#views.delete(path);
  }

  #draw(n: SceneNode, bank: TextureBank, k: number, now: number, camBusy: boolean): void {
    const v = this.#view(n, bank);
    const pos = this.#scene.drawPosition(n);
    const r = Math.max(0, n.r.value);
    v.root.position.set(pos.x, pos.y);
    v.root.alpha = n.alpha.value;
    v.root.visible = r * k >= 0.3;
    if (!v.root.visible) {
      if (v.label) v.label.visible = false;
      return;
    }

    const vis = n.visual;
    const dimmed = this.#isolated !== null && vis.touches.length > 0 && !vis.touches.some((t) => t.worktree === this.#isolated);
    const encAlpha = dimmed ? ISOLATE_DIM : 1;
    const touches = dimmed ? [] : vis.touches;
    const night = this.#theme === "night";

    // Body (files): texture + tint by theme and lifecycle.
    if (v.body) {
      const hidden = vis.ghost || vis.deleted;
      v.body.visible = !hidden;
      if (!hidden) {
        const lead = touches[0];
        const tintedTouch = vis.tinted && !dimmed ? vis.touches.find((t) => t.stage === "committed") : undefined;
        let tex: Texture;
        let tint = 0xffffff;
        let alpha = 1;
        if (night) {
          tex = bank.disc;
          tint = lead ? hexToNumber(worktreeColor(lead.colorIndex)) : NIGHT_IDLE;
          alpha = lead && lead.stage === "committed" ? 0.85 : 1;
        } else if (tintedTouch) {
          tex = bank.worktreeSphere(worktreeColor(tintedTouch.colorIndex));
          alpha = 0.9;
        } else {
          tex = bank.sphere(colorForExt(vis.ext));
        }
        if (v.body.texture !== tex) v.body.texture = tex;
        v.body.tint = tint;
        v.body.alpha = alpha;
        v.body.width = v.body.height = r * 2;
      }
    }

    // Halo: uncommitted, live (not ghost/deleted) work glows in the first uncommitted worktree's colour.
    if (v.halo) {
      const live = vis.touches.find((t) => t.stage === "uncommitted" && t.kind !== "deleted");
      const show = live !== undefined && !vis.ghost && !vis.deleted;
      v.halo.visible = show;
      if (show) {
        const peak = r + HALO_PX / k;
        const half = peak / HALO_RING_FRAC;
        v.halo.width = v.halo.height = half * 2;
        v.halo.tint = hexToNumber(worktreeColor(live.colorIndex));
        v.halo.alpha = (night ? 0.5 : 0.6) * encAlpha;
      }
    }

    // Vector parts, redrawn only when their inputs change.
    const rq = Math.round(r * k * 2);
    const kq = Math.round(Math.log2(k) * 8);
    const sig = vis.touches.map((t) => `${t.worktree}:${t.colorIndex}:${t.stage}:${t.kind}`).join(",");
    const gKey = `${rq}|${kq}|${this.#styleGen}|${sig}|${vis.ghost}|${vis.deleted}|${n.aggregate ?? -1}`;
    if (gKey !== v.gKey) {
      v.gKey = gKey;
      v.g.clear();
      if (n.isDir) this.#drawDir(v.g, n, r, k, touches, encAlpha);
      else this.#drawFileRings(v.g, vis, r, k, touches, encAlpha);
    }

    this.#drawShimmer(v, n, r, bank, now);
    this.#drawLabel(v, n, r, k, camBusy);
  }

  #drawDir(g: Graphics, n: SceneNode, r: number, k: number, touches: Touch[], encAlpha: number): void {
    const night = this.#theme === "night";
    const isRoot = n.depth === 0;
    if (n.aggregate !== undefined) {
      g.circle(0, 0, r).fill({ color: 0xffffff, alpha: night ? 0.05 : 0.07 });
      g.circle(0, 0, r).stroke({ color: 0xffffff, alpha: 0.14, width: 1 / k });
      this.#drawRings(g, r, k, touches, encAlpha);
      return;
    }
    if (!night) g.circle(0, 0, r).fill({ color: 0xffffff, alpha: isRoot ? 0.02 : 0.03 });
    const alpha = night ? (isRoot ? 0.1 : 0.08) : isRoot ? 0.16 : 0.12;
    g.circle(0, 0, r).stroke({ color: 0xffffff, alpha, width: 1 / k });
  }

  #drawFileRings(g: Graphics, vis: NodeVisual, r: number, k: number, touches: Touch[], encAlpha: number): void {
    const lead = vis.touches[0];
    if (vis.deleted && lead) {
      // Faint outline that stays until the deletion reaches base.
      g.circle(0, 0, r).fill({ color: 0xffffff, alpha: 0.02 });
      g.circle(0, 0, r).stroke({ color: hexToNumber(worktreeColor(lead.colorIndex)), alpha: 0.45 * encAlpha, width: 1 / k });
      return;
    }
    if (vis.ghost && lead) {
      // Ghost: ~15% fill in the worktree colour and a dashed outline.
      const ghostTouch = vis.touches.find((t) => t.stage === "uncommitted" && t.kind === "added") ?? lead;
      const color = hexToNumber(worktreeColor(ghostTouch.colorIndex));
      if (this.#theme === "vision") g.circle(0, 0, r).fill({ color, alpha: 0.15 * encAlpha });
      this.#dashed(g, r, k, -Math.PI / 2, Math.PI * 1.5, color, 1 / k, encAlpha, 2, 2);
      const others = touches.filter((t) => t !== ghostTouch && t.worktree !== ghostTouch.worktree);
      if (others.length > 0) this.#drawRings(g, r, k, others, encAlpha);
      return;
    }
    this.#drawRings(g, r, k, touches, encAlpha);
  }

  /** One ring (or a split ring with one arc per worktree): dashed = uncommitted, solid = committed. */
  #drawRings(g: Graphics, r: number, k: number, touches: Touch[], encAlpha: number): void {
    if (touches.length === 0) return;
    const R = r + RING_GAP_PX / k;
    const width = 1.5 / k;
    const segs = splitSegments(touches.length, touches.length > 1 ? SPLIT_GAP_PX / (R * k) : 0);
    touches.forEach((t, i) => {
      const [a0, a1] = segs[i]!;
      const color = hexToNumber(lighten(worktreeColor(t.colorIndex), 0.25));
      if (t.stage === "uncommitted") {
        this.#dashed(g, R, k, a0, a1, color, width, encAlpha, 4, 3);
      } else {
        g.moveTo(Math.cos(a0) * R, Math.sin(a0) * R).arc(0, 0, R, a0, a1).stroke({ color, width, alpha: encAlpha });
      }
    });
  }

  #dashed(g: Graphics, R: number, k: number, a0: number, a1: number, color: number, width: number, alpha: number, dashPx: number, gapPx: number): void {
    for (const [s, e] of dashArcs(R * k, dashPx, gapPx, a0, a1)) {
      g.moveTo(Math.cos(s) * R, Math.sin(s) * R).arc(0, 0, R, s, e);
    }
    g.stroke({ color, width, alpha });
  }

  #drawShimmer(v: View, n: SceneNode, r: number, bank: TextureBank, now: number): void {
    const p = this.#scene.shimmer(n, now);
    if (p === null) {
      if (v.flash) v.flash.visible = false;
      return;
    }
    if (!v.flash) {
      v.flash = new Sprite(bank.disc);
      v.flash.anchor.set(0.5);
      v.root.addChild(v.flash);
    }
    v.flash.visible = true;
    v.flash.alpha = 0.55 * Math.sin(Math.PI * p);
    v.flash.width = v.flash.height = r * 2 * (1 + 0.25 * p);
  }

  #drawLabel(v: View, n: SceneNode, r: number, k: number, camBusy: boolean): void {
    const screenR = r * k;
    const name = n.leaving ? undefined : this.#labels.get(n.path);
    // Hide while the folder is still growing/shrinking so labels never balloon.
    const nearTarget = Math.abs(n.r.value - n.r.target) <= 0.05 * Math.max(n.r.target, 1e-6);
    if (name === undefined || screenR < LABEL_MIN_R || !nearTarget) {
      if (v.label) v.label.visible = false;
      return;
    }
    const bucket = Math.round(screenR / 12);
    const key = `${name}|${bucket}|${this.#theme}`;
    if (key !== v.labelKey && (!camBusy || !v.label)) {
      const color = this.#theme === "night" ? "rgba(235,235,245,0.38)" : "rgba(235,235,245,0.62)";
      const dpr = this.#app?.renderer.resolution ?? 1;
      const lbl = renderArcLabel(name, screenR, color, dpr);
      if (v.label) {
        v.label.texture.destroy(true);
        v.label.destroy();
        v.label = null;
      }
      v.labelKey = key;
      if (lbl) {
        const s = new Sprite(lbl.texture);
        s.anchor.set(lbl.originX / lbl.texture.width, lbl.originY / lbl.texture.height);
        this.#labelLayer.addChild(s);
        v.label = s;
        v.labelR = r;
        v.labelK = k * dpr;
      }
    }
    if (!v.label) return;
    v.label.visible = true;
    v.label.position.copyFrom(v.root.position);
    v.label.scale.set(r / v.labelR / v.labelK);
    v.label.alpha = Math.min(1, (screenR - LABEL_MIN_R) / LABEL_FADE_PX) * n.alpha.value;
  }

  #drawHighlight(k: number): void {
    this.#fx.clear();
    const path = this.#highlighted;
    if (path === null) return;
    const n = this.#scene.get(path);
    if (!n || n.leaving) return;
    const pos = this.#scene.drawPosition(n);
    this.#fx.circle(pos.x, pos.y, n.r.value + 5 / k).stroke({ color: 0xffffff, alpha: 0.9, width: 2 / k });
  }
}
```

- [ ] **Step 6: Run the renderer test to verify it passes**

Run: `pnpm -C web exec vitest run src/render/MapRenderer.test.ts`
Expected: PASS, `Tests  2 passed (2)`.

- [ ] **Step 7: Mount the live map in the app**

Replace `web/src/ui/App.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { connect } from "../connection";
  import { computeFrame } from "../layout/frame";
  import type { Circle } from "../layout/pack";
  import { clickTarget } from "../render/geometry";
  import { MapRenderer } from "../render/MapRenderer";
  import { RepoStore, type Change } from "../store";

  let mapEl: HTMLDivElement;

  onMount(() => {
    const store = new RepoStore();
    const renderer = new MapRenderer(mapEl);
    let layout = new Map<string, Circle>();
    let zoomPath = "";
    let scale = 1;
  const MAP_PAD = 48; // keeps the repo circle clear of the floating panels
    let disposed = false;
    let stop = (): void => {};
    let off = (): void => {};

    const relayout = (change: Change): void => {
      const s = store.state;
      if (!s) return;
      const f = computeFrame(s, mapEl.clientWidth, mapEl.clientHeight, scale, MAP_PAD);
      layout = f.layout;
      renderer.update(f.layout, f.visuals, change);
    };
    const onResize = (): void => relayout({ kind: "patch", merged: [] });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      zoomPath = "";
      renderer.zoomTo("");
    };

    void renderer.init().then(() => {
      if (disposed) return;
      renderer.onZoom((k) => {
        scale = k;
        relayout({ kind: "patch", merged: [] });
      });
      renderer.onClick((path) => {
        zoomPath = clickTarget(path, layout, zoomPath);
        renderer.zoomTo(zoomPath);
      });
      off = store.subscribe((_s, change) => relayout(change));
      stop = connect(store);
      window.addEventListener("resize", onResize);
      window.addEventListener("keydown", onKey);
    });

    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      off();
      stop();
      renderer.destroy();
    };
  });
</script>

<div class="map" data-testid="map" bind:this={mapEl}></div>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    overflow: hidden;
    background: radial-gradient(ellipse at 30% 20%, #26284a 0%, #0c0c14 55%, #07070a 100%);
    color: #f2f2f7;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  }
  .map {
    position: fixed;
    inset: 0;
  }
</style>
```

- [ ] **Step 8: Run the full web check**

Run: `pnpm -C web lint && pnpm -C web test && pnpm -C web build`
Expected: lint prints `0 ERRORS 0 WARNINGS`; tests print `Test Files  11 passed (11)` and `Tests  102 passed (102)`; build prints `✓ built in` (the Pixi chunks are split automatically).

- [ ] **Step 9: Look at it**

If Tasks 8 and 13 have merged, run the demo repo and `orion --dev`, then `pnpm -C web dev` and open `http://localhost:5173/?t=<token printed by orion>`. Otherwise run `go run ./cmd/orion --no-open` in any repo and open the printed URL after `make build`.

Check that:
- bubbles grow in on load;
- editing a file in a worktree makes it glow with a dashed ring;
- `git mv` glides the bubble;
- clicking a folder zooms, and Esc zooms out.

Visual regressions are caught for good by Task 14.

- [ ] **Step 10: Commit**

```bash
git add web/src/render/sprites.ts web/src/render/MapRenderer.ts web/src/render/MapRenderer.test.ts web/src/ui/App.svelte
git commit -m "$(cat <<'EOF'
feat(web): render the live map with PixiJS

Sprites with pre-rendered sphere/halo textures, cached vector rings,
arc-set folder labels, spring camera zoom and JS picking; the ticker
stops when the scene is at rest.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Rebase, push and open the PR**

```bash
git fetch origin && git rebase origin/main
pnpm -C web lint && pnpm -C web test && pnpm -C web build
git push -u origin feat/web-renderer
gh pr create --base main --head feat/web-renderer --title "feat(web): PixiJS map renderer" --body "$(cat <<'EOF'
## Summary
- `MapRenderer` (Pixi v8): per-node sprites keyed by path, spring-animated; lifecycle visuals per spec §6 for Vision and Night; split rings; folder names along the top arc; zoom-to-folder with re-culling via `onZoom`; JS picking for hover/click.
- App now mounts the map, re-lays out on patches, resize and zoom; Esc zooms out.

## Test plan
- [x] `pnpm -C web test` (102 tests; renderer pre-init contract, drawing covered by the Task 14 Playwright smoke test)
- [x] `pnpm -C web lint`, `pnpm -C web build`
- [x] Manual check against a synthetic repo: grow-in, halo/dashed ring, ghost, glide, merge shimmer, zoom, Night palette

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 12: Chrome: legend, activity, live pill, tooltip, themes, keys

**Branch:** `feat/web-chrome` · **Depends on:** Task 11b

**Files:**
- Create: `web/src/ui/theme.ts`, `web/src/ui/theme.css`, `web/src/ui/format.ts`, `web/src/ui/keys.ts`, `web/src/ui/models.ts`, `web/src/ui/Legend.svelte`, `web/src/ui/Activity.svelte`, `web/src/ui/LivePill.svelte`, `web/src/ui/Tooltip.svelte`
- Modify: `web/src/ui/App.svelte` (final composition), `web/src/main.ts` (import `theme.css`)
- Test: `web/src/ui/theme.test.ts`, `web/src/ui/format.test.ts`, `web/src/ui/keys.test.ts`, `web/src/ui/models.test.ts`, `web/src/ui/Legend.test.ts`, `web/src/ui/Activity.test.ts`

**Interfaces:**
- Consumes: `RepoStore`, `RepoState`, `Change` (Task 9); `connect`, `ConnectionStatus` (Task 9); `computeFrame` (Task 10); `encode`, `encodeAll`, `worktreeColor` (Task 10); `MapRenderer`, `Theme`, `clickTarget`, `parentDir` (Task 11).
- Produces (all internal to `web/src/ui/`):
  - `theme.ts`: `type Theme` (re-exported from `MapRenderer`), `THEME_KEY = "orion.theme"`, `loadTheme(storage?)`, `saveTheme(t, storage?)`, `applyTheme(t)`.
  - `format.ts`: `humanSize`, `relativeTime`, `splitPath`.
  - `keys.ts`: `type KeyAction = "theme" | "fullscreen" | "zoomOut"`, `keyAction(e)`.
  - `models.ts`: `ACTIVE_WINDOW_MS`, `LegendItem`, `legendModel`, `ActivityRow`, `activityRows`, `rowFade`, `TooltipInfo`, `tooltipInfo`.
  - Components: `Legend` (`repo`, `now`, `isolated`, `onIsolate`), `Activity` (`repo`, `now`, `onHover`, `onSelect`), `LivePill` (`status`), `Tooltip` (`info`, `x`, `y`).
  - DOM contract for Task 14:
    - `[data-testid="map"]` wraps the canvas.
    - `[data-testid="legend"]` contains one `[data-testid="worktree-pill"]` per shown worktree.
    - `[data-testid="activity"]` rows show the file's base name as text.
    - `[data-testid="live-pill"]` reads "Live" when connected.
    - `<html data-theme="vision|night">` defaults to vision; `n`/`N` toggles it, and the choice persists in `localStorage["orion.theme"]`.
    - `[data-testid="tooltip"]` is the hover card.

**Design notes:**
- **Vision** follows mockup card 1 exactly.
  - Background: `radial-gradient(ellipse at 30% 20%, #26284a 0%, #0c0c14 55%, #07070a 100%)`.
  - Panels (the `.glass` class):
    - `rgba(40,40,52,.45)`
    - `backdrop-filter: blur(18px) saturate(1.6)`
    - a 1 px `rgba(255,255,255,.10)` border
    - `box-shadow: 0 8px 30px rgba(0,0,0,.35)`
    - radius 14 px
  - Type: the system font stack, 12 px body.
- **Night** follows card 3.
  - The background is `#000`, and panels become transparent, with no border or blur.
  - Controls marked `.night-reveal` (legend pills, the live pill while connected) fade in on hover or keyboard focus.
  - The activity stream moves bottom-right, and its rows fade with age (`rowFade`: 1 → 0.15 over 10 minutes).
  - "Reconnecting…" always stays visible.
- **Section title case.** The mockup's section titles were uppercase and tracked. Here they are sentence case ("Activity") at 11 px/600 and 55% opacity, which is quieter and more like current Apple UI. This is the one deliberate deviation from the mockup; revert it by adding `text-transform: uppercase; letter-spacing: .08em` to `.activity h2` if the user prefers.
- **Legend.**
  - A worktree is **active** when its overlay is non-empty **or** it had activity in the last 10 minutes. A non-empty overlay alone qualifies, so a demo with several dirty worktrees shows several pills.
  - Active pills are ordered by colour index (main first). Idle pills sort main first, then by label, behind a "+N idle" toggle.
  - Clicking a pill isolates that worktree; clicking it again clears the isolation. `aria-pressed` reflects the state.
- **Activity.**
  - Rows are newest first.
  - Consecutive items with the same worktree, kind and path, each ≤ 5 s apart, render as one row with "×N". This absorbs bursts even if the server delivers them separately.
  - Commit rows read "Committed 3 files" with the subject underneath; merge rows read "Merged 2 files into <base>". Both are emphasised with a 14% wash of the worktree colour.
  - Hovering a row calls `renderer.highlight(path)`; clicking it zooms to the file's folder.
- **Tooltip.** It shows the full path (folder dimmed), the size in decimal units (as Finder shows them), and one line per touching worktree, with its colour dot, label and stage (for example "Edited, committed on branch" or "Moved from old.ts, uncommitted"). Collapsed folders show "N files"; plain folders show no tooltip, because their names are on the map.
- **Keys.** `N` toggles the theme, `F` toggles fullscreen, and `Esc` zooms out. They are ignored with Cmd, Ctrl or Alt held, and while typing in a form field.
- **Motion.** Motion honours `prefers-reduced-motion` (CSS transitions and animations are removed). Buttons have a visible focus ring.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-web-chrome -b feat/web-chrome main
cd .claude/worktrees/feat-web-chrome
pnpm -C web install --frozen-lockfile
```

- [ ] **Step 2: Write the failing tests for the small helpers**

`web/src/ui/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { humanSize, relativeTime, splitPath } from "./format";

describe("humanSize", () => {
  it("uses decimal units like Finder", () => {
    expect(humanSize(0)).toBe("0 bytes");
    expect(humanSize(1)).toBe("1 byte");
    expect(humanSize(999)).toBe("999 bytes");
    expect(humanSize(1234)).toBe("1.2 KB");
    expect(humanSize(56_700)).toBe("57 KB");
    expect(humanSize(3_400_000)).toBe("3.4 MB");
    expect(humanSize(2_000_000_000)).toBe("2.0 GB");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000;
  it("rounds to the largest sensible unit", () => {
    expect(relativeTime(now - 3_000, now)).toBe("now");
    expect(relativeTime(now - 42_000, now)).toBe("42s");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
  });
  it("treats future timestamps (clock skew) as now", () => {
    expect(relativeTime(now + 5_000, now)).toBe("now");
  });
});

describe("splitPath", () => {
  it("separates the folder (with trailing slash) from the name", () => {
    expect(splitPath("src/lib/a.ts")).toEqual({ dir: "src/lib/", name: "a.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});
```

`web/src/ui/theme.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { THEME_KEY, applyTheme, loadTheme, saveTheme } from "./theme";

function storage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const broken: Storage = {
  length: 0,
  clear: () => {},
  key: () => null,
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {},
};

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("theme persistence", () => {
  it("defaults to vision", () => {
    expect(loadTheme(storage())).toBe("vision");
  });

  it("round-trips through storage", () => {
    const s = storage();
    saveTheme("night", s);
    expect(s.getItem(THEME_KEY)).toBe("night");
    expect(loadTheme(s)).toBe("night");
  });

  it("ignores junk values", () => {
    expect(loadTheme(storage({ [THEME_KEY]: "sepia" }))).toBe("vision");
  });

  it("survives storage that throws or is missing", () => {
    expect(loadTheme(broken)).toBe("vision");
    expect(() => saveTheme("night", broken)).not.toThrow();
    expect(loadTheme(null)).toBe("vision");
    expect(() => saveTheme("night", null)).not.toThrow();
  });

  it("applies the theme to <html data-theme>", () => {
    applyTheme("night");
    expect(document.documentElement.dataset.theme).toBe("night");
  });
});
```

`web/src/ui/keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { keyAction } from "./keys";

const ev = (key: string, over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, target: document.body, ...over }) as KeyboardEvent;

describe("keyAction", () => {
  it("maps N, F and Esc (either case)", () => {
    expect(keyAction(ev("n"))).toBe("theme");
    expect(keyAction(ev("N"))).toBe("theme");
    expect(keyAction(ev("f"))).toBe("fullscreen");
    expect(keyAction(ev("Escape"))).toBe("zoomOut");
    expect(keyAction(ev("x"))).toBeNull();
  });

  it("ignores shortcuts with modifiers (Cmd-N, Ctrl-F…)", () => {
    expect(keyAction(ev("n", { metaKey: true }))).toBeNull();
    expect(keyAction(ev("f", { ctrlKey: true }))).toBeNull();
    expect(keyAction(ev("n", { altKey: true }))).toBeNull();
  });

  it("ignores typing in form fields", () => {
    const input = document.createElement("input");
    expect(keyAction(ev("n", { target: input }))).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm -C web exec vitest run src/ui`
Expected: FAIL. All three files report `Failed to resolve import` (`./format`, `./theme`, `./keys`).

- [ ] **Step 4: Implement the helpers**

`web/src/ui/format.ts`:

```ts
/** Decimal byte sizes, as macOS Finder shows them. */
export function humanSize(bytes: number): string {
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Compact age: now, 42s, 5m, 3h, 2d. */
export function relativeTime(ts: number, now: number): string {
  const s = Math.floor((now - ts) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}
```

`web/src/ui/theme.ts`:

```ts
import type { Theme } from "../render/MapRenderer";

export type { Theme };

export const THEME_KEY = "orion.theme";

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Remembered theme; "vision" when unset, invalid, or storage is unavailable. */
export function loadTheme(storage: Storage | null = defaultStorage()): Theme {
  try {
    const v = storage?.getItem(THEME_KEY);
    return v === "night" ? "night" : "vision";
  } catch {
    return "vision";
  }
}

export function saveTheme(t: Theme, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(THEME_KEY, t);
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}

/** CSS tokens in theme.css switch on <html data-theme>. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}
```

`web/src/ui/keys.ts`:

```ts
export type KeyAction = "theme" | "fullscreen" | "zoomOut";

/** N toggles Night/Vision, F toggles fullscreen, Esc zooms out. `/` search is Phase 2. */
export function keyAction(e: KeyboardEvent): KeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return null;
  switch (e.key) {
    case "n":
    case "N":
      return "theme";
    case "f":
    case "F":
      return "fullscreen";
    case "Escape":
      return "zoomOut";
    default:
      return null;
  }
}
```

- [ ] **Step 5: Run the helper tests to verify they pass**

Run: `pnpm -C web exec vitest run src/ui`
Expected: PASS, `Tests  12 passed (12)`.

- [ ] **Step 6: Write the failing view-model test**

`web/src/ui/models.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeState, wt } from "../layout/fixtures";
import type { Circle } from "../layout/pack";
import type { Activity } from "../protocol";
import { ACTIVE_WINDOW_MS, activityRows, legendModel, rowFade, tooltipInfo } from "./models";

const NOW = 10_000_000;

describe("legendModel", () => {
  it("splits active worktrees (changes or recent activity) from idle ones", () => {
    const s = makeState(
      { "a.ts": 1 },
      { w0: [{ path: "a.ts", kind: "modified", stage: "uncommitted", size: 1 }] },
      [wt("w0", 0, "main"), wt("w1", 1, "feat/a"), wt("w2", 2, "fix/b"), wt("w3", -1, "chore/c")],
    );
    s.activity = [
      { ts: NOW - 60_000, worktree: "w1", kind: "commit", sha: "abc", subject: "Add a", files: 2 },
      { ts: NOW - ACTIVE_WINDOW_MS - 1, worktree: "w2", kind: "modified", path: "x.ts" },
    ];
    const m = legendModel(s, NOW);
    expect(m.active.map((w) => [w.id, w.changed])).toEqual([["w0", 1], ["w1", 0]]);
    expect(m.active[0]).toMatchObject({ label: "main", color: "#0a84ff" });
    expect(m.idle.map((w) => w.id)).toEqual(["w3", "w2"]);
  });
});

describe("activityRows", () => {
  const a = (ts: number, over: Partial<Activity> = {}): Activity => ({ ts, worktree: "w1", kind: "modified", path: "src/a.ts", ...over });

  it("lists newest first", () => {
    const rows = activityRows([a(1000, { path: "old.ts" }), a(90_000, { path: "new.ts" })]);
    expect(rows.map((r) => r.path)).toEqual(["new.ts", "old.ts"]);
  });

  it("coalesces bursts of the same edit (≤5s apart) into one row with a count", () => {
    const rows = activityRows([a(1000), a(4000), a(8000), a(20_000)]);
    expect(rows.map((r) => [r.ts, r.count])).toEqual([[20_000, 1], [8000, 3]]);
  });

  it("does not coalesce across paths, worktrees or kinds", () => {
    const rows = activityRows([a(1000), a(1500, { worktree: "w2" }), a(2000, { kind: "added" }), a(2500, { path: "b.ts" })]);
    expect(rows).toHaveLength(4);
  });

  it("marks commit and merge rows as emphasised", () => {
    const rows = activityRows([a(1000), a(2000, { kind: "commit", path: undefined, files: 3, subject: "Fix" }), a(3000, { kind: "merge", path: undefined, files: 2 })]);
    expect(rows.map((r) => r.emphasis)).toEqual([true, true, false]);
  });

  it("fades rows with age (Night mode), never below 0.15", () => {
    expect(rowFade(NOW, NOW)).toBe(1);
    expect(rowFade(NOW - ACTIVE_WINDOW_MS / 2, NOW)).toBeCloseTo(0.575);
    expect(rowFade(NOW - 10 * ACTIVE_WINDOW_MS, NOW)).toBe(0.15);
  });
});

describe("tooltipInfo", () => {
  const circle = (path: string, isDir: boolean, aggregate?: number): Circle => ({ path, x: 0, y: 0, r: 5, depth: 1, isDir, ...(aggregate ? { aggregate } : {}) });

  it("describes a file: path, largest size, and who touches it at what stage", () => {
    const s = makeState(
      { "src/a.ts": 1200 },
      {
        w1: [{ path: "src/a.ts", kind: "modified", stage: "committed", size: 1500 }],
        w2: [{ path: "src/a.ts", kind: "modified", stage: "uncommitted", size: 900 }],
      },
    );
    expect(tooltipInfo(s, circle("src/a.ts", false))).toEqual({
      dir: "src/",
      name: "a.ts",
      detail: "1.5 KB",
      touches: [
        { color: "#ff9f0a", label: "feat/a", text: "Edited, committed on branch" },
        { color: "#30d158", label: "fix/b", text: "Edited, uncommitted" },
      ],
    });
  });

  it("describes new, deleted and moved files", () => {
    const s = makeState(
      { "old.ts": 5, "gone.ts": 5 },
      {
        w1: [
          { path: "n.ts", kind: "added", stage: "uncommitted", size: 5 },
          { path: "gone.ts", kind: "deleted", stage: "committed", size: 0 },
          { path: "moved.ts", kind: "renamed", from: "old.ts", stage: "uncommitted", size: 5 },
        ],
      },
    );
    expect(tooltipInfo(s, circle("n.ts", false))!.touches[0]!.text).toBe("New, uncommitted");
    expect(tooltipInfo(s, circle("gone.ts", false))!.touches[0]!.text).toBe("Deleted, committed on branch");
    expect(tooltipInfo(s, circle("moved.ts", false))!.touches[0]!.text).toBe("Moved from old.ts, uncommitted");
  });

  it("describes a collapsed folder by its file count, and ignores plain folders", () => {
    const s = makeState({ "vendor/a.js": 1, "vendor/b.js": 1 });
    expect(tooltipInfo(s, circle("vendor", true, 2))).toEqual({ dir: "", name: "vendor/", detail: "2 files", touches: [] });
    expect(tooltipInfo(s, circle("vendor", true))).toBeNull();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm -C web exec vitest run src/ui/models.test.ts`
Expected: FAIL with `Failed to resolve import "./models"`.

- [ ] **Step 8: Implement the view models**

`web/src/ui/models.ts`:

```ts
// View models for the chrome. Pure functions of RepoState so they are unit-tested
// without rendering, and the Svelte components stay thin.
import { worktreeColor } from "../colors";
import { encode, encodeAll } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import type { Activity, WorktreeId } from "../protocol";
import type { RepoState } from "../store";
import { humanSize, splitPath } from "./format";

/** A worktree counts as active with changes, or with activity in the last 10 minutes. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;
const COALESCE_MS = 5000;

export interface LegendItem {
  id: WorktreeId;
  label: string;
  color: string;
  changed: number;
  isMain: boolean;
  path: string;
}

export function legendModel(state: RepoState, now: number): { active: LegendItem[]; idle: LegendItem[] } {
  const recent = new Set<WorktreeId>();
  for (const a of state.activity) if (now - a.ts <= ACTIVE_WINDOW_MS) recent.add(a.worktree);
  const active: LegendItem[] = [];
  const idle: LegendItem[] = [];
  for (const w of state.worktrees.values()) {
    const changed = state.overlays.get(w.id)?.size ?? 0;
    const item: LegendItem = { id: w.id, label: w.label, color: worktreeColor(w.colorIndex), changed, isMain: w.isMain, path: w.path };
    if (changed > 0 || recent.has(w.id)) active.push(item);
    else idle.push(item);
  }
  const order = (a: LegendItem, b: LegendItem): number =>
    Number(b.isMain) - Number(a.isMain) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  const colorOrder = (a: LegendItem, b: LegendItem): number =>
    (state.worktrees.get(a.id)?.colorIndex ?? 99) - (state.worktrees.get(b.id)?.colorIndex ?? 99) || order(a, b);
  active.sort(colorOrder);
  idle.sort(order);
  return { active, idle };
}

export interface ActivityRow {
  key: string;
  worktree: WorktreeId;
  kind: Activity["kind"];
  ts: number; // newest item in the row
  count: number; // coalesced items
  path?: string;
  from?: string;
  subject?: string;
  files?: number;
  emphasis: boolean;
}

/**
 * Newest-first rows. Consecutive edits of the same path by the same worktree
 * with the same kind, each ≤5 s after the previous, collapse into one row
 * (the server already coalesces modifications; this also absorbs bursts of
 * added/deleted events and duplicate deliveries).
 */
export function activityRows(activity: Activity[], limit = 80): ActivityRow[] {
  const rows: ActivityRow[] = [];
  let oldestInRow = 0;
  for (let i = activity.length - 1; i >= 0 && rows.length <= limit; i--) {
    const a = activity[i]!;
    const prev = rows[rows.length - 1];
    const fileKind = a.kind !== "commit" && a.kind !== "merge";
    if (prev && fileKind && prev.kind === a.kind && prev.worktree === a.worktree && prev.path === a.path && oldestInRow - a.ts <= COALESCE_MS) {
      prev.count++;
      oldestInRow = a.ts;
      continue;
    }
    const row: ActivityRow = { key: `${a.ts}:${a.worktree}:${a.kind}:${a.path ?? a.sha ?? ""}:${i}`, worktree: a.worktree, kind: a.kind, ts: a.ts, count: 1, emphasis: !fileKind };
    if (a.path !== undefined) row.path = a.path;
    if (a.from !== undefined) row.from = a.from;
    if (a.subject !== undefined) row.subject = a.subject;
    if (a.files !== undefined) row.files = a.files;
    rows.push(row);
    oldestInRow = a.ts;
  }
  return rows.slice(0, limit);
}

/** Night mode: rows fade linearly over ACTIVE_WINDOW_MS, floor 0.15. */
export function rowFade(ts: number, now: number): number {
  const age = Math.max(0, now - ts) / ACTIVE_WINDOW_MS;
  return 0.15 + 0.85 * (1 - Math.min(1, age));
}

export interface TooltipInfo {
  dir: string;
  name: string;
  detail: string;
  touches: { color: string; label: string; text: string }[];
}

const VERB: Record<string, string> = { added: "New", modified: "Edited", deleted: "Deleted", renamed: "Moved" };

/** Hover card for files and collapsed folders; null for plain folders (their names are on the map). */
export function tooltipInfo(state: RepoState, c: Circle): TooltipInfo | null {
  if (c.isDir && c.aggregate === undefined) return null;
  const visual = c.isDir ? encodeAll(state, new Map([[c.path, c]])).get(c.path)! : encode(state, c.path);
  const touches = visual.touches.map((t) => {
    const w = state.worktrees.get(t.worktree);
    const entry = state.overlays.get(t.worktree)?.get(c.path);
    let verb = VERB[t.kind] ?? t.kind;
    if (c.isDir) verb = "Changes";
    else if (t.kind === "renamed" && entry?.from) verb = `Moved from ${entry.from}`;
    else if (!entry && t.kind === "deleted") verb = "Moved away";
    const stage = t.stage === "committed" ? "committed on branch" : "uncommitted";
    return { color: worktreeColor(t.colorIndex), label: w?.label ?? t.worktree, text: `${verb}, ${stage}` };
  });
  if (c.isDir) {
    const n = c.aggregate ?? 0;
    return { dir: splitPath(c.path).dir, name: `${splitPath(c.path).name}/`, detail: `${n} ${n === 1 ? "file" : "files"}`, touches };
  }
  let size = state.tree.get(c.path) ?? 0;
  for (const m of state.overlays.values()) {
    const e = m.get(c.path);
    if (e && e.kind !== "deleted") size = Math.max(size, e.size);
  }
  const { dir, name } = splitPath(c.path);
  return { dir, name, detail: humanSize(size), touches };
}
```

- [ ] **Step 9: Run the view-model tests to verify they pass**

Run: `pnpm -C web exec vitest run src/ui/models.test.ts`
Expected: PASS, `Tests  9 passed (9)`.

- [ ] **Step 10: Commit**

```bash
git add web/src/ui/format.ts web/src/ui/format.test.ts web/src/ui/theme.ts web/src/ui/theme.test.ts web/src/ui/keys.ts web/src/ui/keys.test.ts web/src/ui/models.ts web/src/ui/models.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add chrome view models, theme persistence and key map

Legend activity rule, coalesced activity rows, tooltip text and a
localStorage-safe theme store, all as pure functions.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Write the failing component tests**

`web/src/ui/Legend.test.ts`:

```ts
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeState, wt } from "../layout/fixtures";
import Legend from "./Legend.svelte";

const NOW = 50_000_000;

function repoState() {
  const s = makeState(
    { "a.ts": 1 },
    {
      w0: [{ path: "a.ts", kind: "modified", stage: "uncommitted", size: 1 }],
      w1: [
        { path: "b.ts", kind: "added", stage: "uncommitted", size: 1 },
        { path: "c.ts", kind: "added", stage: "committed", size: 1 },
      ],
    },
    [wt("w0", 0, "main"), wt("w1", 1, "feat/a"), wt("w2", 2, "fix/b"), wt("w3", 3, "chore/c")],
  );
  return s;
}

describe("Legend", () => {
  it("shows the repo name, active worktrees with changed counts, and collapses idle ones", async () => {
    render(Legend, { repo: repoState(), now: NOW, isolated: null, onIsolate: () => {} });
    expect(screen.getByRole("heading", { name: "sample-app" })).toBeInTheDocument();
    const pills = screen.getAllByTestId("worktree-pill");
    expect(pills.map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual(["main 1", "feat/a 2"]);
    expect(screen.queryByText("fix/b")).toBeNull();

    const more = screen.getByRole("button", { name: "+2 idle" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(screen.getByText("fix/b")).toBeInTheDocument();
    expect(screen.getByText("chore/c")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide idle" })).toHaveAttribute("aria-expanded", "true");
  });

  it("isolates a worktree on click and clears on a second click", async () => {
    const onIsolate = vi.fn();
    const { rerender } = render(Legend, { repo: repoState(), now: NOW, isolated: null, onIsolate });
    await userEvent.click(screen.getByRole("button", { name: /feat\/a/ }));
    expect(onIsolate).toHaveBeenLastCalledWith("w1");

    await rerender({ isolated: "w1" });
    const pill = screen.getByRole("button", { name: /feat\/a/ });
    expect(pill).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /main/ })).toHaveClass("dim");
    await userEvent.click(pill);
    expect(onIsolate).toHaveBeenLastCalledWith(null);
  });
});
```

`web/src/ui/Activity.test.ts`:

```ts
import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeState } from "../layout/fixtures";
import type { Activity as Item } from "../protocol";
import Activity from "./Activity.svelte";

const NOW = 100_000_000;

function repoWith(activity: Item[]) {
  const s = makeState({});
  s.activity = activity;
  return s;
}

describe("Activity", () => {
  it("lists newest first with base name, dimmed folder, kind and relative time", () => {
    render(Activity, {
      repo: repoWith([
        { ts: NOW - 120_000, worktree: "w2", kind: "added", path: "db/pool.ts" },
        { ts: NOW - 2_000, worktree: "w1", kind: "modified", path: "src/auth/session.ts" },
      ]),
      now: NOW,
      onHover: () => {},
      onSelect: () => {},
    });
    const rows = within(screen.getByTestId("activity")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("src/auth/session.ts");
    expect(within(rows[0]!).getByText("session.ts")).toHaveClass("name");
    expect(within(rows[0]!).getByText("src/auth/")).toHaveClass("dir");
    expect(rows[0]).toHaveTextContent("edited");
    expect(rows[0]).toHaveTextContent("now");
    expect(rows[1]).toHaveTextContent("pool.ts");
    expect(rows[1]).toHaveTextContent("new");
    expect(rows[1]).toHaveTextContent("2m");
  });

  it("shows a coalesced burst as one row with a count", () => {
    render(Activity, {
      repo: repoWith([
        { ts: NOW - 9_000, worktree: "w1", kind: "modified", path: "a.ts" },
        { ts: NOW - 6_000, worktree: "w1", kind: "modified", path: "a.ts" },
        { ts: NOW - 3_000, worktree: "w1", kind: "modified", path: "a.ts" },
      ]),
      now: NOW,
      onHover: () => {},
      onSelect: () => {},
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("edited ×3");
  });

  it("emphasises commit and merge rows", () => {
    render(Activity, {
      repo: repoWith([
        { ts: NOW - 5_000, worktree: "w1", kind: "commit", sha: "abc1234", subject: "Add session refresh", files: 3 },
        { ts: NOW - 1_000, worktree: "w1", kind: "merge", files: 1 },
      ]),
      now: NOW,
      onHover: () => {},
      onSelect: () => {},
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Merged 1 file into origin/main");
    expect(rows[1]).toHaveTextContent("Committed 3 files");
    expect(rows[1]).toHaveTextContent("Add session refresh");
    for (const r of rows) expect(r).toHaveClass("emphasis");
  });

  it("highlights on hover and selects on click", async () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    render(Activity, {
      repo: repoWith([{ ts: NOW, worktree: "w1", kind: "modified", path: "src/a.ts" }]),
      now: NOW,
      onHover,
      onSelect,
    });
    const row = screen.getByRole("button", { name: /a\.ts/ });
    await userEvent.hover(row);
    expect(onHover).toHaveBeenLastCalledWith("src/a.ts");
    await userEvent.unhover(row);
    expect(onHover).toHaveBeenLastCalledWith(null);
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });

  it("invites the user when there is nothing yet", () => {
    render(Activity, { repo: repoWith([]), now: NOW, onHover: () => {}, onSelect: () => {} });
    expect(screen.getByText(/appear here as they happen/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 12: Run them to verify they fail**

Run: `pnpm -C web exec vitest run src/ui/Legend.test.ts src/ui/Activity.test.ts`
Expected: FAIL with `Failed to resolve import "./Legend.svelte"` and `Failed to resolve import "./Activity.svelte"`.

- [ ] **Step 13: Add the design tokens**

`web/src/ui/theme.css`:

```css
/* Design tokens. Vision = approved mockup card 1; Night = card 3.
   Switched by <html data-theme="vision|night"> (see theme.ts). */
:root {
  color-scheme: dark;
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  --bg: radial-gradient(ellipse at 30% 20%, #26284a 0%, #0c0c14 55%, #07070a 100%);
  --text: #f2f2f7;
  --text-dim: rgba(235, 235, 245, 0.55);
  --text-faint: rgba(235, 235, 245, 0.32);
  --panel-bg: rgba(40, 40, 52, 0.45);
  --panel-border: rgba(255, 255, 255, 0.1);
  --panel-filter: blur(18px) saturate(1.6);
  --panel-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
  --pill-bg: rgba(255, 255, 255, 0.06);
  --pill-bg-hover: rgba(255, 255, 255, 0.1);
  --pill-bg-on: rgba(255, 255, 255, 0.16);
  --pill-border: rgba(255, 255, 255, 0.08);
  --focus: rgba(10, 132, 255, 0.9);
  --radius-panel: 14px;
  --radius-row: 8px;
  --gutter: 16px;
}

:root[data-theme="night"] {
  --bg: #000;
  --text: #f5f5f7;
  --panel-bg: transparent;
  --panel-border: transparent;
  --panel-filter: none;
  --panel-shadow: none;
  --pill-bg: transparent;
  --pill-border: rgba(255, 255, 255, 0.1);
}

html,
body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font: 12px/1.45 var(--font);
  -webkit-font-smoothing: antialiased;
}

.glass {
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-panel);
  box-shadow: var(--panel-shadow);
  backdrop-filter: var(--panel-filter);
  -webkit-backdrop-filter: var(--panel-filter);
}

/* Night: controls stay out of the way until the pointer (or keyboard focus) visits them. */
:root[data-theme="night"] .night-reveal {
  opacity: 0;
  transition: opacity 0.25s ease;
}
:root[data-theme="night"] .night-reveal:hover,
:root[data-theme="night"] .night-reveal:focus-within {
  opacity: 1;
}

button {
  font: inherit;
  color: inherit;
}
button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition: none !important;
    animation: none !important;
  }
}
```

- [ ] **Step 14: Implement the legend**

`web/src/ui/Legend.svelte`. The prop is named `repo`, not `state`: a prop called `state` collides with the `$state` rune and Svelte then treats it as a store, which fails at runtime with `store_invalid_shape`.

```svelte
<script lang="ts">
  import type { WorktreeId } from "../protocol";
  import type { RepoState } from "../store";
  import { legendModel, type LegendItem } from "./models";

  interface Props {
    repo: RepoState;
    now: number;
    isolated: WorktreeId | null;
    onIsolate: (id: WorktreeId | null) => void;
  }
  let { repo, now, isolated, onIsolate }: Props = $props();

  let showIdle = $state(false);
  const model = $derived(legendModel(repo, now));

  function toggle(id: WorktreeId): void {
    onIsolate(isolated === id ? null : id);
  }
</script>

{#snippet pill(w: LegendItem)}
  <li>
    <button
      class="pill"
      data-testid="worktree-pill"
      class:on={isolated === w.id}
      class:dim={isolated !== null && isolated !== w.id}
      aria-pressed={isolated === w.id}
      title={`${w.label}: ${w.path}`}
      onclick={() => toggle(w.id)}
    >
      <span class="dot" style:background={w.color}></span>
      <span class="label">{w.label}</span>
      {#if w.changed > 0}<span class="count" aria-label={`${w.changed} changed files`}>{w.changed}</span>{/if}
    </button>
  </li>
{/snippet}

<section class="legend glass" data-testid="legend" aria-label="Worktrees">
  <h1>{repo.repo.name}</h1>
  <p class="base">Compared with {repo.repo.base || "HEAD"}</p>
  <div class="night-reveal">
    <ul>
      {#each model.active as w (w.id)}{@render pill(w)}{/each}
    </ul>
    {#if model.idle.length > 0}
      <button class="more" aria-expanded={showIdle} onclick={() => (showIdle = !showIdle)}>
        {showIdle ? "Hide idle" : `+${model.idle.length} idle`}
      </button>
      {#if showIdle}
        <ul class="idle">
          {#each model.idle as w (w.id)}{@render pill(w)}{/each}
        </ul>
      {/if}
    {/if}
  </div>
</section>

<style>
  .legend {
    position: fixed;
    top: var(--gutter);
    left: var(--gutter);
    max-width: min(320px, calc(100vw - 2 * var(--gutter)));
    padding: 10px 12px 12px;
    z-index: 2;
  }
  h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .base {
    margin: 1px 0 8px;
    color: var(--text-faint);
    font-size: 11px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .idle {
    margin-top: 6px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 3px 9px 3px 7px;
    border-radius: 999px;
    border: 1px solid var(--pill-border);
    background: var(--pill-bg);
    font-size: 11.5px;
    cursor: pointer;
    transition:
      background 0.15s ease,
      opacity 0.15s ease;
  }
  .pill:hover {
    background: var(--pill-bg-hover);
  }
  .pill.on {
    background: var(--pill-bg-on);
    border-color: rgba(255, 255, 255, 0.22);
  }
  .pill.dim {
    opacity: 0.45;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .more {
    margin-top: 6px;
    padding: 2px 4px;
    border: 0;
    background: none;
    color: var(--text-dim);
    font-size: 11px;
    cursor: pointer;
  }
  .more:hover {
    color: var(--text);
  }
</style>
```

- [ ] **Step 15: Implement the activity stream**

`web/src/ui/Activity.svelte`:

```svelte
<script lang="ts">
  import { worktreeColor } from "../colors";
  import type { RepoState } from "../store";
  import { relativeTime, splitPath } from "./format";
  import { activityRows, rowFade, type ActivityRow } from "./models";

  interface Props {
    repo: RepoState;
    now: number;
    onHover: (path: string | null) => void;
    onSelect: (path: string) => void;
  }
  let { repo, now, onHover, onSelect }: Props = $props();

  const rows = $derived(activityRows(repo.activity));
  const VERB: Record<string, string> = { added: "new", modified: "edited", deleted: "deleted", renamed: "moved" };

  function color(row: ActivityRow): string {
    return worktreeColor(repo.worktrees.get(row.worktree)?.colorIndex ?? -1);
  }
  function who(row: ActivityRow): string {
    return repo.worktrees.get(row.worktree)?.label ?? "removed worktree";
  }
  function files(n: number | undefined): string {
    return n === undefined ? "" : ` ${n} ${n === 1 ? "file" : "files"}`;
  }
</script>

<section class="activity glass" data-testid="activity" aria-label="Activity">
  <h2>Activity</h2>
  {#if rows.length === 0}
    <p class="empty">Edits, commits and merges from every worktree appear here as they happen.</p>
  {/if}
  <ol>
    {#each rows as row (row.key)}
      <li class="row" class:emphasis={row.emphasis} style:--fade={rowFade(row.ts, now)} style:--wt={color(row)}>
        {#if row.path !== undefined}
          {@const p = splitPath(row.path)}
          <button
            class="hit"
            title={`${who(row)}: ${row.from ? `${row.from} → ` : ""}${row.path}`}
            onmouseenter={() => onHover(row.path ?? null)}
            onmouseleave={() => onHover(null)}
            onfocus={() => onHover(row.path ?? null)}
            onblur={() => onHover(null)}
            onclick={() => onSelect(row.path!)}
          >
            <span class="dot"></span>
            <span class="path"><span class="dir">{p.dir}</span><span class="name">{p.name}</span></span>
            <span class="kind">{VERB[row.kind] ?? row.kind}{row.count > 1 ? ` ×${row.count}` : ""}</span>
            <time datetime={new Date(row.ts).toISOString()}>{relativeTime(row.ts, now)}</time>
          </button>
        {:else}
          <div class="hit" title={who(row)}>
            <span class="dot"></span>
            <span class="path">
              <span class="name">{row.kind === "commit" ? `Committed${files(row.files)}` : `Merged${files(row.files)} into ${repo.repo.base || "base"}`}</span>
              {#if row.subject}<span class="subject">{row.subject}</span>{/if}
            </span>
            <time datetime={new Date(row.ts).toISOString()}>{relativeTime(row.ts, now)}</time>
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .activity {
    position: fixed;
    top: var(--gutter);
    right: var(--gutter);
    bottom: 64px;
    width: 288px;
    display: flex;
    flex-direction: column;
    padding: 10px 6px 6px;
    z-index: 2;
  }
  h2 {
    margin: 0 6px 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .empty {
    margin: 4px 6px;
    color: var(--text-faint);
    font-size: 11.5px;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .hit {
    box-sizing: border-box;
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 4px 6px;
    border: 0;
    border-radius: var(--radius-row);
    background: none;
    text-align: left;
    white-space: nowrap;
  }
  button.hit {
    cursor: pointer;
  }
  button.hit:hover {
    background: var(--pill-bg-hover);
  }
  .emphasis .hit {
    background: color-mix(in srgb, var(--wt) 14%, transparent);
    margin: 2px 0;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--wt);
    flex: none;
    align-self: center;
  }
  .path {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    column-gap: 0;
    overflow: hidden;
  }
  .dir {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-faint);
    flex: 0 1 auto;
  }
  .name {
    flex: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .emphasis .name {
    font-weight: 600;
  }
  .subject {
    flex-basis: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-dim);
    font-size: 11.5px;
  }
  .kind,
  time {
    flex: none;
    color: var(--text-faint);
    font-size: 11px;
  }
  time {
    min-width: 24px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* Night: no panel, stream sits bottom-right and fades with age. */
  :global(:root[data-theme="night"]) .activity {
    top: auto;
    bottom: 56px;
    max-height: 40vh;
  }
  :global(:root[data-theme="night"]) h2 {
    display: none;
  }
  :global(:root[data-theme="night"]) .row {
    opacity: var(--fade);
  }
  :global(:root[data-theme="night"]) .emphasis .hit {
    background: none;
  }

  @media (max-width: 720px) {
    .activity {
      top: auto;
      left: var(--gutter);
      width: auto;
      max-height: 32vh;
    }
  }
</style>
```

- [ ] **Step 16: Run the component tests to verify they pass**

Run: `pnpm -C web exec vitest run src/ui/Legend.test.ts src/ui/Activity.test.ts`
Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 17: Implement the live pill and the tooltip**

`web/src/ui/LivePill.svelte`:

```svelte
<script lang="ts">
  import type { ConnectionStatus } from "../connection";

  let { status }: { status: ConnectionStatus } = $props();
  const text = $derived(status === "open" ? "Live" : status === "connecting" ? "Connecting…" : "Reconnecting…");
</script>

<div class="pill glass" class:night-reveal={status === "open"} data-testid="live-pill" data-status={status} role="status" aria-live="polite">
  <span class="dot" aria-hidden="true"></span>{text}
</div>

<style>
  .pill {
    position: fixed;
    left: 50%;
    bottom: var(--gutter);
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 14px 5px 11px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--text-dim);
    z-index: 2;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #30d158;
    box-shadow: 0 0 8px rgba(48, 209, 88, 0.7);
  }
  [data-status="open"] {
    color: var(--text);
  }
  [data-status="open"] .dot {
    animation: breathe 2.4s ease-in-out infinite;
  }
  [data-status="connecting"] .dot {
    background: #8e8e93;
    box-shadow: none;
  }
  [data-status="reconnecting"] .dot {
    background: #ff9f0a;
    box-shadow: 0 0 8px rgba(255, 159, 10, 0.6);
  }
  @keyframes breathe {
    50% {
      opacity: 0.45;
    }
  }
</style>
```

`web/src/ui/Tooltip.svelte`:

```svelte
<script lang="ts">
  import type { TooltipInfo } from "./models";

  let { info, x, y }: { info: TooltipInfo | null; x: number; y: number } = $props();

  const OFFSET = 14;
  const WIDTH = 280;
  let viewportW = $state(typeof window === "undefined" ? 1024 : window.innerWidth);
  let viewportH = $state(typeof window === "undefined" ? 768 : window.innerHeight);
  const left = $derived(x + OFFSET + WIDTH > viewportW ? x - OFFSET - WIDTH : x + OFFSET);
  const top = $derived(Math.min(y + OFFSET, viewportH - 120));
</script>

<svelte:window bind:innerWidth={viewportW} bind:innerHeight={viewportH} />

{#if info}
  <div class="tip glass" role="tooltip" data-testid="tooltip" style:left={`${left}px`} style:top={`${top}px`}>
    <div class="path"><span class="dir">{info.dir}</span><span class="name">{info.name}</span></div>
    <div class="detail">{info.detail}</div>
    {#if info.touches.length > 0}
      <ul>
        {#each info.touches as t, i (i)}
          <li><span class="dot" style:background={t.color}></span><span class="who">{t.label}</span><span class="what">{t.text}</span></li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .tip {
    position: fixed;
    width: max-content;
    max-width: 280px;
    padding: 8px 10px;
    pointer-events: none;
    z-index: 3;
  }
  :global(:root[data-theme="night"]) .tip {
    background: rgba(20, 20, 24, 0.92);
    border-color: rgba(255, 255, 255, 0.08);
  }
  .path {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .dir {
    color: var(--text-dim);
  }
  .detail {
    color: var(--text-dim);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  ul {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 11.5px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
    align-self: center;
  }
  .what {
    color: var(--text-dim);
  }
</style>
```

- [ ] **Step 18: Compose the app and load the tokens**

Replace `web/src/main.ts` with:

```ts
import { mount } from "svelte";
import "./ui/theme.css";
import App from "./ui/App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app element missing from index.html");

export default mount(App, { target });
```

Replace `web/src/ui/App.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { connect, type ConnectionStatus } from "../connection";
  import { computeFrame } from "../layout/frame";
  import type { Circle } from "../layout/pack";
  import type { WorktreeId } from "../protocol";
  import { clickTarget, parentDir } from "../render/geometry";
  import { MapRenderer } from "../render/MapRenderer";
  import { RepoStore, type Change, type RepoState } from "../store";
  import Activity from "./Activity.svelte";
  import { keyAction } from "./keys";
  import Legend from "./Legend.svelte";
  import LivePill from "./LivePill.svelte";
  import { tooltipInfo, type TooltipInfo } from "./models";
  import { applyTheme, loadTheme, saveTheme, type Theme } from "./theme";
  import Tooltip from "./Tooltip.svelte";

  const store = new RepoStore();
  let repo: RepoState | null = $state.raw(null);
  let status: ConnectionStatus = $state("connecting");
  let theme: Theme = $state(loadTheme());
  let isolated: WorktreeId | null = $state(null);
  let now = $state(Date.now());
  let tip: { info: TooltipInfo; x: number; y: number } | null = $state.raw(null);

  let mapEl: HTMLDivElement;
  let renderer: MapRenderer | null = null;
  let layout = new Map<string, Circle>();
  let zoomPath = "";
  let scale = 1;
  const MAP_PAD = 48; // keeps the repo circle clear of the panels and live pill

  $effect(() => {
    applyTheme(theme);
    saveTheme(theme);
    renderer?.setTheme(theme);
  });

  $effect(() => {
    renderer?.isolate(isolated);
  });

  function relayout(change: Change): void {
    const s = store.state;
    if (!s || !renderer) return;
    const f = computeFrame(s, mapEl.clientWidth, mapEl.clientHeight, scale, MAP_PAD);
    layout = f.layout;
    renderer.update(f.layout, f.visuals, change);
  }

  function zoom(path: string): void {
    zoomPath = path;
    renderer?.zoomTo(path);
  }

  function onKey(e: KeyboardEvent): void {
    const action = keyAction(e);
    if (action === "theme") theme = theme === "vision" ? "night" : "vision";
    else if (action === "zoomOut") zoom("");
    else if (action === "fullscreen") {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }

  onMount(() => {
    const r = new MapRenderer(mapEl);
    let disposed = false;
    let stop = (): void => {};
    const off = store.subscribe((s, change) => {
      repo = s;
      relayout(change);
    });
    const tick = setInterval(() => (now = Date.now()), 5000);
    const onResize = (): void => relayout({ kind: "patch", merged: [] });

    void r.init().then(() => {
      if (disposed) return;
      renderer = r;
      r.setTheme(theme);
      r.isolate(isolated);
      r.onZoom((k) => {
        scale = k;
        relayout({ kind: "patch", merged: [] });
      });
      r.onClick((path) => zoom(clickTarget(path, layout, zoomPath)));
      r.onHover((path, at) => {
        const c = path === null ? undefined : layout.get(path);
        const info = c && repo ? tooltipInfo(repo, c) : null;
        tip = info ? { info, x: at.x, y: at.y } : null;
      });
      relayout({ kind: "snapshot", merged: [] });
      stop = connect(store, { onStatus: (s) => (status = s) });
    });
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      clearInterval(tick);
      window.removeEventListener("resize", onResize);
      off();
      stop();
      r.destroy();
      renderer = null;
    };
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="map" data-testid="map" bind:this={mapEl}></div>

{#if repo}
  <Legend {repo} {now} {isolated} onIsolate={(id) => (isolated = id)} />
  <Activity {repo} {now} onHover={(p) => renderer?.highlight(p)} onSelect={(p) => zoom(parentDir(p))} />
{/if}
<LivePill {status} />
<Tooltip info={tip?.info ?? null} x={tip?.x ?? 0} y={tip?.y ?? 0} />

<style>
  .map {
    position: fixed;
    inset: 0;
  }
</style>
```

- [ ] **Step 19: Run the full web check**

Run: `pnpm -C web lint && pnpm -C web test && pnpm -C web build`
Expected: lint prints `0 ERRORS 0 WARNINGS`; tests print `Test Files  17 passed (17)` and `Tests  130 passed (130)`; build prints `✓ built in`.

- [ ] **Step 20: Look at both themes**

Run the app as in Task 11b Step 9. Check each of these:
- the legend top-left shows the repo name and pills with counts, and "+N idle" expands;
- clicking a pill dims the other worktrees' glows;
- activity rows appear right, and hovering one rings the file on the map;
- the tooltip follows the pointer over files;
- "● Live" sits bottom-centre;
- pressing `N` turns everything black with graphite bubbles and hides the pills until hovered;
- reloading keeps Night;
- pressing `F` goes fullscreen.

- [ ] **Step 21: Commit**

```bash
git add web/src/ui/theme.css web/src/ui/Legend.svelte web/src/ui/Legend.test.ts web/src/ui/Activity.svelte web/src/ui/Activity.test.ts web/src/ui/LivePill.svelte web/src/ui/Tooltip.svelte web/src/ui/App.svelte web/src/main.ts
git commit -m "$(cat <<'EOF'
feat(web): add legend, activity stream, live pill, tooltip and themes

Vision frosted-glass panels and the Night HUD from the approved
mockups; N/F/Esc shortcuts; theme remembered across reloads.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 22: Rebase, push and open the PR**

```bash
git fetch origin && git rebase origin/main
pnpm -C web lint && pnpm -C web test && pnpm -C web build
git push -u origin feat/web-chrome
gh pr create --base main --head feat/web-chrome --title "feat(web): chrome panels, themes and keyboard" --body "$(cat <<'EOF'
## Summary
- Legend: repo name, active worktree pills (colour, label, changed count), "+N idle" expander, click to isolate.
- Activity stream: newest first, coalesced bursts, emphasised commit/merge rows, hover highlights and click zooms on the map.
- Live pill, hover tooltip (path, size, touching worktrees and stage).
- Vision (frosted glass) and Night (black HUD, fade-on-hover, age-faded rows) themes; `N`, `F`, `Esc`; theme persisted safely.

## Test plan
- [x] `pnpm -C web test` (130 tests incl. Legend and Activity component tests)
- [x] `pnpm -C web lint`, `pnpm -C web build`
- [x] Manual check of both themes against a synthetic repo

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```


---

### Task 13: Demo script (`scripts/demo`)

A self-contained Go program that builds a **fully synthetic** repo (an invented star-catalogue project called "nebula") with ~240 files and a 40-commit history, adds agent worktrees (nested and outside the root), then simulates agents and a human editing, moving, committing and merging, forever or for a fixed number of steps. Only the standard library is used, and it shells out to `git` through `os/exec`. Task 14 and the README screenshot depend on it.

**Files:**
- Create: `scripts/demo/main.go` (flags, directory safety, `run`)
- Create: `scripts/demo/git.go` (git exec helper, isolated config, synthetic identities)
- Create: `scripts/demo/gen.go` (synthetic project content and deterministic history)
- Create: `scripts/demo/sim.go` (agents, human, actions, merge + respawn, loop)
- Test: `scripts/demo/demo_test.go`

**Interfaces:**
- Consumes: Task 1's `go.mod` (module `github.com/olliejudge/orion`, Go 1.27) and the `make lint` target. Nothing else. The demo imports no orion package, so it can merge in wave 2.
- Produces, for Task 14, the README and humans:
  - CLI: `go run ./scripts/demo [--dir DIR] [--agents N] [--seed N] [--speed X] [--once] [--steps N]`. Defaults: `--dir $TMPDIR/orion-demo/nebula`, `--agents 3` (range 1–8), `--seed 1`, `--speed 1.0`, `--steps 40` (used only with `--once`).
  - Layout: the main worktree is `DIR` on branch `main`. Agent slot *i* uses theme `themes[i]` (`ui`, `api`, `guides`, `store`, `pages`, `catalog`, `k8s`, `auth`). Even slots are **nested**, at `DIR/.claude/worktrees/agent-<slug>[-n]`; odd slots are **outside** the root, at `DIR.wt/agent-<slug>[-n]`. Each is on branch `agent/<slug>[-n]`. With `--agents ≥ 2` there is always at least one of each kind. The repo's `.gitignore` contains `.claude/worktrees/`.
  - State after `--once`: `1 + agents` worktrees; every agent branch has at least one commit that is not on `main`; every worktree, including main, has at least one uncommitted change. The exit code is 0.
  - Stdout: the lines `demo repo ready: <abs DIR>` and `watch it with:   orion <abs DIR>`, then one line per action: `HH:MM:SS  <actor> <verb> <path>`. In live mode, SIGINT or SIGTERM prints `stopped; the demo repo is left at <DIR>` and exits 0. Errors go to stderr and exit 1.
  - Safety: the program deletes `DIR` and `DIR.wt` only if they are empty or carry its marker (`DIR/.git/orion-demo` or `DIR.wt/orion-demo`). Anything else gets `refusing to overwrite …` and exit 1.
  - Determinism: the same `--seed` gives byte-identical history, including the HEAD SHA of the initial 40 commits, because dates and identities are fixed and the user's global and system git config are ignored.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/feat-demo -b feat/demo main
cd .claude/worktrees/feat-demo
```

- [ ] **Step 2: Write the failing tests**

Create `scripts/demo/demo_test.go`:

```go
package main

import (
	"bytes"
	"context"
	"io"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
}

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := git(dir, nil, args...)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

type wt struct{ path, branch string }

func worktrees(t *testing.T, root string) []wt {
	t.Helper()
	var res []wt
	for _, block := range strings.Split(strings.TrimSpace(mustGit(t, root, "worktree", "list", "--porcelain")), "\n\n") {
		var w wt
		for _, ln := range strings.Split(block, "\n") {
			if p, ok := strings.CutPrefix(ln, "worktree "); ok {
				w.path = p
			}
			if b, ok := strings.CutPrefix(ln, "branch refs/heads/"); ok {
				w.branch = b
			}
		}
		res = append(res, w)
	}
	return res
}

func TestOnceBuildsRepoWithNestedAndOutsideWorktrees(t *testing.T) {
	requireGit(t)
	dir := filepath.Join(t.TempDir(), "nebula")
	var out bytes.Buffer
	cfg := config{Dir: dir, Agents: 3, Seed: 7, Speed: 1, Once: true, Steps: 40}
	if err := run(context.Background(), cfg, &out); err != nil {
		t.Fatalf("run: %v\n%s", err, out.String())
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}

	wts := worktrees(t, root)
	if len(wts) != 4 {
		t.Fatalf("want 4 worktrees (main + 3 agents), got %d: %+v", len(wts), wts)
	}
	if wts[0].path != root || wts[0].branch != "main" {
		t.Fatalf("first worktree = %+v, want %s on main", wts[0], root)
	}
	nested, outside := 0, 0
	branches := map[string]bool{}
	for _, w := range wts[1:] {
		if !strings.HasPrefix(w.branch, "agent/") {
			t.Errorf("worktree %s is on %q, want an agent/* branch", w.path, w.branch)
		}
		branches[w.branch] = true
		switch {
		case strings.HasPrefix(w.path, filepath.Join(root, ".claude", "worktrees", "agent-")):
			nested++
		case !strings.HasPrefix(w.path, root+string(filepath.Separator)):
			outside++
		}
		if st := mustGit(t, w.path, "status", "--porcelain"); st == "" {
			t.Errorf("worktree %s has no uncommitted changes", w.path)
		}
		ahead, _ := strconv.Atoi(strings.TrimSpace(mustGit(t, root, "rev-list", "--count", "main.."+w.branch)))
		if ahead == 0 {
			t.Errorf("branch %s has no commits ahead of main", w.branch)
		}
	}
	if nested == 0 || outside == 0 {
		t.Errorf("want >=1 nested and >=1 outside worktree, got nested=%d outside=%d", nested, outside)
	}
	if len(branches) != 3 {
		t.Errorf("want 3 distinct agent branches, got %v", branches)
	}
	if st := mustGit(t, root, "status", "--porcelain"); st == "" {
		t.Error("main worktree has no uncommitted changes")
	}
	if st := mustGit(t, root, "status", "--porcelain", "--untracked-files=all"); strings.Contains(st, ".claude/") {
		t.Errorf("nested worktrees leak into main's status:\n%s", st)
	}
	commits, _ := strconv.Atoi(strings.TrimSpace(mustGit(t, root, "rev-list", "--count", "main")))
	if commits < historyCommits {
		t.Errorf("main has %d commits, want >= %d", commits, historyCommits)
	}
	files := strings.Count(mustGit(t, root, "ls-tree", "-r", "--name-only", "main"), "\n")
	if files < 150 || files > 300 {
		t.Errorf("main has %d files, want 150..300", files)
	}
	if !strings.Contains(out.String(), "orion "+root) {
		t.Errorf("output does not tell the user how to run orion:\n%s", out.String())
	}
}

func TestBuildRepoIsDeterministic(t *testing.T) {
	requireGit(t)
	head := func(seed uint64) string {
		root := t.TempDir()
		rng := rand.New(rand.NewPCG(seed, 0x6f72696f6e))
		if err := buildRepo(root, rng, newNamer(rng), &logger{w: io.Discard}); err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(mustGit(t, root, "rev-parse", "HEAD"))
	}
	a, b, c := head(3), head(3), head(4)
	if a != b {
		t.Errorf("same seed gave different HEADs: %s vs %s", a, b)
	}
	if a == c {
		t.Errorf("different seeds gave the same HEAD %s", a)
	}
}

func TestMergeRespawnsAgentInSameSlot(t *testing.T) {
	requireGit(t)
	dir := filepath.Join(t.TempDir(), "nebula")
	if err := prepareDir(dir); err != nil {
		t.Fatal(err)
	}
	root, _ := filepath.EvalSymlinks(dir)
	rng := rand.New(rand.NewPCG(1, 2))
	nm := newNamer(rng)
	log := &logger{w: io.Discard}
	if err := buildRepo(root, rng, nm, log); err != nil {
		t.Fatal(err)
	}
	s := newSim(config{Agents: 2, Speed: 1}, root, rng, nm, log)
	if err := s.spawnInitialAgents(); err != nil {
		t.Fatal(err)
	}
	a := s.agents[0]
	for i := 0; i < 4; i++ {
		if _, err := s.agentAction(a); err != nil {
			t.Fatal(err)
		}
	}
	created := s.nm.next(a.Theme.Dir, ".tsx", s.exists(a))
	if err := writeFile(a.Dir, created, []byte("export {};\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.humanAction(); err != nil {
		t.Fatal(err)
	}
	s.you.Pending = 1

	if err := s.mergeAndRespawn(a); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(created))); err != nil {
		t.Errorf("merged file %s missing from main worktree: %v", created, err)
	}
	if n := strings.TrimSpace(mustGit(t, root, "rev-list", "--merges", "--count", "main")); n != "1" {
		t.Errorf("want 1 merge commit on main, got %s", n)
	}
	br := mustGit(t, root, "branch", "--list", "agent/*", "--format=%(refname:short)")
	if strings.Contains(br, "agent/ui\n") || !strings.Contains(br, "agent/ui-2\n") {
		t.Errorf("want agent/ui replaced by agent/ui-2, branches:\n%s", br)
	}
	if s.agents[0].Name != "agent-ui-2" || !s.agents[0].Nested {
		t.Errorf("respawned agent = %+v, want nested agent-ui-2", s.agents[0])
	}
	if got := len(worktrees(t, root)); got != 3 {
		t.Errorf("want 3 worktrees after respawn, got %d", got)
	}
}

func TestRefusesToOverwriteForeignDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "precious.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := run(context.Background(), config{Dir: dir, Agents: 1, Speed: 1, Once: true}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("want refusal, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "precious.txt")); err != nil {
		t.Fatalf("foreign file was touched: %v", err)
	}
}

func TestRerunReplacesPreviousDemo(t *testing.T) {
	requireGit(t)
	dir := filepath.Join(t.TempDir(), "nebula")
	cfg := config{Dir: dir, Agents: 2, Seed: 1, Speed: 1, Once: true, Steps: 5}
	for i := 0; i < 2; i++ {
		if err := run(context.Background(), cfg, io.Discard); err != nil {
			t.Fatalf("run %d: %v", i+1, err)
		}
	}
}

func TestValidateRejectsBadFlags(t *testing.T) {
	for _, c := range []config{
		{Dir: "x", Agents: 0, Speed: 1},
		{Dir: "x", Agents: maxAgents + 1, Speed: 1},
		{Dir: "x", Agents: 1, Speed: 0},
		{Dir: "x", Agents: 1, Speed: 1, Steps: -1},
		{Dir: "", Agents: 1, Speed: 1},
	} {
		if err := c.validate(); err == nil {
			t.Errorf("validate(%+v) = nil, want error", c)
		}
	}
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go test ./scripts/demo/ -count=1`
Expected: FAIL to compile, with errors such as `undefined: run`, `undefined: config`, `undefined: buildRepo`, `undefined: git`.

- [ ] **Step 4: Write the git helper**

Create `scripts/demo/git.go`:

```go
package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// person is a synthetic commit author. Every identity in the demo is invented.
type person struct {
	Name  string
	Email string
}

var human = person{Name: "Ada Vega", Email: "ada@nebula.invalid"}

func agentPerson(name string) person {
	return person{Name: name, Email: name + "@nebula.invalid"}
}

// isolatedEnv keeps the user's global/system git config (signing, hooks,
// templates, aliases) out of the demo so it behaves the same everywhere.
var isolatedEnv = []string{
	"GIT_CONFIG_GLOBAL=" + os.DevNull,
	"GIT_CONFIG_NOSYSTEM=1",
	"GIT_TERMINAL_PROMPT=0",
	"LC_ALL=C",
}

// git runs `git args...` in dir and returns stdout. The error carries the
// arguments and stderr. It deliberately does not take a context: a git
// process killed mid-write can leave index.lock behind.
func git(dir string, env []string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(append(os.Environ(), isolatedEnv...), env...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s (in %s): %w: %s", strings.Join(args, " "), dir, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// identityEnv sets author and committer to p at time when.
func identityEnv(p person, when time.Time) []string {
	date := when.Format("2006-01-02T15:04:05-0700")
	return []string{
		"GIT_AUTHOR_NAME=" + p.Name, "GIT_AUTHOR_EMAIL=" + p.Email, "GIT_AUTHOR_DATE=" + date,
		"GIT_COMMITTER_NAME=" + p.Name, "GIT_COMMITTER_EMAIL=" + p.Email, "GIT_COMMITTER_DATE=" + date,
	}
}

// commitAll stages everything in the worktree at dir and commits it.
// It returns false (and no error) when there was nothing to commit.
func commitAll(dir string, p person, when time.Time, msg string) (bool, error) {
	if _, err := git(dir, nil, "add", "-A"); err != nil {
		return false, err
	}
	out, err := git(dir, nil, "status", "--porcelain", "-z")
	if err != nil {
		return false, err
	}
	if out == "" {
		return false, nil
	}
	if _, err := git(dir, identityEnv(p, when), "commit", "-q", "-m", msg); err != nil {
		return false, err
	}
	return true, nil
}
```

- [ ] **Step 5: Write the synthetic project generator**

Create `scripts/demo/gen.go`. Every name and word in it is invented; do not add names or content from any real repository (Global Constraints: Privacy).

```go
package main

import (
	"bytes"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// The demo project is "nebula", an invented star-catalogue service. Nothing
// here is copied from any real repository.

var words = []string{
	"star", "orbit", "comet", "nova", "quasar", "pulsar", "photon", "lens", "sky",
	"chart", "tile", "index", "query", "cache", "session", "token", "observer",
	"telescope", "filter", "export", "import", "sync", "metric", "alert", "feed",
	"search", "route", "schema", "render", "parallax", "redshift", "magnitude",
	"ephemeris", "epoch", "horizon", "zenith", "azimuth", "catalog", "survey",
	"cluster", "galaxy", "spectrum", "flux", "transit", "eclipse",
}

// area is one folder of the synthetic project.
type area struct {
	Dir   string // repo-relative, slash-separated
	Ext   string // extension of files created here
	Count int    // files in the initial project
	Scope string // conventional-commit scope
}

var areas = []area{
	{"cmd/nebula", ".go", 4, "cli"},
	{"cmd/nebula-migrate", ".go", 2, "cli"},
	{"internal/api", ".go", 18, "api"},
	{"internal/store", ".go", 14, "store"},
	{"internal/store/migrations", ".sql", 10, "store"},
	{"internal/catalog", ".go", 14, "catalog"},
	{"internal/auth", ".go", 10, "auth"},
	{"internal/telemetry", ".go", 8, "telemetry"},
	{"pkg/starmath", ".go", 8, "starmath"},
	{"web/src/components", ".tsx", 30, "ui"},
	{"web/src/components/styles", ".css", 8, "ui"},
	{"web/src/pages", ".tsx", 12, "pages"},
	{"web/src/hooks", ".ts", 8, "ui"},
	{"web/src/lib", ".ts", 10, "ui"},
	{"web/public/img", ".png", 8, "ui"},
	{"web/public/icons", ".svg", 6, "ui"},
	{"docs", ".md", 5, "docs"},
	{"docs/guides", ".md", 10, "docs"},
	{"docs/adr", ".md", 8, "docs"},
	{"deploy/k8s", ".yaml", 8, "deploy"},
	{"deploy/terraform", ".tf", 6, "deploy"},
	{"scripts", ".sh", 5, "build"},
	{"testdata/fixtures", ".json", 12, "test"},
}

var rootFiles = []string{
	"README.md", "LICENSE", "Makefile", "go.mod", "go.sum", ".gitignore",
	".editorconfig", "Dockerfile", "docker-compose.yaml",
	"web/package.json", "web/tsconfig.json", "web/vite.config.ts", "web/index.html",
}

const historyCommits = 40

// historyStart is fixed so that the same seed always yields the same SHAs.
var historyStart = time.Date(2026, 1, 5, 9, 0, 0, 0, time.UTC)

func areaFor(dir string) (area, bool) {
	for _, a := range areas {
		if a.Dir == dir {
			return a, true
		}
	}
	return area{}, false
}

func scopeFor(rel string) string {
	best := ""
	scope := "repo"
	for _, a := range areas {
		if strings.HasPrefix(rel, a.Dir+"/") && len(a.Dir) > len(best) {
			best, scope = a.Dir, a.Scope
		}
	}
	return scope
}

func pascal(w string) string { return strings.ToUpper(w[:1]) + w[1:] }

// namer invents unique, convention-following file names.
type namer struct {
	rng   *rand.Rand
	taken map[string]bool
	seq   map[string]int
}

func newNamer(rng *rand.Rand) *namer {
	return &namer{rng: rng, taken: map[string]bool{}, seq: map[string]int{}}
}

// next returns an unused repo-relative path for a new file in dir with ext.
// exists (may be nil) reports whether a candidate already exists on disk.
func (n *namer) next(dir, ext string, exists func(rel string) bool) string {
	for {
		w1 := words[n.rng.IntN(len(words))]
		w2 := words[n.rng.IntN(len(words))]
		if w1 == w2 {
			continue
		}
		var base string
		switch ext {
		case ".go":
			base = w1 + "_" + w2
			if n.rng.IntN(4) == 0 {
				base += "_test"
			}
		case ".tsx":
			base = pascal(w1) + pascal(w2)
		case ".css":
			base = pascal(w1) + pascal(w2) + ".module"
		case ".ts":
			if strings.HasSuffix(dir, "hooks") {
				base = "use" + pascal(w1) + pascal(w2)
			} else {
				base = w1 + pascal(w2)
			}
		case ".sql":
			n.seq[dir]++
			base = fmt.Sprintf("%04d_create_%s_%s", n.seq[dir], w1, w2)
		default:
			base = w1 + "-" + w2
		}
		rel := path.Join(dir, base+ext)
		if n.taken[rel] || (exists != nil && exists(rel)) {
			continue
		}
		n.taken[rel] = true
		return rel
	}
}

// sizeFor picks a target size in bytes, skewed towards small files.
func sizeFor(ext string, rng *rand.Rand) int {
	lo, hi := 200, 2500
	switch ext {
	case ".go":
		lo, hi = 400, 6000
	case ".tsx":
		lo, hi = 300, 4000
	case ".css", ".sh", ".sql":
		lo, hi = 150, 1500
	case ".md":
		lo, hi = 500, 9000
	case ".json":
		lo, hi = 300, 8000
		if rng.IntN(10) == 0 {
			lo, hi = 60000, 160000
		}
	case ".png":
		lo, hi = 2000, 60000
	}
	return lo + int(float64(hi-lo)*math.Pow(rng.Float64(), 2))
}

func header(rel string) string {
	ext := path.Ext(rel)
	name := strings.TrimSuffix(path.Base(rel), ext)
	switch ext {
	case ".go":
		pkg := strings.ReplaceAll(path.Base(path.Dir(rel)), "-", "")
		if strings.HasPrefix(rel, "cmd/") {
			pkg = "main"
		}
		return "package " + pkg + "\n"
	case ".tsx", ".ts":
		return "import { useMemo } from \"react\";\n"
	case ".md":
		return "# " + strings.ReplaceAll(name, "-", " ") + "\n"
	case ".sql":
		return "-- migration " + name + "\n"
	case ".sh":
		return "#!/usr/bin/env bash\nset -euo pipefail\n"
	case ".yaml":
		return "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: nebula-" + name + "\n"
	case ".svg":
		return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\">\n"
	case ".json":
		return "[\n"
	}
	return ""
}

func footer(ext string) string {
	switch ext {
	case ".svg":
		return "</svg>\n"
	case ".json":
		return "  {}\n]\n"
	}
	return ""
}

// line returns one plausible chunk of text for a file with extension ext.
func line(ext string, rng *rand.Rand) string {
	w1 := words[rng.IntN(len(words))]
	w2 := words[rng.IntN(len(words))]
	k := rng.IntN(97) + 2
	switch ext {
	case ".go":
		return fmt.Sprintf("\n// %s%s returns the %s %s for n.\nfunc %s%s%d(n int) int {\n\treturn n * %d\n}\n", pascal(w1), pascal(w2), w1, w2, pascal(w1), pascal(w2), k, k)
	case ".tsx":
		return fmt.Sprintf("\nexport function %s%s%d() {\n  const v = useMemo(() => %d, []);\n  return <div className=\"%s-%s\">{v}</div>;\n}\n", pascal(w1), pascal(w2), k, k, w1, w2)
	case ".ts":
		return fmt.Sprintf("\nexport const %s%s%d = (n: number): number => n * %d;\n", w1, pascal(w2), k, k)
	case ".css":
		return fmt.Sprintf(".%s-%s { margin: %dpx; opacity: 0.%d; }\n", w1, w2, k%24, k%10)
	case ".md":
		return fmt.Sprintf("\nThe %s keeps a %s of every %s so that %s queries stay fast (%d ms budget).\n", w1, w2, words[rng.IntN(len(words))], w1, k)
	case ".sql":
		return fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s_%s_%d (id BIGINT PRIMARY KEY, %s TEXT NOT NULL);\n", w1, w2, k, w2)
	case ".yaml":
		return fmt.Sprintf("  # %s %s\n  %s%d: \"%d\"\n", w1, w2, w1, k, k)
	case ".tf":
		return fmt.Sprintf("\nresource \"nebula_%s\" \"%s_%d\" {\n  size = %d\n}\n", w1, w2, k, k)
	case ".sh":
		return fmt.Sprintf("echo \"%s %s %d\"\n", w1, w2, k)
	case ".json":
		return fmt.Sprintf("  {\"id\": %d, \"name\": \"%s-%s\", \"magnitude\": %d.%d},\n", rng.IntN(1_000_000), w1, w2, k%7, k%10)
	case ".svg":
		return fmt.Sprintf("  <circle cx=\"%d\" cy=\"%d\" r=\"%d\"/>\n", k%64, (k*7)%64, k%9+1)
	case ".png":
		b := make([]byte, 256)
		for i := range b {
			b[i] = byte(rng.UintN(256))
		}
		return string(b)
	}
	return fmt.Sprintf("# %s %s %d\n", w1, w2, k)
}

// content generates a whole file for rel.
func content(rel string, rng *rand.Rand) []byte {
	ext := path.Ext(rel)
	target := sizeFor(ext, rng)
	var b bytes.Buffer
	if ext == ".png" {
		b.WriteString("\x89PNG\r\n\x1a\n")
	} else {
		b.WriteString(header(rel))
	}
	for b.Len() < target {
		b.WriteString(line(ext, rng))
	}
	b.WriteString(footer(ext))
	return b.Bytes()
}

func rootContent(rel string) []byte {
	switch rel {
	case "README.md":
		return []byte("# nebula\n\nA tiny self-hosted star catalogue. (Synthetic demo project for orion.)\n")
	case "LICENSE":
		return []byte("MIT License\n\nCopyright (c) 2026 The Nebula Authors (fictional)\n")
	case "Makefile":
		return []byte(".PHONY: build test\nbuild:\n\tgo build ./...\ntest:\n\tgo test ./...\n")
	case "go.mod":
		return []byte("module example.invalid/nebula\n\ngo 1.27\n")
	case "go.sum":
		return []byte("")
	case ".gitignore":
		return []byte("/bin/\nnode_modules/\ndist/\n.claude/worktrees/\n")
	case ".editorconfig":
		return []byte("root = true\n\n[*]\nindent_style = tab\n")
	case "Dockerfile":
		return []byte("FROM golang:1.27 AS build\nWORKDIR /src\nCOPY . .\nRUN go build -o /nebula ./cmd/nebula\n")
	case "docker-compose.yaml":
		return []byte("services:\n  nebula:\n    build: .\n    ports: [\"8080:8080\"]\n")
	case "web/package.json":
		return []byte("{\n  \"name\": \"nebula-web\",\n  \"private\": true,\n  \"type\": \"module\"\n}\n")
	case "web/tsconfig.json":
		return []byte("{\n  \"compilerOptions\": { \"strict\": true, \"jsx\": \"react-jsx\" }\n}\n")
	case "web/vite.config.ts":
		return []byte("import { defineConfig } from \"vite\";\n\nexport default defineConfig({});\n")
	case "web/index.html":
		return []byte("<!doctype html>\n<title>nebula</title>\n<div id=\"root\"></div>\n")
	}
	return []byte("\n")
}

func writeFile(root, rel string, data []byte) error {
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

func appendFile(root, rel string, data string) error {
	f, err := os.OpenFile(filepath.Join(root, filepath.FromSlash(rel)), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(data); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// buildRepo initialises root as a git repo on main and writes a synthetic
// history of historyCommits commits. The same rng seed gives identical SHAs.
func buildRepo(root string, rng *rand.Rand, nm *namer, log *logger) error {
	if _, err := git(root, nil, "init", "-q", "-b", "main"); err != nil {
		return err
	}
	var planned []string
	for _, a := range areas {
		for i := 0; i < a.Count; i++ {
			planned = append(planned, nm.next(a.Dir, a.Ext, nil))
		}
	}
	for _, rel := range rootFiles {
		nm.taken[rel] = true
		if err := writeFile(root, rel, rootContent(rel)); err != nil {
			return err
		}
	}
	firstBatch := len(planned) * 3 / 10
	var present []string
	for _, rel := range planned[:firstBatch] {
		if err := writeFile(root, rel, content(rel, rng)); err != nil {
			return err
		}
		present = append(present, rel)
	}
	when := historyStart
	if _, err := commitAll(root, human, when, "chore: scaffold nebula"); err != nil {
		return err
	}
	pool := planned[firstBatch:]
	for i := 1; i < historyCommits; i++ {
		when = when.Add(time.Duration(3+rng.IntN(20)) * time.Hour)
		left := historyCommits - i
		take := (len(pool) + left - 1) / left
		batch := pool[:take]
		pool = pool[take:]
		var msg string
		for _, rel := range batch {
			if err := writeFile(root, rel, content(rel, rng)); err != nil {
				return err
			}
		}
		switch {
		case i%9 == 0 && len(present) > 0:
			j := rng.IntN(len(present))
			old := present[j]
			renamed := nm.next(path.Dir(old), path.Ext(old), nil)
			if err := os.Rename(filepath.Join(root, filepath.FromSlash(old)), filepath.Join(root, filepath.FromSlash(renamed))); err != nil {
				return err
			}
			present[j] = renamed
			msg = fmt.Sprintf("refactor(%s): rename %s to %s", scopeFor(old), path.Base(old), path.Base(renamed))
		case len(batch) > 0:
			msg = fmt.Sprintf("feat(%s): add %s", scopeFor(batch[0]), strings.TrimSuffix(path.Base(batch[0]), path.Ext(batch[0])))
			if len(batch) > 1 {
				msg += fmt.Sprintf(" and %d more", len(batch)-1)
			}
		default:
			msg = "chore: tidy"
		}
		for k := 0; k < 1+rng.IntN(3) && len(present) > 0; k++ {
			rel := present[rng.IntN(len(present))]
			if err := appendFile(root, rel, line(path.Ext(rel), rng)); err != nil {
				return err
			}
		}
		present = append(present, batch...)
		if _, err := commitAll(root, human, when, msg); err != nil {
			return err
		}
	}
	log.printf("created nebula with %d files and %d commits on main", len(present)+len(rootFiles), historyCommits)
	return nil
}
```

- [ ] **Step 6: Write the simulator**

Create `scripts/demo/sim.go`:

```go
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
```

- [ ] **Step 7: Write the entrypoint**

Create `scripts/demo/main.go`:

```go
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

func (c config) validate() error {
	if c.Dir == "" {
		return errors.New("--dir must not be empty")
	}
	if c.Agents < 1 || c.Agents > maxAgents {
		return fmt.Errorf("--agents must be between 1 and %d, got %d", maxAgents, c.Agents)
	}
	if c.Speed <= 0 {
		return fmt.Errorf("--speed must be > 0, got %g", c.Speed)
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
	defer stop()
	if err := run(ctx, cfg, os.Stdout); err != nil {
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
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `go test ./scripts/demo/ -count=1 -v 2>&1 | grep -E '^(--- |ok|FAIL)'`
Expected (timings vary, total about 15 s):
```
--- PASS: TestOnceBuildsRepoWithNestedAndOutsideWorktrees
--- PASS: TestBuildRepoIsDeterministic
--- PASS: TestMergeRespawnsAgentInSameSlot
--- PASS: TestRefusesToOverwriteForeignDir
--- PASS: TestRerunReplacesPreviousDemo
--- PASS: TestValidateRejectsBadFlags
ok  	github.com/olliejudge/orion/scripts/demo
```

- [ ] **Step 9: Vet, format and lint**

Run: `gofmt -l scripts/ && go vet ./scripts/... && make lint`
Expected: no output from `gofmt -l`, and `go vet` and `make lint` exit 0. (With golangci-lint v2 defaults this code reports `0 issues.` If Task 1's `.golangci.yml` enables `gosec`, it will flag `G204` on `exec.Command("git", args...)` in `git.go` and `G306` on `0o644` writes. Both are intended in a dev-only demo tool. Add `//nolint:gosec // dev-only demo tool; args are constructed internally` on those lines rather than weakening the repo-wide config.)

- [ ] **Step 10: Smoke-run `--once` and live mode by hand**

Run:
```bash
D="$(mktemp -d)/nebula"
go run ./scripts/demo --once --dir "$D" --steps 60 | tail -3
git -C "$D" worktree list
git -C "$D" rev-list --count main
git -C "$D" ls-tree -r --name-only main | wc -l
```
Expected: the last line of output is `done: ran 60 steps (--once)`. `worktree list` shows 4 entries: `$D [main]`, two under `$D/.claude/worktrees/agent-…` and one under `$D.wt/agent-…`, each on an `agent/…` branch. The commit count is ≥ 40. The file count is between 150 and 300.

Then check live mode and Ctrl-C:
```bash
go build -o /tmp/orion-demo-bin ./scripts/demo
/tmp/orion-demo-bin --dir "$D" --speed 4 & PID=$!; sleep 8; kill -INT $PID; wait $PID; echo "exit=$?"
ls "$D/.git/index.lock" 2>/dev/null || echo "no stale lock"
```
Expected: about 30 action lines, then `stopped; the demo repo is left at …`, `exit=0` and `no stale lock`. Re-running into the same `$D` succeeds, because the marker is present. Running with `--dir ~/Documents`, or any non-empty folder the demo didn't create, prints `demo: refusing to overwrite …` and exits 1.

- [ ] **Step 11: Commit**

```bash
git add scripts/demo
git commit -m "$(cat <<'EOF'
feat(demo): add synthetic multi-worktree demo generator

Builds an invented "nebula" repo with a deterministic 40-commit history
and nested + outside agent worktrees, then simulates agents editing,
moving (mv and git mv), deleting, committing and merging so orion has
live, privacy-safe data for demos, e2e tests and screenshots.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 12: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
go test ./scripts/demo/ -count=1
git push -u origin feat/demo
gh pr create --base main --title "feat(demo): add synthetic multi-worktree demo generator" --body "$(cat <<'EOF'
## Summary
- `go run ./scripts/demo` builds a fully synthetic repo ("nebula", ~240 files, 40 commits) with agent worktrees nested under `.claude/worktrees/` and outside the root, then simulates agents and a human (create/edit/mv/git mv/delete/commit/merge + respawn) until Ctrl-C.
- `--once [--steps N]` sets up, runs N steps back to back and exits, leaving every worktree dirty and every agent branch ahead of main (used by the Playwright smoke test).
- Only deletes directories it created (marker file); ignores the user's global git config; deterministic per `--seed`.

## Test plan
- [x] `go test ./scripts/demo/` (6 tests: once layout, determinism, merge+respawn, refusal, rerun, flag validation)
- [x] `make lint`
- [x] Manual: `--once` layout check; live mode stopped with Ctrl-C exits 0 without a stale `index.lock`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 14: Playwright smoke test and screenshots

End-to-end smoke test of the **real built binary** serving the synthetic demo repo. It covers the tokenised load, the canvas actually drawing, the legend, live activity from a nested worktree, and the Night/Vision toggle with persistence. It saves screenshots of both themes, and one of them becomes the README image. It runs in CI on macOS.

**Files:**
- Modify: `web/package.json` (devDependency `@playwright/test@1.63.0`, script `e2e`)
- Modify: `web/pnpm-lock.yaml` (via pnpm)
- Modify: `.gitignore` (Playwright output)
- Create: `web/playwright.config.ts`
- Create: `web/e2e/global-setup.ts`
- Create: `web/e2e/tsconfig.json`
- Test: `web/e2e/smoke.spec.ts`
- Modify: `.github/workflows/ci.yml` (append the `e2e` job)
- Create: `docs/images/orion-demo.png` (from the Vision screenshot of the synthetic demo only)
- Modify: `README.md` (replace the screenshot placeholder written by Task 15)

**Interfaces:**
- Consumes:
  - Task 1: `make build` produces **`bin/orion`**, with the web UI embedded.
  - Task 8: `bin/orion <path> --no-open --port N` binds 127.0.0.1. If N is taken it falls back to the next free port, so the test **parses the URL** instead of assuming N. Its stdout contains a line matching `/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/`, and the first match is the URL. It exits on SIGINT. Without the token (no `?t=` and no cookie), `GET /` returns a non-2xx status.
  - Task 13: `go run ./scripts/demo --once --dir DIR --seed 1`, with the layout and end state described in Task 13's Interfaces.
  - Tasks 9–12 must satisfy these **UI requirements**. They are listed here so reviewers of those tasks can cross-check:
    1. The map host element has `data-testid="map"`, and the Pixi `<canvas>` is its descendant.
    2. The legend panel has `data-testid="legend"`. Each worktree pill inside it has `data-testid="worktree-pill"`. With the demo's `--once` state, at least 2 pills are shown, not collapsed into "+N idle", because every worktree has a non-empty overlay.
    3. The activity panel has `data-testid="activity"`. Each row renders the changed file's base name as text, for example `e2e-probe-123.md`.
    4. The live pill has `data-testid="live-pill"` and its text contains `Live`.
    5. The theme is reflected as `data-theme="vision"` or `data-theme="night"` on `<html>` (`document.documentElement`). The default with empty storage is `vision`. Pressing the `n` key (`KeyboardEvent.key` compared case-insensitively) on the page toggles it. The choice persists in `localStorage` across a reload.
    6. Night background is pure `#000`, and idle files are `#3a3a44`. In Vision, no background pixel has any RGB channel above 100 (deep indigo to near-black). File bubbles have at least some pixels with a channel above 120.
    7. `web/package.json` has `"type": "module"`, so `import.meta.url` works in the e2e files. The workflows install pnpm with `pnpm/action-setup@v6` and `version: 12`, the same as Task 1's CI. So `web/package.json` must either leave out `packageManager` or pin a `pnpm@12.x` version; the action fails when the two disagree. Vitest's `include` is limited to `src/**` so it doesn't pick up `e2e/*.spec.ts`.
- Produces: `pnpm -C web e2e`, the CI job `e2e`, `web/e2e/__screenshots__/{vision,night}.png` (gitignored), and `docs/images/orion-demo.png`.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/test-e2e-smoke -b test/e2e-smoke main
cd .claude/worktrees/test-e2e-smoke
```

- [ ] **Step 2: Add Playwright and the `e2e` script**

```bash
pnpm -C web add -D @playwright/test@1.63.0 @types/node@24
node -e 'const fs=require("fs");const f="web/package.json";const p=JSON.parse(fs.readFileSync(f,"utf8"));p.scripts={...p.scripts,e2e:"playwright test"};fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
pnpm -C web exec playwright --version
pnpm -C web exec playwright install chromium
```
Expected: `Version 1.63.0`, and Chromium is installed (or already present). `web/package.json` now has `"e2e": "playwright test"` under `scripts`, and `"@playwright/test": "1.63.0"` under `devDependencies`, pinned exactly with no caret. If pnpm wrote `^1.63.0`, edit it to `1.63.0` and run `pnpm -C web install`.

- [ ] **Step 3: Ignore Playwright output**

Append to `.gitignore`:

```gitignore

# Playwright
/web/e2e/__screenshots__/
/web/test-results/
/web/playwright-report/
```

- [ ] **Step 4: Write the Playwright config**

Create `web/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

// Smoke test against the real binary serving the synthetic demo repo.
// Prerequisite: `make build` (produces bin/orion with the web UI embedded).
// The global setup builds the demo repo, starts bin/orion and exports
// ORION_URL / ORION_DEMO_DIR for the tests.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One orion process is shared by every test, so run them one at a time.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: "list",
  outputDir: "./test-results",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    trace: "retain-on-failure",
    launchOptions: {
      // Lets Chromium fall back to SwiftShader WebGL on GPU-less CI runners.
      args: ["--enable-unsafe-swiftshader"],
    },
  },
  projects: [{ name: "chromium" }],
});
```

- [ ] **Step 5: Write the global setup (demo repo + orion process)**

Create `web/e2e/global-setup.ts`. It returns its own teardown, which Playwright ≥1.30 supports, so the orion process and the temp dir are cleaned up even when tests fail:

```ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// orion prints its tokenised URL on stdout; this is the first line that matches.
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/;

/** Asks the OS for a free TCP port on 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not determine a free port"));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}

/** Resolves with the first URL orion prints, rejecting if it exits or stays silent. */
function waitForUrl(proc: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    let found = false;
    const timer = setTimeout(() => {
      reject(new Error(`orion printed no URL within ${timeoutMs} ms. Output so far:\n${seen}`));
    }, timeoutMs);
    // Keep draining stdout after the match so orion never blocks on a full pipe.
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (found) return;
      seen += chunk.toString();
      const m = URL_PATTERN.exec(seen);
      if (m) {
        found = true;
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (!found) reject(new Error(`orion exited (code ${code}) before printing its URL:\n${seen}`));
    });
  });
}

function stop(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const kill = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    proc.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    proc.kill("SIGINT");
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const bin = path.join(repoRoot, "bin", "orion");
  if (!existsSync(bin)) {
    throw new Error(`${bin} does not exist. Run \`make build\` in ${repoRoot} first.`);
  }
  const work = mkdtempSync(path.join(tmpdir(), "orion-e2e-"));
  const demoDir = path.join(work, "nebula");
  execFileSync("go", ["run", "./scripts/demo", "--once", "--dir", demoDir, "--seed", "1"], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });

  const port = await freePort();
  const orion = spawn(bin, [demoDir, "--no-open", "--port", String(port)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let url: string;
  try {
    url = await waitForUrl(orion, 20_000);
  } catch (err) {
    await stop(orion);
    rmSync(work, { recursive: true, force: true });
    throw err;
  }
  process.env.ORION_URL = url;
  process.env.ORION_DEMO_DIR = demoDir;

  return async () => {
    await stop(orion);
    rmSync(work, { recursive: true, force: true });
  };
}
```

- [ ] **Step 6: Add a tsconfig for the e2e files**

Create `web/e2e/tsconfig.json`. Playwright transpiles TS without type-checking, so this lets us type-check the e2e code separately from the app:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["./**/*.ts", "../playwright.config.ts"]
}
```

- [ ] **Step 7: Write the smoke test**

Create `web/e2e/smoke.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "__screenshots__");

function env(name: "ORION_URL" | "ORION_DEMO_DIR"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: e2e/global-setup.ts did not run`);
  return v;
}

/** Absolute paths of the demo's linked worktrees (the main worktree excluded). */
function linkedWorktrees(): string[] {
  const out = execFileSync("git", ["-C", env("ORION_DEMO_DIR"), "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .slice(1);
}

async function openOrion(page: Page): Promise<void> {
  await page.goto(env("ORION_URL"));
  await expect(page.getByTestId("map").locator("canvas")).toBeVisible();
  // The legend fills in once the first snapshot has arrived over the WebSocket.
  await expect(page.getByTestId("legend").getByTestId("worktree-pill").first()).toBeVisible();
}

/**
 * Fraction of the map's pixels whose brightest channel is above `threshold`.
 * The chrome panels are masked black so only the canvas counts. The PNG is
 * decoded in the page (createImageBitmap) so no image library is needed.
 */
async function litFraction(page: Page, threshold: number): Promise<number> {
  const png = await page.getByTestId("map").screenshot({
    mask: [page.getByTestId("legend"), page.getByTestId("activity"), page.getByTestId("live-pill")],
    maskColor: "#000000",
    animations: "disabled",
  });
  return page.evaluate(
    async ({ b64, threshold }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(bmp, 0, 0);
      const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.max(data[i], data[i + 1], data[i + 2]) > threshold) lit++;
      }
      return lit / (data.length / 4);
    },
    { b64: png.toString("base64"), threshold },
  );
}

async function theme(page: Page): Promise<string | null> {
  return page.locator("html").getAttribute("data-theme");
}

test("loads via the tokenised URL and shows the chrome", async ({ page, request }) => {
  const bare = new URL(env("ORION_URL"));
  bare.search = "";
  const denied = await request.get(bare.toString());
  expect(denied.ok(), "a request without the token must be refused").toBe(false);

  await openOrion(page);
  await expect(page.getByTestId("legend")).toBeVisible();
  await expect(page.getByTestId("activity")).toBeVisible();
  await expect(page.getByTestId("live-pill")).toContainText("Live");
});

test("the map canvas draws the repo", async ({ page }) => {
  await openOrion(page);
  // Night: pure black background, idle files #3a3a44, so anything > 40 is drawn content.
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("night");
  await expect.poll(() => litFraction(page, 40), { timeout: 10_000 }).toBeGreaterThan(0.01);
  // Vision: the background stays at or below 100 per channel; file bubbles are brighter.
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("vision");
  await expect.poll(() => litFraction(page, 120), { timeout: 10_000 }).toBeGreaterThan(0.005);
});

test("the legend shows at least two worktrees", async ({ page }) => {
  await openOrion(page);
  const pills = page.getByTestId("legend").getByTestId("worktree-pill");
  await expect.poll(() => pills.count()).toBeGreaterThanOrEqual(2);
});

test("a new file in a nested agent worktree appears in the activity stream within 5s", async ({ page }) => {
  await openOrion(page);
  const nested = linkedWorktrees().find((p) => p.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`));
  expect(nested, "the demo creates a nested worktree").toBeDefined();
  const name = `e2e-probe-${Date.now()}.md`;
  writeFileSync(path.join(nested as string, name), "# probe\n");
  await expect(page.getByTestId("activity").getByText(name).first()).toBeVisible({ timeout: 5_000 });
});

test("N toggles Night and Vision, remembers the choice, and screenshots both", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await openOrion(page);
  expect(await theme(page)).toBe("vision");
  await page.waitForTimeout(1_500); // let the layout springs settle before the screenshot
  await page.screenshot({ path: path.join(SHOTS, "vision.png") });

  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("night");
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: path.join(SHOTS, "night.png") });

  await page.reload();
  await expect.poll(() => theme(page)).toBe("night");
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("vision");
});
```

- [ ] **Step 8: Type-check the e2e code and confirm the unit-test and lint setup ignore it**

Run:
```bash
pnpm -C web exec tsc -p e2e/tsconfig.json
pnpm -C web test
pnpm -C web lint
```
Expected: `tsc` prints nothing and exits 0. `pnpm test` (Vitest) reports only `src/**` test files; no file under `e2e/` is collected. If Vitest collects `e2e/smoke.spec.ts`, set `test: { include: ["src/**/*.{test,spec}.ts"] }` in `web/vite.config.ts` (UI requirement 7). If ESLint reports parsing or project errors for `e2e/*.ts` or `playwright.config.ts`, add `"e2e/**", "playwright.config.ts"` to the `ignores` array of the first config object in `web/eslint.config.js`, then re-run until all three commands pass.

- [ ] **Step 9: Build and run the smoke test**

Run:
```bash
make build
pnpm -C web e2e
ls -la web/e2e/__screenshots__/
```
Expected:
```
  ✓  1 [chromium] › e2e/smoke.spec.ts:… › loads via the tokenised URL and shows the chrome
  ✓  2 [chromium] › e2e/smoke.spec.ts:… › the map canvas draws the repo
  ✓  3 [chromium] › e2e/smoke.spec.ts:… › the legend shows at least two worktrees
  ✓  4 [chromium] › e2e/smoke.spec.ts:… › a new file in a nested agent worktree appears in the activity stream within 5s
  ✓  5 [chromium] › e2e/smoke.spec.ts:… › N toggles Night and Vision, remembers the choice, and screenshots both

  5 passed
```
`vision.png` and `night.png` exist, each 2880×1800. Afterwards, `pgrep -fl bin/orion` prints nothing, because teardown stopped it.

If a test fails, read `web/test-results/**/error-context.md` and the trace (`pnpm -C web exec playwright show-trace <zip>`). Fix the owning UI task's code if a UI requirement above is not met. Do not loosen the thresholds: a blank canvas measures `0` lit pixels, and this test is meant to catch that.

- [ ] **Step 10: Look at the screenshots**

Open `web/e2e/__screenshots__/vision.png` and `night.png` with the Read tool or Preview. Confirm the following:
- The map is populated and the legend shows several coloured worktree pills.
- The activity stream has rows.
- Only synthetic `nebula` names appear (`web/src/components/…`, `internal/api/…`, `agent/ui`, and so on). No path from your machine other than the temp demo dir appears.

- [ ] **Step 11: Add the `e2e` CI job**

Append this job to the end of `.github/workflows/ci.yml`. It belongs inside the top-level `jobs:` mapping, indented by two spaces like the existing `go` and `web` jobs. It uses the same action versions as those jobs. It doesn't `needs:` them; it builds everything itself with `make build`:

```yaml
  e2e:
    name: e2e (Playwright, macOS)
    runs-on: macos-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-go@v7
        with:
          go-version-file: go.mod
      - uses: pnpm/action-setup@v6
        with:
          version: 12
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: web/pnpm-lock.yaml
      - name: Install web dependencies
        run: pnpm -C web install --frozen-lockfile
      - name: Build orion (web + Go)
        run: make build
      - name: Install Chromium for Playwright
        run: pnpm -C web exec playwright install chromium
      - name: Run Playwright smoke test
        run: pnpm -C web e2e
      - name: Upload screenshots and traces
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: e2e-screenshots
          path: |
            web/e2e/__screenshots__/
            web/test-results/
          if-no-files-found: ignore
```

Validate:
```bash
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/ci.yml
```
Expected: no output, exit 0.

- [ ] **Step 12: Add the README screenshot (synthetic demo only)**

This step needs Task 15's README, so run `git fetch origin && git rebase origin/main` first. Then:
```bash
mkdir -p docs/images
cp web/e2e/__screenshots__/vision.png docs/images/orion-demo.png
sips -Z 1600 docs/images/orion-demo.png >/dev/null   # downscale for the README (macOS built-in)
grep -n 'screenshot: docs/images/orion-demo.png' README.md
sed -i '' 's|^<!-- screenshot: docs/images/orion-demo.png .*-->$|![Orion showing the synthetic "nebula" demo repo with three agent worktrees](docs/images/orion-demo.png)|' README.md
grep -n 'orion-demo.png' README.md
```
Expected: the first `grep` finds the placeholder line. The second finds exactly one line, starting `![Orion showing the synthetic "nebula" demo repo`. The PNG is 1600 px wide and under 2 MB (`sips -g pixelWidth docs/images/orion-demo.png`; `ls -la docs/images/`). On Linux, use `sed -i` without `''`, and use `convert -resize 1600x` instead of `sips`.

- [ ] **Step 13: Commit**

```bash
git add web/package.json web/pnpm-lock.yaml web/playwright.config.ts web/e2e .gitignore .github/workflows/ci.yml docs/images/orion-demo.png README.md
git status --short   # must NOT list web/e2e/__screenshots__ or web/test-results
git commit -m "$(cat <<'EOF'
test(e2e): add Playwright smoke test against the demo repo

Runs the built binary on a synthetic demo repo and checks the tokenised
load, that the canvas actually draws, the legend, live activity from a
nested worktree and the persisted Night/Vision toggle; screenshots feed
the README. Runs in CI on macOS.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 14: Push and open the PR**

```bash
git push -u origin test/e2e-smoke
gh pr create --base main --title "test(e2e): add Playwright smoke test against the demo repo" --body "$(cat <<'EOF'
## Summary
- Playwright 1.63.0 smoke test (`pnpm -C web e2e`, after `make build`): global setup builds the synthetic demo repo (`scripts/demo --once`), starts `bin/orion --no-open` on a free port and parses the tokenised URL from stdout.
- Checks: untokenised request refused; chrome visible; canvas non-blank in both themes (pixel sampling with panels masked); ≥2 legend pills; a file created in a nested agent worktree shows in the activity stream within 5 s; `N` toggles and persists the theme; screenshots of both themes.
- New `e2e` CI job on macos-latest; screenshots uploaded as an artifact.
- README screenshot generated from the synthetic demo repo only.

## Test plan
- [x] `pnpm -C web exec tsc -p e2e/tsconfig.json`
- [x] `make build && pnpm -C web e2e` (5 passed)
- [x] actionlint on ci.yml
- [x] Screenshots reviewed: synthetic names only

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 15: Release (GoReleaser, release workflow, Homebrew tap, README)

**Files:**
- Create: `.goreleaser.yaml`
- Create: `.github/workflows/release.yml`
- Modify: `README.md` (full rewrite, with a screenshot placeholder that Task 14 fills)

**Interfaces:**
- Consumes:
  - Task 1: `internal/version.Version` (a `string` var), `cmd/orion` as the main package, the `web/` pnpm project whose `pnpm -C web build` writes `internal/webassets/static/`, `LICENSE`, and `/dist/` in `.gitignore`.
  - Task 5: darwin uses cgo (`github.com/fsnotify/fsevents`), linux is pure Go.
  - Task 8: `orion --version` prints the version string.
- Produces:
  - The `v*` tag workflow and the GitHub release: archives `orion_<version>_<os>_<arch>.tar.gz` for darwin/linux × amd64/arm64 (each has `orion`, `LICENSE` and `README.md`), plus `checksums.txt`.
  - The Homebrew **cask** `orion` in `olliejudge/homebrew-tap` (`Casks/orion.rb`). `brew install olliejudge/tap/orion` works on macOS and Linux.
  - The README placeholder line `<!-- screenshot: docs/images/orion-demo.png (added by the e2e task from the synthetic demo repo) -->`, which Task 14 replaces.

**Decisions (verified on 2026-09-23 with GoReleaser v2.18.2 and Homebrew 7.0.6):**
- **`homebrew_casks`, not `brews`.** GoReleaser deprecated `brews` in v2.10, and it has been hard-deprecated since v2.16. With `brews`, `goreleaser check` fails: `DEPRECATED: brews should not be used anymore … configuration is valid, but uses deprecated properties`. GoReleaser now recommends casks for pre-built binaries, and Homebrew supports casks on Linux, so the generated cask has `on_macos` and `on_linux` blocks. The install command is unchanged: `brew install olliejudge/tap/orion`. What a cask gives up compared to the spec wording ("publishes a formula"):
  - **Casks have no `test do` block**, so `system "#{bin}/orion", "--version"` cannot live in the tap. It becomes a post-release verification step (Step 12).
  - `dependencies: - formula: git` renders as `depends_on formula: ["git"]`. Verified by loading the cask with Homebrew.
- **Quarantine.** The binary isn't notarized, and Homebrew quarantines cask downloads, so Gatekeeper would block the first run. GoReleaser's `hooks.post.install` generates `postflight do`, which Homebrew 7.0.4+ deprecated: every `brew` command then warns `Calling postflight is deprecated! Use postflight_steps instead`. We therefore emit Homebrew's declarative `postflight_steps` through `custom_block`, and escape `{{staged_path}}` from GoReleaser's templating. Verified: Homebrew 7.0.6 loads the generated cask with no warning, giving the artifacts `Binary` and `PostflightSteps`. When GoReleaser ≥ v2.19 ships `hooks.post.install_steps` (goreleaser/goreleaser#6873), switch to it.
- **One macOS runner builds everything.** Go passes `-arch x86_64` to clang itself, so `CGO_ENABLED=1 GOARCH=amd64` links a working x86_64 Mach-O on an arm64 runner with no `CC` override. This was verified with `github.com/fsnotify/fsevents` v0.2.0, and `otool -L` shows CoreServices. Linux builds are `CGO_ENABLED=0` cross-compiles.
- **macOS deployment target.** Without an explicit minimum, the cgo objects are stamped with the *runner's* macOS version: a macOS 27 runner gives `minos 27.0`, and the binary won't run on older Macs. Setting `MACOSX_DEPLOYMENT_TARGET` alone is not enough, because it isn't in Go's build-cache key and the linker warned about mismatched objects. We pass `-mmacosx-version-min=13.0` in `CGO_CFLAGS` and `CGO_LDFLAGS`, which gave `minos 13.0` for both arches and no warnings. 13.0 matches the Go 1.27 runtime object (`go.o` is built for 13.0).
- **Pinned versions:** GoReleaser `v2.18.2` through `goreleaser/goreleaser-action@v7`, `actions/checkout@v7`, `actions/setup-go@v7`, `pnpm/action-setup@v6` with `version: 12`, and `actions/setup-node@v7` with Node 24 LTS. These are the versions Task 1's `ci.yml` uses.

- [ ] **Step 1: Create the worktree**

```bash
git worktree add .claude/worktrees/ci-release -b ci/release main
cd .claude/worktrees/ci-release
```

- [ ] **Step 2: HUMAN STEP: create the tap repo and token (run by the human, or by an agent only with explicit approval)**

This needs the human's GitHub account and creates a credential, so an agent must **not** run it unprompted. Ask the human to run the following, or get their explicit go-ahead first:

```bash
# 1. The public tap repo that GoReleaser pushes Casks/orion.rb into.
gh repo create olliejudge/homebrew-tap --public \
  --description "Homebrew tap for orion" --add-readme

# 2. A fine-grained PAT (gh cannot create PATs; use the browser):
open "https://github.com/settings/personal-access-tokens/new"
#    Token name:        orion-homebrew-tap
#    Resource owner:    olliejudge
#    Expiration:        1 year (set a calendar reminder to rotate it)
#    Repository access: Only select repositories -> olliejudge/homebrew-tap
#    Permissions:       Repository permissions -> Contents: Read and write
#                       (Metadata: Read-only is added automatically)

# 3. Store it as a secret on the orion repo (paste the token when prompted):
gh secret set HOMEBREW_TAP_GITHUB_TOKEN --repo olliejudge/orion

# 4. Confirm:
gh repo view olliejudge/homebrew-tap --json visibility -q .visibility
gh secret list --repo olliejudge/orion
```
Expected: `PUBLIC`, and `HOMEBREW_TAP_GITHUB_TOKEN` is listed. The rest of this task (Steps 3–11) doesn't need the secret, so it can proceed while the human does this.

- [ ] **Step 3: Write the GoReleaser config**

Create `.goreleaser.yaml`:

```yaml
# yaml-language-server: $schema=https://goreleaser.com/static/schema.json
# Release config for orion. Runs on a macOS runner (see .github/workflows/release.yml):
# darwin builds need cgo (FSEvents); linux builds are pure Go and cross-compile.
version: 2

project_name: orion

before:
  hooks:
    - pnpm -C web install --frozen-lockfile
    - pnpm -C web build

builds:
  - id: darwin
    main: ./cmd/orion
    binary: orion
    goos: [darwin]
    goarch: [amd64, arm64]
    env:
      - CGO_ENABLED=1
      # Go passes -arch to clang itself, so darwin/amd64 cross-compiles on an
      # arm64 runner. Without an explicit minimum, the cgo objects are stamped
      # with the runner's macOS version and refuse to run on older systems.
      - CGO_CFLAGS=-O2 -g -mmacosx-version-min=13.0
      - CGO_LDFLAGS=-mmacosx-version-min=13.0
    flags: [-trimpath]
    ldflags:
      - -s -w -X github.com/olliejudge/orion/internal/version.Version={{ .Version }}
  - id: linux
    main: ./cmd/orion
    binary: orion
    goos: [linux]
    goarch: [amd64, arm64]
    env:
      - CGO_ENABLED=0
    flags: [-trimpath]
    ldflags:
      - -s -w -X github.com/olliejudge/orion/internal/version.Version={{ .Version }}

archives:
  - id: orion
    ids: [darwin, linux]
    formats: [tar.gz]
    name_template: "{{ .ProjectName }}_{{ .Version }}_{{ .Os }}_{{ .Arch }}"
    files:
      - LICENSE
      - README.md

checksum:
  name_template: checksums.txt

snapshot:
  version_template: "{{ incpatch .Version }}-next"

changelog:
  use: git
  sort: asc
  groups:
    - title: Features
      regexp: '^.*?feat(\(.+\))??!?:.+$'
      order: 0
    - title: Bug fixes
      regexp: '^.*?fix(\(.+\))??!?:.+$'
      order: 1
    - title: Performance
      regexp: '^.*?perf(\(.+\))??!?:.+$'
      order: 2
    - title: Other changes
      order: 999
  filters:
    exclude:
      - '^docs(\(.+\))?:'
      - '^test(\(.+\))?:'
      - '^chore(\(.+\))?:'
      - '^ci(\(.+\))?:'
      - '^build(\(.+\))?:'
      - '^style(\(.+\))?:'

release:
  github:
    owner: olliejudge
    name: orion
  prerelease: auto

# GoReleaser deprecated `brews` (formulae) in v2.10 in favour of casks for
# pre-built binaries. `brew install olliejudge/tap/orion` resolves the cask.
homebrew_casks:
  - name: orion
    ids: [orion]
    binaries: [orion]
    homepage: https://github.com/olliejudge/orion
    description: Live, animated map of a git repository across all its worktrees
    license: MIT
    skip_upload: auto
    repository:
      owner: olliejudge
      name: homebrew-tap
      token: "{{ .Env.HOMEBREW_TAP_GITHUB_TOKEN }}"
    commit_author:
      name: olliejudge
      email: olliejudge@users.noreply.github.com
    commit_msg_template: "chore: update orion cask to {{ .Tag }}"
    dependencies:
      - formula: git
    caveats: |
      Run `orion` inside any git repository. It serves on 127.0.0.1 only.
    # Unsigned, un-notarized binary: clear the quarantine bit so Gatekeeper
    # doesn't block the first run. Written as Homebrew's declarative
    # postflight_steps (Homebrew >= 7.0.4); GoReleaser 2.18's `hooks` emit the
    # deprecated `postflight` block. {{staged_path}} is a Homebrew token, so it
    # is escaped from GoReleaser's own templating.
    custom_block: |
      postflight_steps do
        on_macos do
          run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{ "{{staged_path}}" }}/orion"]
        end
      end
```

- [ ] **Step 4: Validate the config**

Run: `go run github.com/goreleaser/goreleaser/v2@v2.18.2 check`
Expected (the first run compiles GoReleaser, which takes about 1–2 minutes):
```
  • checking                                  path=.goreleaser.yaml
  • 1 configuration file(s) validated
  • thanks for using GoReleaser!
```
Any `DEPRECATED:` line is a failure. Fix it rather than ignoring it.

- [ ] **Step 5: Build a snapshot release locally and inspect it**

Run:
```bash
go run github.com/goreleaser/goreleaser/v2@v2.18.2 release --snapshot --clean
ls dist/*.tar.gz dist/checksums.txt
for f in dist/*/orion; do file "$f"; done
otool -l dist/darwin_darwin_amd64*/orion | grep minos
otool -l dist/darwin_darwin_arm64*/orion | grep minos
dist/darwin_darwin_arm64*/orion --version
tar tzf dist/orion_*_darwin_arm64.tar.gz
head -8 dist/homebrew/Casks/orion.rb
```
Expected:
- The log ends with `release succeeded` and shows `skipping announce, publish, and validate`. Nothing is uploaded, and `HOMEBREW_TAP_GITHUB_TOKEN` isn't needed.
- There are 4 archives, `orion_<x.y.z>-next_{darwin,linux}_{amd64,arm64}.tar.gz`, plus `checksums.txt`.
- `file` reports `Mach-O 64-bit executable x86_64`, `Mach-O 64-bit executable arm64`, and two `ELF 64-bit LSB executable … statically linked` (x86-64 and aarch64).
- Both `minos` lines are `minos 13.0`.
- `--version` output contains the snapshot version, ending in `-next`.
- The tarball lists `LICENSE`, `README.md` and `orion`.
- The cask starts with `cask "orion" do` / `postflight_steps do` / `on_macos do` / `run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{staged_path}}/orion"]`, with the literal `{{staged_path}}`.

- [ ] **Step 6: Check that Homebrew accepts the generated cask**

Skip this step if Homebrew isn't installed. It only parses the file; it installs nothing and taps nothing:
```bash
HOMEBREW_NO_AUTO_UPDATE=1 brew ruby -e 'c = Cask::CaskLoader::FromContentLoader.new(File.read(ARGV[0])).load(config: nil); puts c.token; puts c.artifacts.map { |a| a.class.name }.inspect; puts c.depends_on.inspect' dist/homebrew/Casks/orion.rb
```
Expected, with **no** `Warning: Calling … is deprecated` line:
```
orion
["Cask::Artifact::Binary", "Cask::Artifact::PostflightSteps"]
{formula: ["git"]}
```

- [ ] **Step 7: Write the release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  goreleaser:
    # macOS: the darwin builds need cgo (FSEvents). GoReleaser cross-compiles
    # darwin/amd64 (clang -arch x86_64, added by Go) and the pure-Go linux builds.
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # changelog needs full history and tags
      - uses: actions/setup-go@v7
        with:
          go-version-file: go.mod
      - uses: pnpm/action-setup@v6
        with:
          version: 12
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: web/pnpm-lock.yaml
      - name: Test
        run: go test ./...
      - uses: goreleaser/goreleaser-action@v7
        with:
          distribution: goreleaser
          version: v2.18.2
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HOMEBREW_TAP_GITHUB_TOKEN: ${{ secrets.HOMEBREW_TAP_GITHUB_TOKEN }}
```

Validate:
```bash
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/release.yml
```
Expected: no output, exit 0.

- [ ] **Step 8: Rewrite the README**

Replace `README.md` with the following. The screenshot stays a placeholder comment. Task 14 swaps in an image generated from the **synthetic** demo repo; never use a screenshot of a real repo.

````markdown
# Orion

A live, beautiful map of your git repository. Watch files appear, change, move and get committed in real time, across every worktree, as you and your coding agents work.

<!-- screenshot: docs/images/orion-demo.png (added by the e2e task from the synthetic demo repo) -->

Orion draws the repo as nested bubbles: folders are circles, files are bubbles sized by bytes. Each worktree gets a colour, and whatever it touches glows in that colour. Uncommitted work shows as a faint ghost until it is committed, stays tinted while it lives only on its branch, and shimmers back to normal once it is merged.

## Install

macOS and Linux, with `git` 2.30 or newer:

```sh
brew install olliejudge/tap/orion
```

You can also download a tarball for your platform from the [releases page](https://github.com/olliejudge/orion/releases), unpack it and put `orion` on your `PATH`.

## Usage

```sh
cd your-repo
orion
```

Orion prints a URL like `http://127.0.0.1:7070/?t=…`, opens it in your browser and keeps the map live until you press Ctrl-C.

```
orion [path] [--port N] [--no-open] [--base BRANCH] [--dev] [--version]
```

| Flag | Meaning |
|---|---|
| `path` | Any directory inside the repo, including inside a linked worktree. Default: the current directory. |
| `--port N` | Port to listen on. Default 7070; if it is taken, the next free port is used. |
| `--no-open` | Print the URL but don't open a browser. |
| `--base BRANCH` | Branch to compare against. Default: `origin`'s default branch, then `main`, then `master`, then the main worktree's current branch. |
| `--dev` | Serve no embedded UI; expect Vite's dev server at `:5173` instead. For contributors, see "Building from source" below. |
| `--version` | Print the version and exit. |

In the browser:

- Click a folder to zoom in. Press Esc or click the background to zoom out.
- Click a worktree in the legend to isolate it. Click it again to show everything.
- Hover a row in the activity stream to find that file on the map. Click the row to zoom to it.
- Press `N` to switch between the Vision and Night themes. Press `F` for full screen.

## What you're looking at

Every change is shown relative to the **base branch**, and goes through three stages:

| On the map | Meaning |
|---|---|
| Ghost bubble: faint fill in the worktree's colour, dashed outline | A new file that isn't committed yet |
| Normal bubble with a glowing halo and a dashed ring | An existing file with uncommitted edits |
| Solid bubble tinted in the worktree's colour, thin solid ring | Committed on that worktree's branch, but not yet in the base branch |
| Bubble shrunk to a faint outline | Deleted (it stays until the deletion reaches the base branch) |
| Bubble gliding to a new place | Renamed or moved |
| Ring split into coloured arcs | Touched by more than one worktree |
| A brief shimmer, then back to its file-type colour | Merged into the base branch |

The main worktree is always blue ("you"). Other worktrees get colours in the order they first become active. Unpushed commits on `main` count as "on a branch" until they are pushed, because they haven't landed yet.

The legend (top left) lists active worktrees with a count of changed files. The activity stream (right) lists the latest changes, commits and merges, newest first.

## Privacy and security

- Orion runs entirely on your machine. It makes no network requests of its own and has no telemetry.
- The server binds to `127.0.0.1` only. Each run generates a random token; the browser must present it, and requests with a foreign `Host` or `Origin` are rejected, so other websites can't read your repo through it.
- It reads git metadata and file sizes. It never reads file contents.

## Try it on a demo repo

`scripts/demo` builds a synthetic repository (an invented project called "nebula") with several agent worktrees, then simulates agents and a human editing, moving, committing and merging:

```sh
go run ./scripts/demo            # prints the repo path, then keeps simulating until Ctrl-C
orion <the path it printed>      # in another terminal
```

Options: `--dir DIR`, `--agents N` (1–8), `--seed N`, `--speed X`, and `--once` to set up, run a fixed number of steps and exit. The demo only ever deletes a directory it created itself.

## Building from source

You need Go 1.27, Node 24 or newer, pnpm and git.

```sh
make build   # builds the web UI into internal/webassets/static, then bin/orion
make test    # Go and web unit tests
make lint    # golangci-lint and the web linters
make dev     # Vite dev server with hot reload, proxied to `orion --dev`
```

`go build ./...` also works without Node: the binary then serves a page asking you to run `make web`.

## Releasing

Push a `vX.Y.Z` tag. The release workflow runs GoReleaser on macOS, publishes the GitHub release, and updates the cask in [olliejudge/homebrew-tap](https://github.com/olliejudge/homebrew-tap).

## License

[MIT](LICENSE)
````

Check the claims against the code that exists when this task runs. The flags must match `orion --help` (Task 8). The `make` targets must match `Makefile` (Task 1). The fallback-page wording must match `internal/webassets/fallback.html` (Task 1). The demo flags must match `go run ./scripts/demo -h` (Task 13). Fix the README, not the code, if a detail differs.

- [ ] **Step 9: Make sure snapshot output isn't committed**

Run: `git status --short`
Expected: only `.goreleaser.yaml`, `.github/workflows/release.yml` and `README.md`. `dist/` doesn't appear because `/dist/` is already in `.gitignore`. If it does appear, add `/dist/` to `.gitignore`.

- [ ] **Step 10: Commit**

```bash
git add .goreleaser.yaml .github/workflows/release.yml
git commit -m "$(cat <<'EOF'
ci(release): add GoReleaser config and tag-triggered release workflow

Builds darwin (cgo, FSEvents, min macOS 13) and linux (pure Go) for
amd64/arm64 on one macOS runner, publishes the GitHub release and a
Homebrew cask to olliejudge/homebrew-tap. Uses homebrew_casks because
brews is deprecated, with postflight_steps to clear quarantine.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
git add README.md
git commit -m "$(cat <<'EOF'
docs: document install, usage, visuals and privacy in README

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Push and open the PR**

```bash
git fetch origin && git rebase origin/main
git push -u origin ci/release
gh pr create --base main --title "ci(release): add GoReleaser, release workflow and Homebrew cask" --body "$(cat <<'EOF'
## Summary
- `.goreleaser.yaml` (v2): web assets built in before-hooks; darwin amd64/arm64 with cgo (min macOS 13 via CGO_CFLAGS/LDFLAGS) and linux amd64/arm64 pure Go, all from one macOS runner; tar.gz with LICENSE/README; checksums; grouped conventional-commit changelog.
- Homebrew: `homebrew_casks` (GoReleaser has deprecated `brews`; `goreleaser check` fails with it) publishing `Casks/orion.rb` to `olliejudge/homebrew-tap`, `depends_on formula: git`, quarantine cleared via Homebrew's `postflight_steps` (avoids the deprecated `postflight` warning).
- `.github/workflows/release.yml` on `v*` tags using goreleaser-action v7 pinned to GoReleaser v2.18.2.
- README: install, usage, what the visuals mean, privacy, demo, building from source.

## Test plan
- [x] `goreleaser check` (v2.18.2)
- [x] `goreleaser release --snapshot --clean`: 4 archives, correct arches, `minos 13.0`, `--version` stamped
- [x] Generated cask loads in Homebrew 7 without deprecation warnings
- [x] actionlint on release.yml
- [ ] Human: tap repo + `HOMEBREW_TAP_GITHUB_TOKEN` secret created (plan Task 15 Step 2)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 12: HUMAN STEP, after every Phase 1 task (1–15) is merged: cut v0.1.0 and verify the install (run by the human, or by an agent only with explicit approval)**

Tagging publishes a public release and pushes to the tap, so it needs explicit approval:
```bash
git switch main && git pull --ff-only
gh secret list --repo olliejudge/orion | grep HOMEBREW_TAP_GITHUB_TOKEN
git tag -a v0.1.0 -m "orion v0.1.0"
git push origin v0.1.0
sleep 15   # let GitHub register the workflow run
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
gh release view v0.1.0 --json assets -q '.assets[].name'
gh api repos/olliejudge/homebrew-tap/contents/Casks/orion.rb -q .name
brew install olliejudge/tap/orion
orion --version
xattr -p com.apple.quarantine "$(brew --prefix)/bin/orion" 2>&1 | head -1
```
Expected:
- The run succeeds, and the release has 4 `orion_0.1.0_*.tar.gz` assets plus `checksums.txt`. The tap contains `orion.rb`.
- `brew install` completes without a deprecation warning, and `orion --version` prints `0.1.0`. This is the replacement for the formula `test do` block, which casks don't have.
- The `xattr` command reports `No such xattr: com.apple.quarantine`, meaning the postflight step ran.
- Then run `cd` into any repo and `orion`. The browser opens on the live map.


---
