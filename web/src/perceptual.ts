// Small perceptual colour helpers (sRGB → CIELAB, D65) used to keep the
// file-type palette clearly apart from the worktree colours. Pure, no deps.

export type Lab = [L: number, a: number, b: number];

function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function f(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

/** "#rrggbb" → CIELAB (D65 white). */
export function hexToLab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16);
  const r = linear((n >> 16) & 255);
  const g = linear((n >> 8) & 255);
  const b = linear(n & 255);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const fy = f(y);
  return [116 * fy - 16, 500 * (f(x) - fy), 200 * (fy - f(z))];
}

/** CIE76 colour difference: Euclidean distance in Lab. */
export function deltaE(a: string, b: string): number {
  const [L1, a1, b1] = hexToLab(a);
  const [L2, a2, b2] = hexToLab(b);
  return Math.hypot(L1 - L2, a1 - a2, b1 - b2);
}

/** CIELAB chroma C*ab: 0 for greys, ~70–90 for Apple's system colours. */
export function chroma(hex: string): number {
  const [, a, b] = hexToLab(hex);
  return Math.hypot(a, b);
}
