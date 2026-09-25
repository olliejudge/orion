import type { ChangeEntry, Kind, Stage, WorktreeId } from "../protocol";
import type { RepoState } from "../store";
import type { Circle } from "./pack";

export interface Touch {
  worktree: WorktreeId;
  colorIndex: number;
  stage: Stage;
  kind: Kind;
  /** When the change was last touched (unix ms); absent when unknown. */
  touched?: number;
}

/**
 * What a file (or a collapsed folder's contents) is, for the map (spec §6):
 * - unchanged: no worktree touches it.
 * - added: some worktree has it as a new path, uncommitted (an add, or the
 *   new side of a rename).
 * - edited: some other uncommitted change that is not a deletion.
 * - committed: changed only in commits on a branch, not yet in base.
 * - deleted: every touch is a deletion (or the old side of a rename).
 */
export type FileState = "unchanged" | "edited" | "added" | "committed" | "deleted";

export interface NodeVisual {
  path: string;
  touches: Touch[];
  state: FileState;
  /**
   * The base file's last commit time (unix ms), or for a collapsed folder the
   * most recent one below it; absent when unknown. Touches carry their own.
   */
  touched?: number;
  renamedFrom?: string;
}

// `from` paths of renames, per state. Built lazily once per RepoState object
// (the store makes a new object per patch, so identity is a safe cache key).
const fromIndexCache = new WeakMap<RepoState, Map<string, Touch[]>>();

function touchOf(id: WorktreeId, colorIndex: number, e: ChangeEntry, kind: Kind = e.kind): Touch {
  const t: Touch = { worktree: id, colorIndex, stage: e.stage, kind };
  if (e.touched) t.touched = e.touched;
  return t;
}

