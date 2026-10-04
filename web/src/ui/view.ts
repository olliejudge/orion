import type { WorktreeId } from "../protocol";
import { VIEW_KINDS, type ViewKind } from "../render/view";
import type { RepoState } from "../store";

export const VIEW_KEY = "orion.view";

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Remembered view; "bubbles" when unset, invalid, or storage is unavailable. */
export function loadView(storage: Storage | null = defaultStorage()): ViewKind {
  try {
    const v = storage?.getItem(VIEW_KEY);
    return VIEW_KINDS.find((k) => k === v) ?? "bubbles";
  } catch {
    return "bubbles";
  }
}

export function saveView(v: ViewKind, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(VIEW_KEY, v);
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}

/**
 * The worktree colour the map key shows: the isolated worktree's, else the
 * first worktree with changes in the legend's order (lowest colour first),
 * else main's (0). Stable while you read it: it doesn't follow each new
 * activity row.
 */
export function keyColorIndex(state: RepoState | null, isolated: WorktreeId | null): number {
  if (!state) return 0;
  const iso = isolated === null ? undefined : state.worktrees.get(isolated)?.colorIndex;
  if (iso !== undefined && iso >= 0) return iso;
  let best = Infinity;
  for (const [id, entries] of state.overlays) {
    const c = state.worktrees.get(id)?.colorIndex ?? -1;
    if (entries.size > 0 && c >= 0) best = Math.min(best, c);
  }
  return Number.isFinite(best) ? best : 0;
}

/** The view after `v` (the V key cycles through them). */
export function nextView(v: ViewKind): ViewKind {
  return VIEW_KINDS[(VIEW_KINDS.indexOf(v) + 1) % VIEW_KINDS.length]!;
}
