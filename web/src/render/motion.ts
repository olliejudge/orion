/**
 * Motion policy for the canvas. With `prefers-reduced-motion: reduce`,
 * springs (nodes and camera) jump straight to their targets, and a merge is
 * marked by a brief static highlight instead of the growing shimmer pulse.
 * Live work's glow breathes, and a fresh touch sends out a ping; with reduced
 * motion the glow holds still and there is no ping. CSS animations are
 * already switched off by theme.css under the same media query.
 */

export const STATIC_FLASH_ALPHA = 0.3;
const SHIMMER_PEAK = 0.55;
const SHIMMER_GROWTH = 0.25;
/** One breath of a live glow, ms: slow enough to read as calm activity. */
export const BREATH_MS = 2400;
const BREATH_DIP = 0.45; // the glow's alpha dips to 1 - BREATH_DIP
const BREATH_SWELL = 0.1; // and swells this much past its size
const PING_PEAK = 0.8;
const PING_REACH = 1.6; // the ring travels out to 1 + PING_REACH times the bubble's radius

export interface Motion {
  /** Springs snap to their targets instead of animating. */
  snap: boolean;
  /** The merge flash at shimmer progress p (0..1): its alpha and scale relative to the bubble. */
  shimmer(p: number): { alpha: number; scale: number };
  /** Whether live glows breathe (so the canvas keeps drawing while any is on screen). */
  breathes: boolean;
  /** A live glow at time t (ms): its alpha and size factors. */
  breath(t: number): { alpha: number; scale: number };
  /** A fresh touch's ping at progress p (0..1), as a ring around the bubble; null draws none. */
  ping(p: number): { alpha: number; scale: number } | null;
}

const STILL = { alpha: 1, scale: 1 };

export function motionPolicy(reduced: boolean): Motion {
  if (reduced) return { snap: true, shimmer: () => ({ alpha: STATIC_FLASH_ALPHA, scale: 1 }), breathes: false, breath: () => STILL, ping: () => null };
  return {
    snap: false,
    shimmer: (p) => ({ alpha: SHIMMER_PEAK * Math.sin(Math.PI * p), scale: 1 + SHIMMER_GROWTH * p }),
    breathes: true,
    breath: (t) => {
      const s = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / BREATH_MS); // 0 → 1 → 0 each breath
      return { alpha: 1 - BREATH_DIP * (1 - s), scale: 1 + BREATH_SWELL * s };
    },
    ping: (p) => {
      const e = 1 - (1 - p) ** 3; // fast out, slow settle
      return { alpha: PING_PEAK * (1 - p) ** 1.5, scale: 1 + PING_REACH * e };
    },
  };
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
