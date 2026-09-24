import type { RepoState } from "../store";
import { encodeAll, type NodeVisual } from "./encoding";
import { buildTree } from "./nodes";
import { MIN_DIR_R, MIN_FILE_R, computeLayout, type Circle } from "./pack";

export interface Frame {
  layout: Map<string, Circle>;
  visuals: Map<string, NodeVisual>;
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
  const layout = computeLayout(buildTree(state), width - 2 * p, height - 2 * p, { minFileR: MIN_FILE_R / k, minDirR: MIN_DIR_R / k });
  if (p > 0) {
    for (const c of layout.values()) {
      c.x += p;
      c.y += p;
    }
  }
  return { layout, visuals: encodeAll(state, layout) };
}
