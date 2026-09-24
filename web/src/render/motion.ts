/**
 * Motion policy for the canvas. With `prefers-reduced-motion: reduce`,
 * springs (nodes and camera) jump straight to their targets, and a merge is
 * marked by a brief static highlight instead of the growing shimmer pulse.
 * (Halos are static glows, so they need no change.) CSS animations are
 * already switched off by theme.css under the same media query.
 */

export const STATIC_FLASH_ALPHA = 0.3;
const SHIMMER_PEAK = 0.55;
const SHIMMER_GROWTH = 0.25;

export interface Motion {
  /** Springs snap to their targets instead of animating. */
  snap: boolean;
  /** The merge flash at shimmer progress p (0..1): its alpha and scale relative to the bubble. */
  shimmer(p: number): { alpha: number; scale: number };
}

export function motionPolicy(reduced: boolean): Motion {
  if (reduced) return { snap: true, shimmer: () => ({ alpha: STATIC_FLASH_ALPHA, scale: 1 }) };
  return { snap: false, shimmer: (p) => ({ alpha: SHIMMER_PEAK * Math.sin(Math.PI * p), scale: 1 + SHIMMER_GROWTH * p }) };
}

const QUERY = "(prefers-reduced-motion: reduce)";

/** Calls `fn` with the current preference now and on every change; returns a stop function. */
export function watchReducedMotion(fn: (reduced: boolean) => void): () => void {
  const mql = typeof matchMedia === "function" ? matchMedia(QUERY) : null;
  if (!mql) {
    fn(false);
    return () => {};
  }
  const onChange = (e: { matches: boolean }): void => fn(e.matches);
  fn(mql.matches);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
