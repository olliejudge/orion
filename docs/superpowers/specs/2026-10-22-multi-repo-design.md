# Orion: Multi-repo view (design spec)

Date: 2026-10-22
Status: Approved (design); implementing

## 1. Intent

Some projects are split across several sibling repos, for example an API, a
web app and a game client that are each cloned on their own. Agents work in
all of them at once. Orion should show the whole project in **one live map**,
so that activity in every repo and every worktree is visible together.

Decisions made while brainstorming:

- **One combined map.** Each repo is a top-level cluster in the same map. A
  repo switcher and split tiles were rejected, because neither lets you watch
  everything running at once.
- **Repos are listed as paths.** `orion ~/acme-api ~/acme-web ~/acme-game`. No
  scanning of a parent folder, because that would pick up unrelated repos and
  duplicate clones.
- **A single path is unchanged.** `orion` and `orion PATH` behave and look
  exactly as they do today, with the same wire protocol.

Non-goals: submodules, scanning a parent directory, adding or removing repos
at runtime, and a per-repo `--base`.

## 2. CLI

```
orion [path...] [--name NAME] [--base BRANCH] ...
```

- Each path resolves to its repo's main worktree, as it does today. Paths
  that resolve to the same repo (for example a linked worktree of a repo
  that is already listed) are deduplicated with a warning. Two *clones* of the
  same remote are different repos, and both are shown.
- **Repo key.** Each repo's key, which is its folder in the map, is the base
  name of its main worktree. When two repos share a base name, the parent
  directory is prepended (`work/api`, `old/api`) until the keys are unique.
- `--name` names the project. This is what the key heading and the window
  title show, and what excluded folders are saved under. It defaults to the
  longest common prefix of the repo keys, with trailing `-`, `_` and `.`
  removed (`acme-api` and `acme-web` give `acme`). If there is no common
  prefix, the keys are joined with ` + `.
- `--base` applies to every repo. A repo without that branch falls back to its
  default branch, with the existing warning.
- Startup fails if any listed path is not a git repo, which is the same
  behaviour as for a single path.

## 3. Architecture

`repo.Engine` stays a one-repo engine: it keeps its own watcher, scheduler,
Store, activity derivation and colours. A new `repo.Workspace` implements
`server.Source` over N engines:

- **Snapshot** merges the engines' snapshots. Tree and overlay paths are
  prefixed with `<key>/`, worktrees are concatenated in repo order, and the
  activity rows are merged by time (newest 200). Each worktree gets
  `repo: <key>`.
- **Subscribe.** The Workspace subscribes once to each engine. It translates
  every engine patch (prefixing paths, and replacing `worktrees` with the full
  merged list whenever any repo's list changes), restamps it with its own
  monotonic `seq`, and fans it out to its own subscribers. Each engine patch
  stays one workspace patch, so a base move and the overlay removals it
  causes still arrive together, and the UI's merge detection keeps working.
- **Overflow.** If an engine drops the Workspace's channel, the Workspace
  re-subscribes to that engine and closes every client subscription. Clients
  already handle that case by resyncing from a fresh snapshot.
- **Colours.** Each engine gives its main worktree colour 0 and assigns 1–9
  to the others. The Workspace remaps non-main colours through one global
  assigner, so that worktrees in different repos don't share a colour. Every
  main worktree keeps colour 0, the neutral "main" colour.
- **Run.** `Workspace.Run` runs every engine's `Run` and returns when the
  context ends or the first engine fails.

With one repo, `main.go` serves the Engine directly, with no Workspace, so the
wire stays byte-for-byte what it is today.

## 4. Wire protocol (additive)

- `Worktree.repo?: string` is the repo key. It is absent with a single repo.
- `Snapshot.repos?: RepoInfo[]` lists one entry per repo, in order, each with
  `key` (the path prefix), `name`, `base` and `baseSha`. With several repos,
  `Snapshot.repo` is `{name: <project name>, base: "", baseSha: ""}`.
- `Patch.repos?: RepoInfo[]` is the full list. It is sent whenever any repo's
  base changes, and in that case `base.sha` is the empty string.

Older UIs that ignore these fields still render the combined map correctly,
because the repos are simply top-level folders.

## 5. Frontend

- The map needs no change: the prefixed paths make each repo a top-level
  folder in all four views (Bubbles, Stars, Tree map, Partition). Zoom,
  crumbs, the folder filter and dimming all work per repo for free.
- **Key.** The worktree legend is grouped under one sub-heading per repo,
  with each repo's main first. The "Compared with" line lists each repo's
  base when the bases differ, and a single base otherwise.
- **Activity.** "Merged into X" uses the base of the worktree's own repo.
  Rows show `repo ▸ label` when there are several repos.
- **Reconnect identity.** `repoIdentity` uses the sorted list of `repos` keys
  together with the main paths, when `repos` is present.

## 6. Testing

- Go: Workspace unit tests over two synthetic repos built by `testrepo`. They
  cover path prefixing, worktree merge, colour remapping, seq monotonicity,
  activity merging, overflow resync, dedupe and key disambiguation.
- CLI tests for several positionals, `--name` and the default name.
- Web: store tests for `repos` patches, legend grouping, and identity.
- e2e: the existing single-repo smoke test stays as it is. A second smoke
  test serves two synthetic repos and checks that both top-level folders and
  the grouped key render.

## 7. Deployment note

The systemd unit on the agent box lists one path. Showing several repos there
means changing its `ExecStart` to list them, which is a change in the box's
own config and not in this repo.
