import type { NodeVisual } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import type { Change } from "../store";
import { glideOffset, type Glide } from "./geometry";
import { SETTLE_EPS, SPRING_OMEGA, isSettled, makeSpring, retarget, stepSpring, type Spring } from "./springs";

export const DELETED_SCALE = 0.85;
export const SHIMMER_MS = 600;

export interface SceneNode {
  path: string;
  isDir: boolean;
  depth: number;
  aggregate?: number;
  visual: NodeVisual;
  x: Spring;
  y: Spring;
  r: Spring;
  alpha: Spring;
  leaving: boolean;
  glide: Glide | null;
  shimmerAt: number | null;
}

function atRest(s: Spring): boolean {
  return s.value === s.target && s.velocity === 0;
}

/**
 * Renderer-independent animation state: one node per visible circle, keyed by
 * path. Pure TypeScript so lifecycle behaviour is unit-tested without WebGL.
 *
 * - New nodes grow from r=0 at their target position.
 * - A node with `renamedFrom` whose source node is on screen starts at the
 *   source's current position/radius and glides (on an arc) to its target.
 * - Nodes missing from the layout shrink and fade out, then are dropped.
 * - Deleted files shrink to DELETED_SCALE × r (drawn as faint outlines).
 * - Paths in change.merged shimmer for SHIMMER_MS.
 */
export class Scene {
  readonly nodes = new Map<string, SceneNode>();

  get(path: string): SceneNode | undefined {
    return this.nodes.get(path);
  }

  /**
   * Diff a new layout into the scene. Returns true when anything needs
   * animating (so a stopped ticker must restart). The check is exact, not
   * epsilon-based, so it is correct at any zoom scale.
   */
  update(layout: Map<string, Circle>, visuals: Map<string, NodeVisual>, change: Change, now: number): boolean {
    const next = new Map<string, SceneNode>();
    for (const c of layout.values()) {
      const visual = visuals.get(c.path) ?? { path: c.path, ext: "", touches: [], ghost: false, deleted: false, tinted: false };
      const r = c.isDir ? c.r : visual.deleted ? c.r * DELETED_SCALE : c.r;
      let n = this.nodes.get(c.path);
      if (n) {
        retarget(n.x, c.x);
        retarget(n.y, c.y);
        retarget(n.r, r);
        retarget(n.alpha, 1);
        n.leaving = false;
        if (n.glide) n.glide = { ...n.glide, toX: c.x, toY: c.y };
      } else {
        const src = visual.renamedFrom ? this.nodes.get(visual.renamedFrom) : undefined;
        if (src) {
          n = this.#make(c, visual, src.x.value, src.y.value, src.r.value);
          retarget(n.r, r);
          n.glide = { fromX: src.x.value, fromY: src.y.value, toX: c.x, toY: c.y };
        } else {
          n = this.#make(c, visual, c.x, c.y, 0);
          retarget(n.r, r);
        }
      }
      n.visual = visual;
      n.isDir = c.isDir;
      n.depth = c.depth;
      if (c.aggregate !== undefined) n.aggregate = c.aggregate;
      else delete n.aggregate;
      next.set(c.path, n);
    }
    // Leaving nodes keep animating after the live ones (drawn on top of nothing new).
    for (const [path, n] of this.nodes) {
      if (next.has(path)) continue;
      n.leaving = true;
      retarget(n.r, 0);
      retarget(n.alpha, 0);
      next.set(path, n);
    }
    this.nodes.clear();
    for (const [k, v] of next) this.nodes.set(k, v);

    for (const path of change.merged) {
      const n = this.nodes.get(path);
      if (n && !n.leaving) n.shimmerAt = now;
    }

    for (const n of this.nodes.values()) {
      if (n.shimmerAt !== null || !atRest(n.x) || !atRest(n.y) || !atRest(n.r) || !atRest(n.alpha)) return true;
    }
    return false;
  }

  /**
   * Advance all springs by dtMs (NaN/negative → 0, capped at 64 ms). Returns
   * true while anything is still moving. `eps` is the settle epsilon for the
   * world-space springs (x, y, r); the renderer passes ~0.5 / k so that at
   * zoom k nothing snaps by more than half a screen pixel. Alpha is unitless
   * and always uses SETTLE_EPS.
   */
  step(dtMs: number, now: number, eps: number = SETTLE_EPS): boolean {
    const dt = Math.max(0, Math.min(dtMs || 0, 64)) / 1000;
    let busy = false;
    for (const [path, n] of this.nodes) {
      stepSpring(n.x, dt, SPRING_OMEGA, eps);
      stepSpring(n.y, dt, SPRING_OMEGA, eps);
      stepSpring(n.r, dt, SPRING_OMEGA, eps);
      stepSpring(n.alpha, dt);
      const moving = !isSettled(n.x, eps) || !isSettled(n.y, eps) || !isSettled(n.r, eps) || !isSettled(n.alpha);
      if (n.glide && !moving) n.glide = null;
      if (n.shimmerAt !== null && now - n.shimmerAt > SHIMMER_MS) n.shimmerAt = null;
      if (n.leaving && !moving) {
        this.nodes.delete(path);
        continue;
      }
      if (moving || n.shimmerAt !== null) busy = true;
    }
    return busy;
  }

  /** Current draw position, including the sideways bow of a rename glide. */
  drawPosition(n: SceneNode): { x: number; y: number } {
    if (!n.glide) return { x: n.x.value, y: n.y.value };
    const o = glideOffset(n.glide, n.x.value, n.y.value);
    return { x: n.x.value + o.x, y: n.y.value + o.y };
  }

  /** Shimmer progress 0..1, or null when not shimmering. */
  shimmer(n: SceneNode, now: number): number | null {
    if (n.shimmerAt === null) return null;
    const p = (now - n.shimmerAt) / SHIMMER_MS;
    return p > 1 ? null : Math.max(0, p);
  }

  #make(c: Circle, visual: NodeVisual, x: number, y: number, r: number): SceneNode {
    return {
      path: c.path,
      isDir: c.isDir,
      depth: c.depth,
      visual,
      x: makeSpring(x, c.x),
      y: makeSpring(y, c.y),
      r: makeSpring(r),
      alpha: makeSpring(1),
      leaving: false,
      glide: null,
      shimmerAt: null,
    };
  }
}
