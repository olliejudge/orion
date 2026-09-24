import type { Circle } from "../layout/pack";

// ---- picking -------------------------------------------------------------

/** Deepest circle containing (x, y) in world coordinates; ties → smaller radius. O(n), no Pixi hit-testing. */
export function pick(layout: Map<string, Circle>, x: number, y: number): string | null {
  let best: Circle | null = null;
  for (const c of layout.values()) {
    const dx = x - c.x;
    const dy = y - c.y;
    if (dx * dx + dy * dy > c.r * c.r) continue;
    if (best === null || c.depth > best.depth || (c.depth === best.depth && c.r < best.r)) best = c;
  }
  return best ? best.path : null;
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// ---- camera --------------------------------------------------------------

/** World point shown at the viewport centre, and scale. Identity = {w/2, h/2, 1}. */
export interface Camera {
  cx: number;
  cy: number;
  k: number;
}

const MAX_ZOOM = 1000;
const FIT = 0.9;

export function fitCamera(c: Circle, width: number, height: number): Camera {
  if (c.depth === 0) return { cx: width / 2, cy: height / 2, k: 1 };
  const k = Math.min(MAX_ZOOM, (Math.min(width, height) * FIT) / (2 * Math.max(c.r, 1e-9)));
  return { cx: c.x, cy: c.y, k };
}

export function worldToScreen(cam: Camera, width: number, height: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - cam.cx) * cam.k + width / 2, y: (y - cam.cy) * cam.k + height / 2 };
}

export function screenToWorld(cam: Camera, width: number, height: number, x: number, y: number): { x: number; y: number } {
  return { x: (x - width / 2) / cam.k + cam.cx, y: (y - height / 2) / cam.k + cam.cy };
}

/**
 * A zoom from one camera to another as a pure scale about the one world point
 * that sits at the same screen position in both, so the target never swings
 * off screen mid-zoom (animating centre and scale separately would). Returns
 * the camera centre for a scale k along the way, or null when the scales are
 * (nearly) equal or invalid: that move is a pan.
 */
export function zoomPath(from: Camera, to: Camera): ((k: number) => { cx: number; cy: number }) | null {
  if (!(from.k > 0) || !(to.k > 0) || !Number.isFinite(from.k) || !Number.isFinite(to.k)) return null;
  if (Math.abs(Math.log(to.k / from.k)) < 0.05) return null;
  const px = (to.cx * to.k - from.cx * from.k) / (to.k - from.k);
  const py = (to.cy * to.k - from.cy * from.k) / (to.k - from.k);
  const ax = (px - from.cx) * from.k;
  const ay = (py - from.cy) * from.k;
  return (k) => ({ cx: px - ax / k, cy: py - ay / k });
}

// ---- viewport clipping ---------------------------------------------------

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * How much of a circle's rim can be inside `rect` (all in one coordinate
 * space, e.g. screen px):
 * - hidden: the circle does not reach the rect;
 * - covers: the rect lies wholly inside the circle, so the rim is off screen;
 * - full: the centre is inside the rect, so any of the rim may show;
 * - arc: the centre is outside, so only angles a0..a1 (a0 < a1, span < π)
 *   can show. Lets huge zoomed-in circles draw only their visible arc.
 */
export type RimView = { kind: "hidden" } | { kind: "covers" } | { kind: "full" } | { kind: "arc"; a0: number; a1: number };

export function rimView(x: number, y: number, r: number, rect: Rect): RimView {
  const nx = Math.min(Math.max(x, rect.x0), rect.x1) - x;
  const ny = Math.min(Math.max(y, rect.y0), rect.y1) - y;
  if (nx * nx + ny * ny > r * r) return { kind: "hidden" };
  const fx = Math.max(Math.abs(x - rect.x0), Math.abs(x - rect.x1));
  const fy = Math.max(Math.abs(y - rect.y0), Math.abs(y - rect.y1));
  if (fx * fx + fy * fy <= r * r) return { kind: "covers" };
  if (nx === 0 && ny === 0) return { kind: "full" };
  const ref = Math.atan2((rect.y0 + rect.y1) / 2 - y, (rect.x0 + rect.x1) / 2 - x);
  let a0 = Infinity;
  let a1 = -Infinity;
  for (const [cx, cy] of [
    [rect.x0, rect.y0],
    [rect.x1, rect.y0],
    [rect.x0, rect.y1],
    [rect.x1, rect.y1],
  ] as const) {
    let a = Math.atan2(cy - y, cx - x);
    while (a < ref - Math.PI) a += Math.PI * 2;
    while (a > ref + Math.PI) a -= Math.PI * 2;
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
  }
  return { kind: "arc", a0, a1 };
}

