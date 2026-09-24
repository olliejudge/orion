// Navigation model for the map: breadcrumbs and where clicks and keys zoom to.
// A "level" is a folder the map names on its own: compressed chains (a folder
// whose only child is a folder, see labelNames) count as one level, so every
// click, breadcrumb and step out moves by exactly one visible name.
import type { Circle } from "../layout/pack";
import { parentDir } from "../render/geometry";

export interface Crumb {
  path: string; // "" = the repo root
  label: string;
}

/** Labelled folders (labelNames) and collapsed folders are levels; without labels, every folder is. */
function isLevel(path: string, layout: Map<string, Circle>, labels: Map<string, string> | undefined): boolean {
  const c = layout.get(path);
  if (!c?.isDir) return false;
  return labels === undefined || labels.has(path) || c.aggregate !== undefined;
}

/** Proper prefixes of `path` (not "" or itself), shallowest first. */
function prefixes(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) out.push(path.slice(0, i));
  return out;
}

function isWithin(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

/** Breadcrumb segments from the repo root down to `target`, one per level; the target is always last. */
export function crumbs(target: string, layout: Map<string, Circle>, labels: Map<string, string> | undefined, repoName: string): Crumb[] {
  const out: Crumb[] = [{ path: "", label: repoName }];
  if (target === "" || !layout.has(target)) return out;
  for (const p of [...prefixes(target), target]) {
    if (p !== target && !isLevel(p, layout, labels)) continue;
    const prev = out[out.length - 1]!.path;
    out.push({ path: p, label: prev === "" ? p : p.slice(prev.length + 1) });
  }
  return out;
}

/** One level out from `target` (the previous breadcrumb); the root stays put. */
export function upOne(target: string, layout: Map<string, Circle>, labels: Map<string, string> | undefined): string {
  const cs = crumbs(target, layout, labels, "");
  return cs.length > 1 ? cs[cs.length - 2]!.path : "";
}

/**
 * Where a single click zooms: one level from the folder in view toward what
 * was clicked (a folder, or a file's folder), through their common ancestor
 * when it is outside the view. Clicking the folder in view steps out one
 * level; clicking outside the repo returns to the root.
 */
export function clickTarget(path: string | null, layout: Map<string, Circle>, labels: Map<string, string> | undefined, current: string): string {
  if (path === null) return "";
  const c = layout.get(path);
  if (!c) return "";
  if (path === current) return upOne(current, layout, labels);
  const goal = c.isDir ? path : parentDir(path);
  let base = current;
  while (!isWithin(goal, base)) base = parentDir(base);
  if (goal === base) return goal;
  for (const p of prefixes(goal)) if (p.length > base.length && isWithin(p, base) && isLevel(p, layout, labels)) return p;
  return goal;
}

/**
 * Where a double click zooms, relative to the folder in view before the
 * click (`before`): straight to a folder, or to a file's folder; the
 * background of the folder in view steps out one level; outside the repo
 * returns to the root.
 */
export function doubleClickTarget(path: string | null, layout: Map<string, Circle>, labels: Map<string, string> | undefined, before: string): string {
  if (path === null) return "";
  const c = layout.get(path);
  if (!c) return "";
  if (path === before) return upOne(before, layout, labels);
  return c.isDir ? path : parentDir(path);
}
