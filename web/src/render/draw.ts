import type { FillInput, Graphics } from "pixi.js";
import { clipArc, dashArcs, rimView, type Rect, type RimView } from "./geometry";

// Vector drawing helpers for MapRenderer. Every shape is built in screen px
// around the origin (the node's centre); circles far larger than the
// viewport are clipped to what can be on screen (see rimView).

export const RING_GAP_PX = 2.5; // ring sits this far outside the bubble, on screen
export const RING_W_PX = 1.5;
const MAX_DASHES = 4000; // per ring; a safety net, the visible-arc clip keeps real counts far lower

/** Which part of a circle to draw: its fill, and its rim (outline and rings). */
export interface Clip {
  fill: RimView;
  stroke: RimView;
  key: string; // changes whenever the clipped geometry does
}

export const WHOLE: Clip = { fill: { kind: "full" }, stroke: { kind: "full" }, key: "" };

/** Viewport clipping for a circle (centre sx, sy; radius R) much larger than the screen. */
export function clipFor(sx: number, sy: number, R: number, rect: Rect): Clip {
  const fill = rimView(sx, sy, R, rect);
  const stroke = rimView(sx, sy, R + RING_GAP_PX + RING_W_PX, rect);
  const part = (v: RimView): string =>
    v.kind === "arc" ? `${v.a0.toFixed(4)},${v.a1.toFixed(4)}` : v.kind === "covers" ? `${Math.round(sx)},${Math.round(sy)}` : v.kind;
  return { fill, stroke, key: `${part(fill)}/${part(stroke)}` };
}

/** Fills the circle of radius R, or just its part on screen (the viewport rect when it covers it). */
export function disk(g: Graphics, R: number, clip: Clip, sx: number, sy: number, rect: Rect, style: FillInput): void {
  const v = clip.fill;
  if (v.kind === "hidden") return;
  if (v.kind === "covers") g.rect(rect.x0 - sx, rect.y0 - sy, rect.x1 - rect.x0, rect.y1 - rect.y0).fill(style);
  else if (v.kind === "arc") g.moveTo(0, 0).arc(0, 0, R, v.a0, v.a1).closePath().fill(style);
  else g.circle(0, 0, R).fill(style);
}

/** The parts of the arc a0..a1 that can be on screen. */
function visibleParts(a0: number, a1: number, clip: Clip): [number, number][] {
  const v = clip.stroke;
  if (v.kind === "arc") return clipArc(a0, a1, v);
  return v.kind === "full" ? [[a0, a1]] : [];
}

export function solidArc(g: Graphics, R: number, a0: number, a1: number, clip: Clip, color: number, alpha: number, width: number): void {
  const parts = visibleParts(a0, a1, clip);
  if (parts.length === 0) return;
  for (const [s, e] of parts) g.moveTo(Math.cos(s) * R, Math.sin(s) * R).arc(0, 0, R, s, e);
  g.stroke({ color, alpha, width });
}

/**
 * A solid outline of radius R: the whole circle, or its visible arc. With
 * `gapHalf` > 0 it is broken for ±gapHalf around 12 o'clock (behind a label).
 */
export function outline(g: Graphics, R: number, clip: Clip, color: number, alpha: number, width: number, gapHalf = 0): void {
  if (gapHalf <= 0 && clip.stroke.kind === "full") {
    g.circle(0, 0, R).stroke({ color, alpha, width });
    return;
  }
  const top = -Math.PI / 2;
  solidArc(g, R, top + gapHalf, top + Math.PI * 2 - gapHalf, clip, color, alpha, width);
}

/** Dashes of `dashPx` on / `gapPx` off along a0..a1, phase-locked to a0 so clipping never shifts them. */
export function dashed(g: Graphics, R: number, a0: number, a1: number, clip: Clip, color: number, alpha: number, width: number, dashPx: number, gapPx: number): void {
  const step = (dashPx + gapPx) / R;
  let count = 0;
  for (const [s, e] of visibleParts(a0, a1, clip)) {
    const start = a0 + Math.floor((s - a0) / step) * step;
    for (const [ds, de] of dashArcs(R, dashPx, gapPx, start, e)) {
      if (++count > MAX_DASHES) break;
      g.moveTo(Math.cos(ds) * R, Math.sin(ds) * R).arc(0, 0, R, ds, de);
    }
  }
  if (count > 0) g.stroke({ color, alpha, width });
}
