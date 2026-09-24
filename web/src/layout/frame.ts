import type { RepoState } from "../store";
import { encodeAll, type NodeVisual } from "./encoding";
import { buildTree, nodeSizes } from "./nodes";
import { MIN_DIR_R, MIN_FILE_R, cullLayout, packTree, packValue, type Circle, type PackedTree } from "./pack";

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

// Packing is the expensive step, and most patches (an edit that stays in its
// size bucket, a new stage, activity only) leave its inputs unchanged. So the
// pack is cached by a signature of those inputs (the node paths with their
// packValue buckets) plus the viewport size, not by RepoState identity; the
// touched set, which the pack does not depend on, is passed to the cull.
// Keys are memoised per RepoState, so zooming (same state, same size, new
// scale) only re-culls and re-encodes.
interface PackKey {
  sig: string;
  touched: ReadonlySet<string>;
}
const keyCache = new WeakMap<RepoState, PackKey>();
let lastPack: { sig: string; packed: PackedTree } | null = null;

function packKey(state: RepoState): PackKey {
  const hit = keyCache.get(state);
  if (hit) return hit;
  const { sizes, touched } = nodeSizes(state);
  // Paths never contain NUL, so this is unambiguous. Map order is not sorted:
  // the same set in another order only costs a re-pack, never a wrong hit.
  const parts = [state.repo.name];
  for (const [path, size] of sizes) parts.push(path, String(packValue(size)));
  const key = { sig: parts.join("\0"), touched };
  keyCache.set(state, key);
  return key;
}

/** The packed tree for `state` in a width×height rect, reused while its inputs are unchanged. */
export function packedFor(state: RepoState, width: number, height: number): PackedTree {
  const { sig } = packKey(state);
  if (lastPack && lastPack.sig === sig && lastPack.packed.width === width && lastPack.packed.height === height) return lastPack.packed;
  const packed = packTree(buildTree(state), width, height);
  lastPack = { sig, packed };
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
  const cull = { minFileR: MIN_FILE_R / k, minDirR: MIN_DIR_R / k, keep: linger, touched: packKey(state).touched };
  const layout = cullLayout(packed, cull, free.x0, free.y0);
  return { layout, visuals: encodeAll(state, layout), free };
}

/** The rect left for the map in a width×height viewport after `pad` (see computeFrame). */
export function freeArea(width: number, height: number, pad: number | Insets): FreeArea {
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
