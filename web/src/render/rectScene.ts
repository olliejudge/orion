import { blankVisual, type NodeVisual } from "../layout/encoding";
import type { Box, Circle } from "../layout/pack";
import { nearestShown } from "../layout/shown";
import type { Change } from "../store";
import { PING_MS, PING_RECENT_MS, SHIMMER_MS, fresher, freshness } from "./scene";
import { SETTLE_EPS, SPRING_OMEGA, isSettled, makeSpring, retarget, snapSpring, stepSpring, type Spring } from "./springs";

/** Box springs settle within half a CSS pixel (there is no camera: layout px are screen px). */
export const BOX_EPS = 0.5;

export interface RectNode {
  path: string;
  isDir: boolean;
  depth: number;
  aggregate?: number;
  visual: NodeVisual;
  x0: Spring;
  y0: Spring;
  x1: Spring;
  y1: Spring;
  alpha: Spring;
  leaving: boolean;
  shimmerAt: number | null;
  pingAt: number | null;
}

/** A layout entry's box: its own, or (for a plain circle) the square around it. */
export function boxOf(c: Circle): Box {
  return c.box ?? { x0: c.x - c.r, y0: c.y - c.r, x1: c.x + c.r, y1: c.y + c.r };
}

function atRest(s: Spring): boolean {
  return s.value === s.target && s.velocity === 0;
}

