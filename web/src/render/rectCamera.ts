// The rectangle views' free camera (wheel/pinch zoom about the pointer, drag
// to pan). The layout is in screen px at the home camera {w/2, h/2, 1}, so the
// camera only magnifies it. Pure, so the maths is unit-tested without Pixi.
import type { Box } from "../layout/pack";
import type { CameraPath } from "./camera";
import { screenToWorld, worldToScreen, zoomPath, type Camera, type Rect } from "./geometry";

/** The rectangle views zoom between the laid-out folder (1) and this. */
export const RECT_MAX_ZOOM = 40;

export function rectHome(width: number, height: number): Camera {
  return { cx: width / 2, cy: height / 2, k: 1 };
}

/** Keeps the world point at the free area's centre inside `bounds` (the folder in view), so it never leaves the screen. */
export function rectClampPan(cam: Camera, bounds: Box | undefined, width: number, height: number, free: Rect): Camera {
  if (!bounds) return cam;
  const p = screenToWorld(cam, width, height, (free.x0 + free.x1) / 2, (free.y0 + free.y1) / 2);
  const x = Math.max(bounds.x0, Math.min(bounds.x1, p.x));
  const y = Math.max(bounds.y0, Math.min(bounds.y1, p.y));
  return x === p.x && y === p.y ? cam : { cx: cam.cx + (x - p.x), cy: cam.cy + (y - p.y), k: cam.k };
}

/** The camera `start` dragged by (dx, dy) screen px: the content follows the pointer. */
export function rectPanBy(start: Camera, dx: number, dy: number, bounds: Box | undefined, width: number, height: number, free: Rect): Camera {
  return rectClampPan({ cx: start.cx - dx / start.k, cy: start.cy - dy / start.k, k: start.k }, bounds, width, height, free);
}

/**
 * Zoom by `factor` about the screen point (sx, sy), as zoomAround does for the
 * bubbles: the scale accumulates on `aimed`, the anchor is the point under the
 * pointer in `cur`. The scale is clamped to [1, RECT_MAX_ZOOM]; at 1 the camera
 * goes home (the folder in view, as laid out).
 */
export function rectZoomAround(
  cur: Camera,
  aimed: Camera,
  factor: number,
  sx: number,
  sy: number,
  width: number,
  height: number,
  bounds: Box | undefined,
  free: Rect,
): { target: Camera; path: CameraPath | null } {
  const k = Math.min(RECT_MAX_ZOOM, aimed.k * factor);
  if (k <= 1) {
    const home = rectHome(width, height);
    return { target: home, path: zoomPath(cur, home) };
  }
  const w = screenToWorld(cur, width, height, sx, sy);
  const ox = sx - width / 2;
  const oy = sy - height / 2;
  const anchored: CameraPath = (kk) => ({ cx: w.x - ox / kk, cy: w.y - oy / kk });
  const target = { ...anchored(k), k };
  const clamped = rectClampPan(target, bounds, width, height, free);
  if (clamped === target) return { target, path: anchored };
  return { target: clamped, path: zoomPath(cur, clamped) };
}

/** A world box on screen through `cam`. */
export function boxToScreen(cam: Camera, width: number, height: number, b: Box): Box {
  const a = worldToScreen(cam, width, height, b.x0, b.y0);
  return { x0: a.x, y0: a.y, x1: a.x + (b.x1 - b.x0) * cam.k, y1: a.y + (b.y1 - b.y0) * cam.k };
}