/** Parts of the arc a0..a1 inside the angular window w, trying the window shifted by whole turns. */
export function clipArc(a0: number, a1: number, w: { a0: number; a1: number }): [number, number][] {
  const out: [number, number][] = [];
  const turn = Math.PI * 2;
  for (let m = -2; m <= 2; m++) {
    const s = Math.max(a0, w.a0 + m * turn);
    const e = Math.min(a1, w.a1 + m * turn);
    if (e > s) out.push([s, e]);
  }
  return out;
}

// ---- folder labels along the top arc ------------------------------------

/**
 * Centre angle of each glyph when a label is set along the top of a circle of
 * `radius`, reading left to right (y points down, so −π/2 is 12 o'clock).
 */
export function arcLetterAngles(widths: number[], radius: number): number[] {
  const total = widths.reduce((a, b) => a + b, 0);
  let angle = -Math.PI / 2 - total / radius / 2;
  return widths.map((w) => {
    const center = angle + w / radius / 2;
    angle += w / radius;
    return center;
  });
}

/** How many leading glyphs fit within `maxSpan` radians; if truncated, room is left for an ellipsis. */
export function fitLabel(widths: number[], radius: number, maxSpan: number, ellipsisWidth: number): number {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total / radius <= maxSpan) return widths.length;
  let used = ellipsisWidth;
  let n = 0;
  for (const w of widths) {
    if ((used + w) / radius > maxSpan) break;
    used += w;
    n++;
  }
  return n;
}

// ---- rings ---------------------------------------------------------------

/** One arc per worktree for a split ring, clockwise from 12 o'clock, `gap` radians between. */
export function splitSegments(n: number, gap: number): [number, number][] {
  const start = -Math.PI / 2;
  if (n <= 1) return [[start, start + Math.PI * 2]];
  const span = (Math.PI * 2) / n;
  return Array.from({ length: n }, (_, i) => [start + i * span + gap / 2, start + (i + 1) * span - gap / 2]);
}

/** Dash arcs of `dash` px separated by `gap` px (arc length) between angles a0..a1. */
export function dashArcs(radius: number, dash: number, gap: number, a0: number, a1: number): [number, number][] {
  const out: [number, number][] = [];
  if (radius <= 0 || dash + gap <= 0) return out;
  const d = dash / radius;
  const step = (dash + gap) / radius;
  for (let a = a0; a < a1 - 1e-9; a += step) out.push([a, Math.min(a + d, a1)]);
  return out;
}

// ---- rename glide --------------------------------------------------------

export interface Glide {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

/**
 * Sideways offset that bends a straight spring path into a gentle arc: zero at
 * both ends, 15% of the travel distance at the midpoint, on the left of the
 * direction of travel. Progress is measured from the current position.
 */
export function glideOffset(g: Glide, x: number, y: number): { x: number; y: number } {
  const dx = g.toX - g.fromX;
  const dy = g.toY - g.fromY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { x: 0, y: 0 };
  const along = ((x - g.fromX) * dx + (y - g.fromY) * dy) / (dist * dist);
  const p = Math.min(1, Math.max(0, along));
  const bow = Math.sin(Math.PI * p) * 0.15 * dist;
  return { x: (dy / dist) * bow, y: (-dx / dist) * bow };
}

// ---- click-to-zoom -------------------------------------------------------

/**
 * Where a click should zoom to: a folder (or collapsed folder) zooms into
 * itself; a file zooms to its folder; clicking the folder already in view
 * steps out one level; clicking outside the repo returns to the root.
 */
export function clickTarget(path: string | null, layout: Map<string, Circle>, current: string): string {
  if (path === null) return "";
  if (path === current) return parentDir(current);
  const c = layout.get(path);
  if (!c) return "";
  return c.isDir ? path : parentDir(path);
}

// ---- label text ----------------------------------------------------------

/**
 * Folder label text per labelled directory. A folder whose only visible
 * child is another folder would draw its name on top of the child's (their
 * rims nearly coincide), so such chains are compressed: `web` › `src` is
 * labelled once, on the inner circle, as "web/src". The root and collapsed
 * (aggregate) folders get no label.
 */
export function labelNames(layout: Map<string, Circle>): Map<string, string> {
  const kids = new Map<string, Circle[]>();
  for (const c of layout.values()) {
    if (c.depth === 0) continue;
    const p = parentDir(c.path);
    const list = kids.get(p);
    if (list) list.push(c);
    else kids.set(p, [c]);
  }
  const passThrough = (path: string): boolean => {
    const k = kids.get(path);
    return k !== undefined && k.length === 1 && k[0]!.isDir && k[0]!.aggregate === undefined;
  };
  const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
  const out = new Map<string, string>();
  for (const c of layout.values()) {
    if (!c.isDir || c.depth === 0 || c.aggregate !== undefined || passThrough(c.path)) continue;
    let name = base(c.path);
    let p = parentDir(c.path);
    while (p !== "" && passThrough(p)) {
      name = `${base(p)}/${name}`;
      p = parentDir(p);
    }
    out.set(c.path, name);
  }
  return out;
}
