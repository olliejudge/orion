/**
 * Folder label placement. A name is set along the top of its folder's rim
 * (the outline is broken behind it). A folder tangent to its parent's top
 * would print its name over the parent's, so an at-rest pass places labels
 * outer (larger) first and pushes a colliding one up to MAX_INSET lines
 * inward, or hides it if that still collides: in a deep chain of nearly
 * concentric folders the inner name is dropped rather than drawn on top of,
 * or nearly touching, an outer one. Pure, so it is unit-tested without Pixi.
 */

export const LABEL_FONT_PX = 11;
/** One line of label text, and the clearance kept between two labels' bands. */
export const LABEL_LINE_PX = 13;
export const LABEL_MAX_SPAN = Math.PI * 0.8;
const SIDE_PAD_PX = 2;
/** Labels whose bands come closer than this (vertically) count as colliding. */
const NEAR_PX = 0.5;
export const MAX_INSET = 2;

export interface LabelCandidate {
  path: string;
  /** Circle centre and radius on screen, CSS px. */
  x: number;
  y: number;
  r: number;
  /** Width of the label text, CSS px. */
  width: number;
}

export interface LabelSpot {
  /** Lines pushed inward from the rim: 0 (on the rim) up to MAX_INSET. */
  inset: number;
  /** Radius of the text's centre line: r on the rim, less when pushed inward. */
  textR: number;
  /** Half the angle the text spans, centred on 12 o'clock. */
  half: number;
}

/** Angle a label of `width` px spans at radius `textR` (long names are truncated to LABEL_MAX_SPAN). */
export function labelSpan(width: number, textR: number): number {
  return Math.min(width / textR, LABEL_MAX_SPAN);
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function boxOf(c: LabelCandidate, textR: number, half: number): Box {
  const dx = textR * Math.sin(Math.min(half, Math.PI / 2)) + SIDE_PAD_PX;
  return {
    x0: c.x - dx,
    x1: c.x + dx,
    y0: c.y - textR - LABEL_FONT_PX / 2,
    y1: c.y - textR * Math.cos(half) + LABEL_FONT_PX / 2,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 + NEAR_PX && b.y0 < a.y1 + NEAR_PX;
}

/** Where each label goes; paths missing from the result are hidden. */
export function placeLabels(cands: readonly LabelCandidate[]): Map<string, LabelSpot> {
  const order = [...cands].sort((a, b) => b.r - a.r || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const placed: Box[] = [];
  const out = new Map<string, LabelSpot>();
  for (const c of order) {
    for (let inset = 0; inset <= MAX_INSET; inset++) {
      const textR = c.r - inset * LABEL_LINE_PX;
      if (textR < 2 * LABEL_FONT_PX) break;
      const half = labelSpan(c.width, textR) / 2;
      const box = boxOf(c, textR, half);
      if (placed.some((p) => overlaps(p, box))) continue;
      placed.push(box);
      out.set(c.path, { inset, textR, half });
      break;
    }
  }
  return out;
}
