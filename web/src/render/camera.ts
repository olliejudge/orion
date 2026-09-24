// Free camera navigation (wheel/pinch zoom about the pointer, drag to pan).
// Pure functions of the camera, so the maths is unit-tested without Pixi.
import type { Circle } from "../layout/pack";
import { MAX_ZOOM, screenToWorld, zoomPath, type Camera, type Rect } from "./geometry";

/** The root is laid out to fill the free area at the identity camera (see fitCamera), so k = 1 is "whole repo". */
export const MIN_ZOOM = 1;
/** A folder is the view's focus once its circle spans this much of the free area's short side. */
export const FOCUS_FILL = 0.7;

const WHEEL_PER_PX = 0.002; // mouse wheel / two-finger scroll: ~18% per 100 px notch
const PINCH_PER_PX = 0.01; // trackpad pinch arrives as ctrl+wheel with small deltas
const LINE_PX = 16;
const MAX_STEP = Math.log(2); // one event zooms at most 2×

export type CameraPath = (k: number) => { cx: number; cy: number };

/** Scale factor for one wheel event (> 1 zooms in). deltaMode: 0 px, 1 lines, 2 pages. */
export function wheelFactor(ev: { deltaY: number; deltaMode: number; ctrlKey: boolean }, pageHeight: number): number {
  const px = ev.deltaY * (ev.deltaMode === 1 ? LINE_PX : ev.deltaMode === 2 ? pageHeight : 1);
  const step = px * (ev.ctrlKey ? PINCH_PER_PX : WHEEL_PER_PX);
  if (step === 0) return 1;
  return Math.exp(-Math.max(-MAX_STEP, Math.min(MAX_STEP, step)));
}

/** The home camera: the whole repo, where it is laid out. */
export function homeCamera(width: number, height: number): Camera {
  return { cx: width / 2, cy: height / 2, k: 1 };
}

/**
 * Keeps the world point at the free area's centre inside the root circle, so
 * the repo can never be dragged (or zoomed) wholly off screen.
 */
export function clampPan(cam: Camera, root: Circle | undefined, width: number, height: number, free: Rect): Camera {
  if (!root) return cam;
  const p = screenToWorld(cam, width, height, (free.x0 + free.x1) / 2, (free.y0 + free.y1) / 2);
  const dx = p.x - root.x;
  const dy = p.y - root.y;
  const d = Math.hypot(dx, dy);
  if (d <= root.r) return cam;
  const s = root.r / d;
  return { cx: cam.cx + (root.x + dx * s - p.x), cy: cam.cy + (root.y + dy * s - p.y), k: cam.k };
}

/** The camera `start` dragged by (dx, dy) screen px: the world follows the pointer. */
export function panBy(start: Camera, dx: number, dy: number, root: Circle | undefined, width: number, height: number, free: Rect): Camera {
  return clampPan({ cx: start.cx - dx / start.k, cy: start.cy - dy / start.k, k: start.k }, root, width, height, free);
}

/**
 * Zoom by `factor` about the screen point (sx, sy). The scale accumulates on
 * `aimed` (the camera's current target) so quick wheel ticks add up, while the
 * anchor is the world point under the pointer in `cur` (what is on screen now).
 * Returns the target camera and the centre as a function of scale along the
 * way, which keeps that point under the pointer throughout (null: spring the
 * centre directly). Zooming out past the whole repo returns home.
 */
export function zoomAround(
  cur: Camera,
  aimed: Camera,
  factor: number,
  sx: number,
  sy: number,
  width: number,
  height: number,
  root: Circle | undefined,
  free: Rect,
): { target: Camera; path: CameraPath | null } {
  const k = Math.min(MAX_ZOOM, aimed.k * factor);
  if (k <= MIN_ZOOM) {
    const home = homeCamera(width, height);
    return { target: home, path: zoomPath(cur, home) };
  }
  const w = screenToWorld(cur, width, height, sx, sy);
  const ox = sx - width / 2;
  const oy = sy - height / 2;
  const anchored: CameraPath = (kk) => ({ cx: w.x - ox / kk, cy: w.y - oy / kk });
  const target = { ...anchored(k), k };
  const clamped = clampPan(target, root, width, height, free);
  if (clamped.cx === target.cx && clamped.cy === target.cy) return { target, path: anchored };
  return { target: clamped, path: zoomPath(cur, clamped) };
}

/**
 * The folder the view is on after free navigation: the deepest folder whose
 * circle contains the free area's centre and spans at least FOCUS_FILL of its
 * short side; the root ("") when none does.
 */
export function focusFolder(layout: Map<string, Circle>, cam: Camera, width: number, height: number, free: Rect): string {
  const p = screenToWorld(cam, width, height, (free.x0 + free.x1) / 2, (free.y0 + free.y1) / 2);
  const need = (FOCUS_FILL * Math.min(free.x1 - free.x0, free.y1 - free.y0)) / 2 / cam.k;
  let best: Circle | null = null;
  for (const c of layout.values()) {
    if (!c.isDir || c.depth === 0 || c.r < need) continue;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    if (dx * dx + dy * dy > c.r * c.r) continue;
    if (best === null || c.depth > best.depth) best = c;
  }
  return best ? best.path : "";
}

/**
 * A free camera carried along when the folder it is focused on moves or
 * resizes in a relayout (live edits repack the map): the view keeps showing
 * the same part of that folder, at the same relative size.
 */
export function follow(cam: Camera, was: Circle, now: Circle): Camera {
  if (!(was.r > 0) || !(now.r > 0)) return cam;
  const s = now.r / was.r;
  return { cx: now.x + (cam.cx - was.x) * s, cy: now.y + (cam.cy - was.y) * s, k: cam.k / s };
}
