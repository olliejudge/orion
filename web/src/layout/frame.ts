import type { RepoState } from "../store";
import { encodeAll, type NodeVisual } from "./encoding";
import { buildTree } from "./nodes";
import { MIN_DIR_R, MIN_FILE_R, cullLayout, packTree, type Circle, type PackedTree } from "./pack";

export interface Frame {
  layout: Map<string, Circle>;
  visuals: Map<string, NodeVisual>;
  free: FreeArea; // the viewport rect the root was fitted into (CSS px)
}

export interface FreeArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Margins around the map's free area, per side. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// The scale-independent pack for the latest viewport size, per state. The
// store makes a new RepoState per patch, so identity is a safe cache key, and
// zooming (same state, same size, new scale) only re-culls and re-encodes.
const packCache = new WeakMap<RepoState, PackedTree>();

function packedFor(state: RepoState, width: number, height: number): PackedTree {
  const hit = packCache.get(state);
  if (hit && hit.width === width && hit.height === height) return hit;
  const packed = packTree(buildTree(state), width, height);
  packCache.set(state, packed);
  return packed;
}

/**
 * state → layout + visuals for a viewport of width×height CSS px, viewed at
 * camera `scale` (1 = whole repo fits). Culling thresholds are on-screen
 * pixels, so they are divided by the scale. `pad` keeps the root circle
 * inside the viewport: a number pads every side equally (the root stays
 * centred on the viewport); per-side Insets centre it in the space left over
 * (room for a side panel). Either way at most half of each axis is given up.
 * The identity camera still shows the root where it is laid out; `free` is
 * that rect, for fitting zoom targets. `linger` paths (e.g. files shimmering
 * after a merge) are kept like touched files, so a merge never reads as a
 * deletion at low zoom.
 */
export function computeFrame(
  state: RepoState,
  width: number,
  height: number,
  scale: number,
  pad: number | Insets = 0,
  linger?: ReadonlySet<string>,
): Frame {
  const k = Math.max(scale, 1e-6);
  const free = freeArea(width, height, pad);
  const packed = packedFor(state, free.x1 - free.x0, free.y1 - free.y0);
  const layout = cullLayout(packed, { minFileR: MIN_FILE_R / k, minDirR: MIN_DIR_R / k, keep: linger }, free.x0, free.y0);
  return { layout, visuals: encodeAll(state, layout), free };
}

function freeArea(width: number, height: number, pad: number | Insets): FreeArea {
  if (typeof pad === "number") {
    const p = Math.max(0, Math.min(pad, width / 4, height / 4));
    return { x0: p, y0: p, x1: width - p, y1: height - p };
  }
  // Scale each axis's pair of insets down so together they take ≤ half of it.
  const fit = (a: number, b: number, size: number): [number, number] => {
    const lo = Math.max(0, a);
    const hi = Math.max(0, b);
    const f = lo + hi > size / 2 ? size / 2 / (lo + hi) : 1;
    return [lo * f, hi * f];
  };
  const [left, right] = fit(pad.left, pad.right, width);
  const [top, bottom] = fit(pad.top, pad.bottom, height);
  return { x0: left, y0: top, x1: width - right, y1: height - bottom };
}
