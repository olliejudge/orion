// Per-folder counts for the folder tooltip. Pure, and built once per RepoState
// (the store makes a new object per patch, so identity is a safe cache key).
import { nodeSizes } from "../layout/nodes";
import type { Stage, WorktreeId } from "../protocol";
import type { RepoState } from "../store";

export interface FolderStats {
  /** Files below the folder, at any depth: the map's nodes (base ∪ overlays), as a collapsed folder counts them. */
  files: number;
  /** Per worktree: how many files below the folder it changed, and at which stage ("uncommitted" wins). */
  changed: Map<WorktreeId, { count: number; stage: Stage }>;
}

const cache = new WeakMap<RepoState, Map<string, FolderStats>>();

/** Folders containing `path`, deepest first, down to (not including) the root. */
function eachFolder(path: string, fn: (dir: string) => void): void {
  for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) fn(path.slice(0, slash));
}

function build(state: RepoState): Map<string, FolderStats> {
  const out = new Map<string, FolderStats>();
  const at = (dir: string): FolderStats => {
    let s = out.get(dir);
    if (!s) out.set(dir, (s = { files: 0, changed: new Map() }));
    return s;
  };
  const { sizes } = nodeSizes(state);
  for (const path of sizes.keys()) eachFolder(path, (dir) => at(dir).files++);
  for (const [id, entries] of state.overlays) {
    for (const e of entries.values()) {
      const seen = new Set<string>();
      const add = (dir: string): void => {
        if (seen.has(dir)) return;
        seen.add(dir);
        const c = at(dir).changed;
        const prev = c.get(id);
        if (prev) {
          prev.count++;
          if (e.stage === "uncommitted") prev.stage = "uncommitted";
        } else c.set(id, { count: 1, stage: e.stage });
      };
      eachFolder(e.path, add);
      // A file moved out of a folder changed that folder too (its ring says so).
      if (e.kind === "renamed" && e.from) eachFolder(e.from, add);
    }
  }
  return out;
}

const EMPTY: FolderStats = { files: 0, changed: new Map() };

/** File and changed-file counts for the folder at `dir` (not the root). */
export function folderStats(state: RepoState, dir: string): FolderStats {
  let idx = cache.get(state);
  if (!idx) cache.set(state, (idx = build(state)));
  return idx.get(dir) ?? EMPTY;
}
