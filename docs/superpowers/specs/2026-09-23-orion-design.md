# Orion — Design Spec

Date: 2026-09-23
Status: Implemented (Phase 1)

## As shipped (Phase 1)

Phase 1 shipped as specified below, except for these deviations:

- **`--dev` flag (§7).** `orion` also takes `--dev`, which serves no embedded assets so that `make dev` can put Vite's dev server in front of it.
- **Embed folder (§10).** `internal/webassets/static/` holds only `.gitkeep`; instead of a committed placeholder `index.html`, the binary embeds a fallback page that is served when no web build is present, so `go build` and `go test` still work without Node.
- **Release build (§10).** The web assets are built in a release workflow step, and GoReleaser runs with `--skip=before` rather than building them in a before-hook.
- **Homebrew (§10).** GoReleaser publishes a Homebrew **cask** rather than a formula, since its `brews` section is deprecated. The install command is unchanged.
- **Auth cookie (§7).** The cookie is named per port, `orion_t_<port>`, so orion instances on different ports do not overwrite each other's cookies.
- **Worktree colours (§6).** A removed worktree frees its colour index, and a new worktree can reuse it.
- **Real-repo polish (Task 16, after the plan's tasks).** A pass against real repos added, among other tweaks, a muted file-type palette for the Vision theme.

## 1. Intent

Orion is a live, beautiful map of a git repository. It is inspired by Git Truck's bubble chart, but it is **real-time**: files appearing, changing, moving and being deleted animate as they happen — across **every worktree** of the repo — with uncommitted work rendered as a fainter "ghost" until it is committed.

Who it is for: a developer (initially the author) who runs several coding agents in parallel worktrees alongside their own work.

What success looks like:

- **Ambient dashboard.** Left open on a second screen, it shows at a glance where each agent and the human are working right now, and how far along each branch's work is.
- **Explore.** It is pleasant for exploring a repo's structure and (in Phase 2) its history.
- **Beautiful, Apple-like.** Calm, polished and smooth at 60 fps.
- **Trivial to run.** `brew install olliejudge/tap/orion`, then `orion` inside any repo.

### Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Worktree presentation | **One unified tree** of the repo; each worktree has a colour, and files it touches glow in that colour. Plus a **live activity stream** panel. (Mockups A + C.) |
| Visual style | **Vision** (dark glass: deep, softly lit background; frosted floating panels; gradient-shaded bubbles; glowing halos) by default, with **Night** (pure black minimal HUD; only activity is coloured) as a toggleable ambient mode. |
| "Committed" semantics | **Three-stage lifecycle relative to the base branch**: uncommitted (ghost) → committed on its branch (tinted in the worktree's colour) → merged into base (normal colour, brief shimmer). |
| History features | Time-travel scrubber, colour modes, commit list + details, stats panel. All four are wanted; they are scheduled for **Phase 2**. |
| Launch model | **One repo per run.** `orion [path]` serves on localhost, opens the browser and exits on Ctrl-C. |
| Stack | **Go** binary with an embedded TypeScript frontend; GoReleaser → Homebrew tap. |

### Non-goals (v1)

- Windows support. macOS comes first and Linux is supported; Windows can come later.
- A multi-repo daemon, remote repos, or editing files from the UI.
- Git hosting integrations (PRs, issues).

## 2. Concepts

- **Repo.** The git repository containing `path` (default: cwd). Its root is the main worktree's top level.
- **Base branch.** The branch everything is compared against. Default: the remote default branch (`refs/remotes/origin/HEAD`); if that is absent, local `main`; if that is absent, `master`; failing all of these, the main worktree's current branch. Override with `--base <branch>`. With the default remote base, unpushed local commits on `main` show as "committed on branch" in the main worktree's colour, and become "merged" once pushed. This is intended: it shows work that hasn't landed yet.
- **Base tree.** The file list (path and blob size) of the base branch's tip commit. It is the "committed and merged" skeleton of the map.
- **Worktree.** Each entry in `git worktree list --porcelain`. It has an id (stable hash of its absolute path), path, branch (or detached short SHA), HEAD SHA, lock state and colour.
- **Overlay.** For each worktree, a map from path to a **change entry**:

  ```
  ChangeEntry {
    path:   string          // repo-relative path, slash-separated
    kind:   "added" | "modified" | "deleted" | "renamed"
    from?:  string          // previous path, when kind == "renamed"
    stage:  "uncommitted" | "committed"   // committed = on this worktree's branch, not yet in base
    size:   number          // bytes (working-tree stat for uncommitted, blob size for committed); 0 for deleted
  }
  ```

  How an overlay is computed for worktree `W`:
  1. **Committed on branch:** `git diff --name-status -M -z <merge-base(base, W.HEAD)> W.HEAD`. Every entry gets `stage: committed`. It is empty when `W.HEAD` is already in base.
  2. **Uncommitted:** `git -C W status --porcelain=v2 -z --untracked-files=all` (staged and unstaged changes, renames and untracked files). Every entry gets `stage: uncommitted` and **overrides** any committed entry for the same path.
  3. Sizes come from `git ls-tree -r -l` (committed) and `os.Stat` (uncommitted).

- **Lifecycle.** A file edited in worktree `W` moves from **uncommitted** → **committed** (when `W` commits) → **gone from the overlay** (when base advances to include it; for example after a merge). When it leaves the overlay, the base tree gains or updates that file, and the client plays the "merged" shimmer.

## 3. Architecture

A single Go module, `github.com/olliejudge/orion`, with the built frontend embedded via `go:embed`.

```
cmd/orion/            CLI entrypoint (flags, repo discovery, open browser, signal handling)
internal/gitx/        Thin, tested wrapper over the git CLI (exec + parsers). No state.
internal/watch/       Recursive filesystem watcher: FSEvents on darwin, recursive inotify on linux.
                      Emits raw path events; knows nothing about git.
internal/repo/        Glue: worktree discovery, event routing, debounce/rate-limit, recompute scheduling.
internal/model/       Pure state + diffing: base tree, overlays, activity; produces Patch values.
internal/history/     (Phase 2) Commit index from `git log`, served lazily.
internal/server/      HTTP + WebSocket, token/Origin checks, embedded static assets.
web/                  Vite + TypeScript + Svelte 5 + PixiJS v8 + d3-hierarchy frontend.
scripts/demo/         Generates a synthetic repo with fake agent worktrees making changes.
```

Every unit has one job and a narrow interface:

- `gitx` knows how to ask git things and parse the answers. It is tested against fixture repos, and its functions are pure apart from `exec`.
- `watch` turns the OS's file-watching API into a `chan Event{Path string, Flags}`, and reports overflow as `Event{Rescan: true}`.
- `model` has no I/O. It takes a new snapshot of (base tree, worktrees, overlays) and returns a `Patch` against the previous state. This is where most of the logic lives, and it is fully unit-testable.
- `repo` is the only place that connects watch → gitx → model.
- `server` fans patches out to clients and serves a snapshot to each new connection.

Go dependencies (versions pinned in the implementation plan): `github.com/fsnotify/fsevents` (darwin), `github.com/fsnotify/fsnotify` (linux, with recursive add), `github.com/coder/websocket`, and a small browser-open helper. No git library: we shell out to the user's `git` (minimum version 2.30), because its output handles worktrees, renames and edge cases most reliably.

## 4. Data flow

1. **Startup:** resolve the repo, the base branch and the worktrees. Build the base tree and every overlay, then start the watchers and the HTTP server. Print the URL (containing the token) and open the browser unless `--no-open` is passed.
2. **Watching:** watch the main worktree's root recursively (this includes `.git/`), plus the root of every linked worktree that lives outside the main root.
3. **Routing** each event path:
   - Paths under `.git/worktrees/<name>/` (for `HEAD`, `index` and similar files) → a **ref event** for that linked worktree.
   - `.git/HEAD`, `.git/index` → a ref event for the main worktree.
   - `.git/refs/**`, `.git/packed-refs` → a **refs event** (it may affect base and any branch).
   - `.git/worktrees/` directory entries appearing or disappearing → **rediscover worktrees**.
   - Other paths under `.git/` → ignored.
   - Everything else → a **file event**, routed to the worktree whose root is the **longest prefix** of the path. This matters because linked worktrees can be nested inside the main worktree (e.g. `.claude/worktrees/agent-*`). Events inside a nested worktree must never count against the main worktree.
4. **Debounce:** coalesce events per worktree over 150 ms and cap recomputes at 4 per second per worktree. Under sustained churn, run a trailing recompute after the burst ends.
5. **Recompute:**
   - A file event → re-run the worktree's uncommitted status.
   - A ref event → also recompute that worktree's committed-on-branch diff.
   - A refs event → re-resolve the base tip. If base moved, rebuild the base tree and recompute every worktree's committed diff; otherwise recompute committed diffs only for worktrees whose HEAD changed.
6. **Diff and broadcast:** `model` diffs the new state against the old and emits a `Patch` with a monotonically increasing `seq`, plus zero or more `Activity` items.
7. **Client:** applies the patch, re-runs the layout, and animates towards the new layout with springs.

Files ignored by git never appear, because `git status` already excludes them. Heavy churn in ignored folders such as `node_modules` costs only debounced `git status` calls.

## 5. Wire protocol

All WebSocket messages are JSON: `{ "type": ..., ... }`.

Server → client:

```ts
type Snapshot = {
  type: "snapshot"; seq: number;
  repo: { name: string; base: string; baseSha: string };
  worktrees: Worktree[];
  tree: { path: string; size: number }[];           // base tree
  overlays: Record<WorktreeId, ChangeEntry[]>;
  activity: Activity[];                             // most recent ≤ 200
};
type Worktree = { id: string; path: string; label: string; branch?: string; head: string;
                  isMain: boolean; locked: boolean; colorIndex: number };
type Patch = {
  type: "patch"; seq: number;
  worktrees?: Worktree[];                            // full list, present only when it changed
  base?: { sha: string; upsert: { path: string; size: number }[]; remove: string[] };
  overlays?: Record<WorktreeId, { upsert: ChangeEntry[]; remove: string[] }>;
  activity?: Activity[];
};
type Activity = { ts: number; worktree: WorktreeId;
                  kind: "added" | "modified" | "deleted" | "renamed" | "commit" | "merge";
                  path?: string; from?: string; sha?: string; subject?: string; files?: number };
```

Client → server: `{ "type": "resync" }`. The client sends this if it sees a gap in `seq`; the server replies with a fresh snapshot. Every new connection receives a snapshot first.

Activity is derived by `model` when diffing:

- A new or changed uncommitted entry → added / modified / deleted / renamed.
- Uncommitted entries turning committed, together with a new HEAD → a `commit` item with the subject and file count.
- Overlay entries disappearing because base advanced → `merge`.
- Repeated modifications of the same path in the same worktree within 5 s are coalesced into one item.

## 6. Frontend

### Stack

Vite, TypeScript, **Svelte 5** for panels and chrome, **PixiJS v8** (WebGL) for the map, and **d3-hierarchy** `pack()` for layout. Package manager: pnpm.

### Map (the main visual)

- A full-bleed canvas. The root circle is the repo; folders are nested circles with their names set along the top arc, as in Git Truck, when the radius is large enough. Files are filled bubbles sized by bytes (square-root scaled by `pack`).
- **Stable layout:** children are sorted by name, not size, so the layout doesn't reshuffle when sizes change. Every node's position and radius is animated with a critically damped spring (about 300 ms) whenever the layout changes.
- **Node set** = base tree ∪ all overlay paths. The same path touched by several worktrees is still one node.
- **File colour** (Phase 1): a curated palette keyed by extension group, drawn as a gradient-shaded sphere in Vision and flat graphite in Night.
- **Worktree encoding:**

  | Situation | Rendering |
  |---|---|
  | Uncommitted modified | Normal fill, a glowing halo in the worktree colour, and a dashed ring |
  | Uncommitted added | A ghost bubble: about 15% fill in the worktree colour and a dashed outline |
  | Committed on branch | Solid, tinted in the worktree colour, with a thin solid ring |
  | Deleted (either stage) | Shrinks to a faint outline and stays until the deletion reaches base |
  | Renamed or moved | The bubble glides from its old position to its new one along a gentle arc |
  | Touched by 2+ worktrees | A **split ring** with one arc segment per worktree colour |
  | Merged into base (leaves the overlay) | Returns to the file-type colour with a one-off shimmer (about 600 ms) |

- **Worktree colours:** a 10-colour palette built from Apple system colours (blue, orange, green, pink, purple, teal, yellow, indigo, red, mint). The main worktree is always blue ("you"). Other worktrees get colours in order of first activity during the session. Colours are reused only when more than 10 worktrees are active at once, and hover always shows the worktree's label.
- **Scale:** nodes whose on-screen radius is under 1.5 px are culled; folders whose radius is under about 6 px are drawn as a single aggregate bubble. Targets: 60 fps at 2k files and smooth interaction at 20k files.

### Chrome (floating frosted-glass panels in Vision; fade-on-hover in Night)

- **Top-left, repo + worktrees legend:** the repo name, then a pill per *active* worktree (one with a non-empty overlay or recent activity), showing its colour dot, label and a count of changed files. Idle worktrees collapse into "+N idle", which expands on click. Clicking a worktree pill **isolates** it: other worktrees' encodings dim. Clicking again clears the isolation.
- **Right, activity stream:** newest first. Each row shows the worktree dot, the file name (with the parent folder dimmed), the kind and a relative time. Commit and merge rows are emphasised. Hovering a row highlights the node on the map, and clicking zooms to it. In Night mode, rows fade with age.
- **Bottom-centre, time pill:** in Phase 1 a "● Live" indicator. In Phase 2 it expands into the scrubber.
- **Bottom-left, map key:** a small swatch per mark (unchanged file, edited and new uncommitted, committed on branch, deleted, merged), drawn from the renderer's own encoding in the current theme, plus a note that circles are folders and colours are worktrees. It collapses to a "Key" button, and the choice is remembered in `localStorage`; it starts open, except on narrow screens. The map keeps clear of it like it does of the legend.
- **Tooltip on hover:** the full path, size, and which worktrees are touching the file and at what stage.

### Interactions

- Click a folder to zoom into it (animated). Esc or clicking the background zooms out.
- Keyboard: `N` toggles Night/Vision, `F` toggles fullscreen, `/` searches (Phase 2).
- The theme choice is remembered in `localStorage`, with safe fallbacks if storage is unavailable.

### Visual language

- **Vision:** a radial deep-indigo-to-near-black background, panels at `rgba(40,40,52,.45)` with `backdrop-filter: blur(18px) saturate(1.6)` and a 1px `rgba(255,255,255,.10)` border, SF Pro via the system font stack, and soft glows.
- **Night:** a `#000` background, idle files in `#3a3a44`, and only worktree activity in colour.

## 7. Server & CLI

- `orion [path] [--port N] [--no-open] [--base BRANCH] [--version]`.
- Binds `127.0.0.1` only. The default port is 7070; if it is taken, the next free port is used.
- A random 32-byte token is generated on first run and kept (mode 0600) in `<user config dir>/orion/token`, so the URL is stable across runs; if that file is unavailable, a one-off token is used for the run. The first request must carry `?t=<token>`; the server then sets an HttpOnly cookie, and every HTTP and WebSocket request must present the cookie or query token. The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, and the WebSocket `Origin` must match. These checks prevent other sites or DNS-rebinding attacks from reading repo data.
- Ctrl-C shuts down gracefully: watchers stop, clients get a close frame, and the process exits with code 0.

## 8. Error handling

| Case | Behaviour |
|---|---|
| Not inside a git repo, or git missing / older than 2.30 | Print a one-line error and exit with code 1. |
| Repo with no commits yet | Base tree is empty; show the uncommitted overlays only. |
| Base branch cannot be resolved | Warn and fall back to the main worktree's HEAD. |
| Watcher overflow (FSEvents `MustScanSubDirs`, inotify `IN_Q_OVERFLOW`) | Full recompute of every worktree. |
| Watcher can't watch a directory (permissions, inotify limit) | Log once. Fall back to polling that worktree's status every 2 s. |
| Worktree removed while running | Rediscover the worktrees. Its overlay is removed and a patch sent. |
| A git command fails | Log with context, keep the last good state, and retry on the next event. |
| WebSocket drop | The client reconnects with backoff (showing a subtle "Reconnecting…" pill) and receives a fresh snapshot. |
| Submodules | Rendered as a single leaf bubble; not recursed into. |
| Binary or huge files | Just sized by bytes; contents are never read. |

## 9. Testing

- **Go unit tests.** `gitx` parsers are tested against captured porcelain output and against **synthetic repos** built in `t.TempDir()` by a shared `testrepo` helper (init, commit, branch, worktree add, rename, delete, merge). `model` diff logic is tested table-style: state A + state B → expected Patch and Activity.
- **Go integration test.** Start orion in-process on a synthetic repo with two linked worktrees (one nested inside the main root). Connect a WebSocket client, mutate files and commit, and assert the expected patches arrive: uncommitted → committed → merged, with renames and nested-worktree routing.
- **Watcher tests.** Run on both macOS and Linux in CI.
- **Frontend.** Vitest for the patch-applier and state store, the layout-stability and node-set logic, the lifecycle-to-visual-encoding mapping, and colour assignment. Playwright smoke test: load against the demo server, check the canvas renders and panels appear, and take screenshots.
- **Privacy.** Tests, fixtures, docs and screenshots use only synthetic repos. No content from private repos is ever committed.
- **CI** (GitHub Actions; a required check on `main`): `go vet` + `golangci-lint` + `go test ./...` on macOS and Linux; `pnpm lint` + `pnpm test` + `pnpm build` for `web/`.

## 10. Build & release

- `make build`: builds `web/` with pnpm into the embed folder, then runs `go build`. `make dev` runs Vite's dev server, proxying to a Go server started with `--dev`, which serves no embedded assets.
- A minimal placeholder `index.html` is committed in the embed folder so that `go build` and `go test` work without Node.
- **GoReleaser** runs on `v*` tags: a before-hook builds the web assets; it then builds darwin/linux × amd64/arm64 with `-trimpath` and version ldflags, creates the GitHub release, and publishes a formula to the **`olliejudge/homebrew-tap`** repo using a `HOMEBREW_TAP_GITHUB_TOKEN` secret, a fine-grained PAT the user will create.
- Install path: `brew install olliejudge/tap/orion`.

## 11. Phasing

**Phase 1 — Live map (MVP)**
- The CLI, server, security, watcher, routing and model.
- The live unified map with the full three-stage lifecycle, renames, deletes and split rings.
- The worktree legend with isolate, the activity stream and tooltips.
- Zoom, Vision and Night themes.
- The demo script, CI, and a GoReleaser + Homebrew tap release `v0.1.0`.

**Phase 2 — History**
- `internal/history`: a commit index from `git log --numstat -M`, built in the background after startup.
- A **time-travel scrubber**: drag or press play to replay base-branch history commit by commit using the same animations; a "Live" button snaps back.
- **Colour modes:** file type, author, last changed (heat) and churn.
- A **commit list + details** panel: selecting a commit highlights the files it touched; selecting a file shows its commits.
- A **stats panel:** contributors, commit-activity chart, top churner, repo size.
- `/` search.

Phase 2 gets its own implementation plan after Phase 1 ships.
