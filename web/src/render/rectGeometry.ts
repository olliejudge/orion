import type { Box, Circle } from "../layout/pack";
import { boxOf } from "./rectScene";

/**
 * Pure geometry for RectRenderer (tree map and partition): box helpers,
 * border segments for split worktree rings, label fitting and hit testing.
 */

export type Point = readonly [number, number];
/** A straight line from (x0, y0) to (x1, y1). */
export type Line = readonly [x0: number, y0: number, x1: number, y1: number];

export function boxW(b: Box): number {
  return b.x1 - b.x0;
}

export function boxH(b: Box): number {
  return b.y1 - b.y0;
}

/** The box shrunk by d on every side (grown when d < 0); never inside out. */
export function inset(b: Box, d: number): Box {
  const dx = Math.min(d, boxW(b) / 2);
  const dy = Math.min(d, boxH(b) / 2);
  return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 - dx, y1: b.y1 - dy };
}

/**
 * The box's perimeter split into n equal runs, clockwise from the top-left
 * corner, with `gap` px left empty at the start of each run when n > 1 (so
 * neighbouring colours separate). Each run is a polyline, turning at corners.
 */
export function perimeterSegments(b: Box, n: number, gap = 0): Point[][] {
  const w = Math.max(0, boxW(b));
  const h = Math.max(0, boxH(b));
  const total = 2 * (w + h);
  if (n <= 0 || total === 0) return [];
  const corners: Point[] = [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x1, b.y1],
    [b.x0, b.y1],
  ];
  const lens = [w, h, w, h];
  const at = (d: number): Point => {
    let rest = Math.max(0, Math.min(total, d));
    for (let i = 0; i < 4; i++) {
      const len = lens[i]!;
      if (rest <= len || i === 3) {
        const [ax, ay] = corners[i]!;
        const [bx, by] = corners[(i + 1) % 4]!;
        const t = len === 0 ? 0 : Math.min(1, rest / len);
        return [ax + (bx - ax) * t, ay + (by - ay) * t];
      }
      rest -= len;
    }
    return corners[0]!;
  };
  const cum = [0, w, w + h, 2 * w + h, total];
  const step = total / n;
  const g = n > 1 ? Math.min(gap, step / 2) : 0;
  const out: Point[][] = [];
  for (let i = 0; i < n; i++) {
    const s = i * step + g / 2;
    const e = (i + 1) * step - g / 2;
    const pts: Point[] = [at(s)];
    for (const c of cum) if (c > s && c < e) pts.push(at(c));
    pts.push(at(e));
    out.push(pts);
  }
  return out;
}

/** Dashes of `dash` px on / `gap` px off along a polyline, phase-continuous across its corners. */
export function dashPolyline(pts: readonly Point[], dash: number, gap: number): Line[] {
  const out: Line[] = [];
  const period = dash + gap;
  if (period <= 0) return out;
  let phase = 0; // distance into the current period
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    let d = 0;
    while (d < len) {
      const on = phase < dash;
      const run = Math.min(len - d, (on ? dash : period) - phase);
      if (on) out.push([ax + ux * d, ay + uy * d, ax + ux * (d + run), ay + uy * (d + run)]);
      d += run;
      phase = (phase + run) % period;
    }
  }
  return out;
}

/**
 * The longest prefix of `text` (whole, or cut with "…") that is at most
 * `maxWidth` wide by `measure`; null when not even one letter and the
 * ellipsis fit.
 */
export function fitText(text: string, maxWidth: number, measure: (s: string) => number): string | null {
  if (maxWidth <= 0 || text === "") return null;
  if (measure(text) <= maxWidth) return text;
  const chars = [...text];
  let lo = 1;
  let hi = chars.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = chars.slice(0, mid).join("") + "…";
    if (measure(s) <= maxWidth) {
      best = s;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** The smallest non-hidden box containing (x, y), or null (the background). */
export function pickBox(layout: Map<string, Circle>, x: number, y: number): string | null {
  let best: string | null = null;
  let bestArea = Infinity;
  for (const c of layout.values()) {
    if (c.hidden) continue;
    const b = boxOf(c);
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
    const area = boxW(b) * boxH(b);
    if (area < bestArea || (area === bestArea && best !== null && c.depth > (layout.get(best)?.depth ?? 0))) {
      best = c.path;
      bestArea = area;
    }
  }
  return best;
}

/** The folder in view: the non-hidden entry with the lowest depth (the frame of everything). */
export function focusOf(layout: Map<string, Circle>): string | null {
  let best: Circle | null = null;
  for (const c of layout.values()) {
    if (!c.hidden && (best === null || c.depth < best.depth)) best = c;
  }
  return best?.path ?? null;
}

export interface LabelWant {
  path: string;
  /** Lower draws first (and survives the cap). */
  rank: number;
}

/** The labels to draw: by rank (ties keep input order), at most `cap`. */
export function capLabels<T extends LabelWant>(wants: T[], cap: number): T[] {
  return wants
    .map((w, i) => ({ w, i }))
    .sort((a, b) => a.w.rank - b.w.rank || a.i - b.i)
    .slice(0, Math.max(0, cap))
    .map((x) => x.w);
}