function parentOf(path: string): string | null {
  if (path === "") return null;
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * Animation state for the rectangle views (tree map, partition), keyed by
 * path: the analogue of Scene for boxes. Pure, so it is unit-tested without
 * WebGL. There is no camera: zooming into a folder is a new layout where
 * that folder fills the screen, so boxes spring from where they were to
 * where they now are.
 *
 * - Hidden layout entries (ancestors of the folder in view) are skipped.
 * - A new node starts at the current box of its nearest ancestor on screen
 *   (zooming out reads as growth from the folder), else at its own box,
 *   fading in from alpha 0.
 * - Nodes missing from the layout shrink to their centre and fade, then are dropped.
 * - Merged paths shimmer for SHIMMER_MS; fresher work (or a node first seen
 *   touched within PING_RECENT_MS of `wall`) pings for PING_MS, as in Scene.
 */
export class RectScene {
  readonly nodes = new Map<string, RectNode>();
  /** Whether any box or alpha spring moved in the last step (the renderer redraws its base layer while true). */
  moving = false;

  get(path: string): RectNode | undefined {
    return this.nodes.get(path);
  }

  /** Diff a new layout in. Returns true when anything needs animating. */
  update(layout: Map<string, Circle>, visuals: Map<string, NodeVisual>, change: Change, now: number, wall: number = Date.now()): boolean {
    const next = new Map<string, RectNode>();
    for (const c of layout.values()) {
      if (c.hidden) continue;
      const visual = visuals.get(c.path) ?? blankVisual(c.path);
      const b = boxOf(c);
      let n = this.nodes.get(c.path);
      const ping = n ? !n.leaving && fresher(n.visual, visual) : freshness(visual).at >= wall - PING_RECENT_MS;
      if (n) {
        this.#aim(n, b, 1);
        n.leaving = false;
      } else {
        const from = this.#ancestor(c.path, next);
        n = from
          ? this.#make(c, visual, { x0: from.x0.value, y0: from.y0.value, x1: from.x1.value, y1: from.y1.value }, from.alpha.value)
          : this.#make(c, visual, b, 0);
        this.#aim(n, b, 1);
      }
      n.visual = visual;
      if (ping) n.pingAt = now;
      n.isDir = c.isDir;
      n.depth = c.depth;
      if (c.aggregate !== undefined) n.aggregate = c.aggregate;
      else delete n.aggregate;
      next.set(c.path, n);
    }
    for (const [path, n] of this.nodes) {
      if (next.has(path)) continue;
      n.leaving = true;
      const cx = (n.x0.target + n.x1.target) / 2;
      const cy = (n.y0.target + n.y1.target) / 2;
      this.#aim(n, { x0: cx, y0: cy, x1: cx, y1: cy }, 0);
      next.set(path, n);
    }
    this.nodes.clear();
    for (const [k, v] of next) this.nodes.set(k, v);

    for (const path of new Set(change.merged.map((p) => nearestShown(p, layout)))) {
      const n = path === null ? undefined : this.nodes.get(path);
      if (n && !n.leaving) n.shimmerAt = now;
    }

    for (const n of this.nodes.values()) {
      if (n.shimmerAt !== null || n.pingAt !== null || !atRest(n.alpha) || !atRest(n.x0) || !atRest(n.y0) || !atRest(n.x1) || !atRest(n.y1)) return true;
    }
    return false;
  }

  /**
   * Advance all springs by dtMs (NaN/negative → 0, capped at 64 ms). Returns
   * true while anything is still moving, shimmering or pinging. With `snap`
   * (reduced motion) every spring jumps straight to its target.
   */
  step(dtMs: number, now: number, snap = false): boolean {
    const dt = Math.max(0, Math.min(dtMs || 0, 64)) / 1000;
    let busy = false;
    let movingAny = false;
    for (const [path, n] of this.nodes) {
      const springs = [n.x0, n.y0, n.x1, n.y1];
      if (snap) {
        for (const s of springs) snapSpring(s);
        snapSpring(n.alpha);
      } else {
        for (const s of springs) stepSpring(s, dt, SPRING_OMEGA, BOX_EPS);
        stepSpring(n.alpha, dt);
      }
      const moving = springs.some((s) => !isSettled(s, BOX_EPS)) || !isSettled(n.alpha, SETTLE_EPS);
      if (n.shimmerAt !== null && now - n.shimmerAt > SHIMMER_MS) n.shimmerAt = null;
      if (n.pingAt !== null && now - n.pingAt > PING_MS) n.pingAt = null;
      if (n.leaving && !moving) {
        this.nodes.delete(path);
        movingAny = true; // it disappears this frame: the base layer must redraw
        continue;
      }
      if (moving) movingAny = true;
      if (moving || n.shimmerAt !== null || n.pingAt !== null) busy = true;
    }
    this.moving = movingAny;
    return busy;
  }

  /** The node's box as drawn now. */
  box(n: RectNode): Box {
    return { x0: n.x0.value, y0: n.y0.value, x1: n.x1.value, y1: n.y1.value };
  }

  /** Shimmer progress 0..1, or null when not shimmering. */
  shimmer(n: RectNode, now: number): number | null {
    if (n.shimmerAt === null) return null;
    const p = (now - n.shimmerAt) / SHIMMER_MS;
    return p > 1 ? null : Math.max(0, p);
  }

  /** Ping progress 0..1, or null when not pinging. */
  ping(n: RectNode, now: number): number | null {
    if (n.pingAt === null) return null;
    const p = (now - n.pingAt) / PING_MS;
    return p > 1 ? null : Math.max(0, p);
  }

  /** The nearest ancestor on screen: one already placed by this update (pre-order), else a live one from before. */
  #ancestor(path: string, placed: Map<string, RectNode>): RectNode | undefined {
    for (let p = parentOf(path); p !== null; p = parentOf(p)) {
      const n = placed.get(p) ?? this.nodes.get(p);
      if (n && !n.leaving) return n;
    }
    return undefined;
  }

  #aim(n: RectNode, b: Box, alpha: number): void {
    retarget(n.x0, b.x0);
    retarget(n.y0, b.y0);
    retarget(n.x1, b.x1);
    retarget(n.y1, b.y1);
    retarget(n.alpha, alpha);
  }

  #make(c: Circle, visual: NodeVisual, b: Box, alpha: number): RectNode {
    return {
      path: c.path,
      isDir: c.isDir,
      depth: c.depth,
      visual,
      x0: makeSpring(b.x0),
      y0: makeSpring(b.y0),
      x1: makeSpring(b.x1),
      y1: makeSpring(b.y1),
      alpha: makeSpring(alpha),
      leaving: false,
      shimmerAt: null,
      pingAt: null,
    };
  }
}
