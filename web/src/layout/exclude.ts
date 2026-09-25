// Directories the viewer has chosen to hide from the map, and their
// persistence. Pure and DOM-free except for the injectable Storage, so it is
// unit-tested without rendering (theme.ts follows the same shape).
import type { TreeNode } from "./nodes";

/** true when `path` is `dir`, or sits under it (never a false match of "src" against "srcfoo"). */
export function isExcluded(path: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.size === 0) return false;
  for (const dir of excluded) {
    if (path === dir || path.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/** True when a *proper* ancestor of `path` (not `path` itself) is excluded. */
export function ancestorExcluded(path: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.size === 0) return false;
  for (let dir = parentOf(path); dir !== ""; dir = parentOf(dir)) {
    if (excluded.has(dir)) return true;
  }
  return false;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** `path`, or its nearest ancestor (up to the root "") that is not itself excluded. */
export function nearestVisibleAncestor(path: string, excluded: ReadonlySet<string>): string {
  let p = path;
  while (p !== "" && isExcluded(p, excluded)) p = parentOf(p);
  return p;
}

/**
 * `path` toggled in or out of `set`, as a fresh Set (`set` itself is never
 * mutated). A plain function in a `.ts` module rather than inline in a
 * component, so it builds an ordinary `Set` (the type the filter panel's
 * `onChange` and the storage helpers above all expect), not a component's
 * reactive one.
 */
export function toggled(set: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(set);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/**
 * The full directory tree (base ∪ overlays, unfiltered by any exclusion) as
 * a viewer would browse it: every directory, nested, sorted by name. Built
 * from `buildTree`'s own output so it can never disagree with what the map
 * would show if nothing were excluded.
 */
export interface DirEntry {
  path: string;
  name: string;
  children: DirEntry[];
}

export function directoryEntries(root: TreeNode): DirEntry[] {
  return (root.children ?? [])
    .filter((c) => c.isDir)
    .map((c) => ({ path: c.path, name: c.name, children: directoryEntries(c) }));
}

const STORAGE_PREFIX = "orion.exclude.";

/** Where a repo's exclusions are stored: keyed by name, since Snapshot carries no stabler identity here. */
export function excludeStorageKey(repoName: string): string {
  return `${STORAGE_PREFIX}${repoName}`;
}

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Remembered exclusions for `repoName`; empty when unset, invalid, or storage is unavailable. */
export function loadExcluded(repoName: string, storage: Storage | null = defaultStorage()): Set<string> {
  try {
    const raw = storage?.getItem(excludeStorageKey(repoName));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    // Unknown/stale entries (a directory that no longer exists) are kept
    // harmlessly: they just never match a live path.
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function saveExcluded(repoName: string, excluded: ReadonlySet<string>, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(excludeStorageKey(repoName), JSON.stringify([...excluded]));
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}

/** Whether the directory filter panel is expanded: like encodingKey.ts's KEY_OPEN_KEY, but its own key. */
export const DIRFILTER_OPEN_KEY = "orion.dirfilter";

export function loadDirFilterOpen(storage: Storage | null = defaultStorage(), fallback = false): boolean {
  try {
    const v = storage?.getItem(DIRFILTER_OPEN_KEY);
    return v === "open" ? true : v === "closed" ? false : fallback;
  } catch {
    return fallback;
  }
}

export function saveDirFilterOpen(open: boolean, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(DIRFILTER_OPEN_KEY, open ? "open" : "closed");
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}
