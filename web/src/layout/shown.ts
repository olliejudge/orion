import type { Circle } from "./pack";

/**
 * Where `path` is on the map: the path itself when the layout has it, else
 * its nearest ancestor that does (typically a collapsed folder's aggregate
 * circle, which stands in for every file inside it). The root never stands
 * in, since that would mark the whole map: a path whose only shown ancestor
 * is the root gives null.
 */
export function nearestShown(path: string, layout: ReadonlyMap<string, Circle>): string | null {
  for (let p = path; p !== ""; p = p.slice(0, Math.max(0, p.lastIndexOf("/")))) {
    if (layout.has(p)) return p;
  }
  return null;
}
