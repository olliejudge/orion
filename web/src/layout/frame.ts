import type { RepoState } from "../store";
import { encodeAll, type NodeVisual } from "./encoding";
import { buildTree } from "./nodes";
import { MIN_DIR_R, MIN_FILE_R, cullLayout, packTree, type Circle, type PackedTree } from "./pack";

export interface Frame {
  layout: Map<string, Circle>;
  visuals: Map<string, NodeVisual>;
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
 * pixels, so they are divided by the scale. `pad` keeps the root circle that
 * far inside the viewport (room for the floating panels); the root stays
 * centred on the viewport so the identity camera still fits it.
 */
export function computeFrame(state: RepoState, width: number, height: number, scale: number, pad = 0): Frame {
  const k = Math.max(scale, 1e-6);
  const p = Math.max(0, Math.min(pad, width / 4, height / 4));
  const packed = packedFor(state, width - 2 * p, height - 2 * p);
  const layout = cullLayout(packed, { minFileR: MIN_FILE_R / k, minDirR: MIN_DIR_R / k }, p, p);
  return { layout, visuals: encodeAll(state, layout) };
}
