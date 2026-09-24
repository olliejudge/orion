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

// Per state: directory → worktree → the stage of its touches anywhere below
// that directory ("uncommitted" wins). Covers overlay entries and base paths
// renamed away. Built once per RepoState so each aggregate is a lookup.
const dirIndexCache = new WeakMap<RepoState, Map<string, Map<WorktreeId, Stage>>>();

function dirIndex(state: RepoState): Map<string, Map<WorktreeId, Stage>> {
  const hit = dirIndexCache.get(state);
  if (hit) return hit;
  const idx = new Map<string, Map<WorktreeId, Stage>>();
  const addUnder = (path: string, id: WorktreeId, stage: Stage): void => {
    for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
      const dir = path.slice(0, slash);
      let byWorktree = idx.get(dir);
      if (!byWorktree) idx.set(dir, (byWorktree = new Map()));
      if (byWorktree.get(id) !== "uncommitted") byWorktree.set(id, stage);
    }
  };
  for (const [id, entries] of state.overlays) {
    for (const [path, e] of entries) addUnder(path, id, e.stage);
  }
  for (const [path, touches] of fromIndex(state)) {
    for (const t of touches) addUnder(path, t.worktree, t.stage);
  }
  dirIndexCache.set(state, idx);
  return idx;
}

/** Rolled-up touches for a collapsed directory: one per worktree touching anything below it. */
function encodeAggregate(state: RepoState, dir: string): NodeVisual {
  const touches: Touch[] = [];
  for (const [id, stage] of dirIndex(state).get(dir) ?? []) {
    touches.push({ worktree: id, colorIndex: colorIndexOf(state, id), stage, kind: "modified" });
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
