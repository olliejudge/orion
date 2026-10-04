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
 * one with the newest activity, else any worktree with changes, else main's
 * (0). So the key's swatches match what is actually on the map.
 */
export function keyColorIndex(state: RepoState | null, isolated: WorktreeId | null): number {
  if (!state) return 0;
  const ci = (id: WorktreeId | undefined): number | undefined => {
    const c = id === undefined ? undefined : state.worktrees.get(id)?.colorIndex;
    return c !== undefined && c >= 0 ? c : undefined;
  };
  const changed = [...state.overlays].find(([, entries]) => entries.size > 0)?.[0];
  return ci(isolated ?? undefined) ?? ci(state.activity.at(-1)?.worktree) ?? ci(changed) ?? 0;
}

/** The view after `v` (the V key cycles through them). */
export function nextView(v: ViewKind): ViewKind {
  return VIEW_KINDS[(VIEW_KINDS.indexOf(v) + 1) % VIEW_KINDS.length]!;
}