function fromIndex(state: RepoState): Map<string, Touch[]> {
  let idx = fromIndexCache.get(state);
  if (idx) return idx;
  idx = new Map();
  for (const [id, entries] of state.overlays) {
    for (const e of entries.values()) {
      if (e.kind !== "renamed" || !e.from || entries.has(e.from)) continue;
      const list = idx.get(e.from) ?? [];
      list.push(touchOf(id, colorIndexOf(state, id), e, "deleted"));
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

/** Live work: an uncommitted change that leaves the file in place. */
export function isLive(t: Touch): boolean {
  return t.stage === "uncommitted" && t.kind !== "deleted";
}

/** A path that is new in its worktree, uncommitted. */
export function isNew(t: Touch): boolean {
  return t.stage === "uncommitted" && (t.kind === "added" || t.kind === "renamed");
}

function stateOf(touches: Touch[]): FileState {
  if (touches.length === 0) return "unchanged";
  if (touches.every((t) => t.kind === "deleted")) return "deleted";
  if (touches.some(isNew)) return "added";
  if (touches.some(isLive)) return "edited";
  return "committed";
}

function finish(path: string, touches: Touch[], touched: number | undefined, renamedFrom?: string): NodeVisual {
  touches.sort(byColor);
  const v: NodeVisual = { path, touches, state: stateOf(touches) };
  if (touched) v.touched = touched;
  if (renamedFrom !== undefined) v.renamedFrom = renamedFrom;
  return v;
}

/**
 * Visual encoding of one file path (spec §6 table):
 * - touches: one per worktree whose overlay has the path, sorted by colour index.
 *   A base path that some worktree renamed away gets a "deleted" touch from it.
 * - state: see FileState.
 * - touched: the base file's last commit time, when known.
 */
export function encode(state: RepoState, path: string): NodeVisual {
  const touches: Touch[] = [];
  let renamed: { e: ChangeEntry; colorIndex: number } | null = null;
  for (const [id, entries] of state.overlays) {
    const e = entries.get(path);
    if (!e) continue;
    const colorIndex = colorIndexOf(state, id);
    touches.push(touchOf(id, colorIndex, e));
    if (e.kind === "renamed" && e.from && (renamed === null || colorIndex < renamed.colorIndex)) {
      renamed = { e, colorIndex };
    }
  }
  const moved = fromIndex(state).get(path);
  if (moved) {
    for (const t of moved) if (!touches.some((x) => x.worktree === t.worktree)) touches.push({ ...t });
  }
  return finish(path, touches, state.touched.get(path), renamed?.e.from);
}

/** A worktree's changes below a folder: the stage ("uncommitted" wins) and the latest time (Infinity: some time is unknown). */
interface DirTouch {
  stage: Stage;
  touched: number;
}

// Per state: directory → worktree → its touches anywhere below that
// directory. Covers overlay entries and base paths renamed away. Built once
// per RepoState so each aggregate is a lookup.
const dirIndexCache = new WeakMap<RepoState, Map<string, Map<WorktreeId, DirTouch>>>();

function eachAncestor(path: string, fn: (dir: string) => void): void {
  for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) fn(path.slice(0, slash));
}

function dirIndex(state: RepoState): Map<string, Map<WorktreeId, DirTouch>> {
  const hit = dirIndexCache.get(state);
  if (hit) return hit;
  const idx = new Map<string, Map<WorktreeId, DirTouch>>();
  const addUnder = (path: string, id: WorktreeId, stage: Stage, touched: number | undefined): void => {
    const time = touched || Infinity;
    eachAncestor(path, (dir) => {
      let byWorktree = idx.get(dir);
      if (!byWorktree) idx.set(dir, (byWorktree = new Map()));
      const was = byWorktree.get(id);
      if (!was) byWorktree.set(id, { stage, touched: time });
      else byWorktree.set(id, { stage: was.stage === "uncommitted" ? was.stage : stage, touched: Math.max(was.touched, time) });
    });
  };
  for (const [id, entries] of state.overlays) {
    for (const [path, e] of entries) addUnder(path, id, e.stage, e.touched);
  }
  for (const [path, touches] of fromIndex(state)) {
    for (const t of touches) addUnder(path, t.worktree, t.stage, t.touched);
  }
  dirIndexCache.set(state, idx);
  return idx;
}

// Directory → the latest base commit time below it. Keyed by the base time
// map itself, which only changes when base does, so edits never rebuild it.
const baseDirCache = new WeakMap<Map<string, number>, Map<string, number>>();

function baseDirTimes(state: RepoState): Map<string, number> {
  const hit = baseDirCache.get(state.touched);
  if (hit) return hit;
  const idx = new Map<string, number>();
  for (const [path, t] of state.touched) {
    eachAncestor(path, (dir) => {
      if ((idx.get(dir) ?? 0) < t) idx.set(dir, t);
    });
  }
  baseDirCache.set(state.touched, idx);
  return idx;
}

/** Rolled-up touches for a collapsed directory: one per worktree touching anything below it, with its latest time. */
function encodeAggregate(state: RepoState, dir: string): NodeVisual {
  const touches: Touch[] = [];
  for (const [id, { stage, touched }] of dirIndex(state).get(dir) ?? []) {
    const t: Touch = { worktree: id, colorIndex: colorIndexOf(state, id), stage, kind: "modified" };
    if (Number.isFinite(touched)) t.touched = touched;
    touches.push(t);
  }
  return finish(dir, touches, baseDirTimes(state).get(dir));
}

/** Visuals for every circle in a layout: files encoded, aggregates rolled up, plain dirs empty. */
export function encodeAll(state: RepoState, layout: Map<string, Circle>): Map<string, NodeVisual> {
  const out = new Map<string, NodeVisual>();
  for (const c of layout.values()) {
    if (!c.isDir) out.set(c.path, encode(state, c.path));
    else if (c.aggregate !== undefined) out.set(c.path, encodeAggregate(state, c.path));
    else out.set(c.path, finish(c.path, [], undefined));
  }
  return out;
}

/** A plain visual with nothing on it (placeholders and tests). */
export function blankVisual(path: string): NodeVisual {
  return { path, touches: [], state: "unchanged" };
}
