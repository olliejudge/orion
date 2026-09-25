// Worktree palette: Apple system colours (dark mode). Index 0 = main worktree.
export const WORKTREE_COLORS: readonly string[] = [
  "#0a84ff", // blue
  "#ff9f0a", // orange
  "#30d158", // green
  "#ff375f", // pink
  "#bf5af2", // purple
  "#40c8e0", // teal
  "#ffd60a", // yellow
  "#5e5ce6", // indigo
  "#ff453a", // red
  "#63e6e2", // mint
];

const UNASSIGNED = "#8e8e93";

/** Colour for a worktree colour index; reused modulo 10; -1 (not yet active) is grey. */
export function worktreeColor(index: number): string {
  if (index < 0) return UNASSIGNED;
  return WORKTREE_COLORS[index % WORKTREE_COLORS.length] ?? UNASSIGNED;
}

/** Mix `hex` towards white by `amount` (0..1). */
export function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number): number => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** "#rrggbb" → 0xrrggbb for Pixi tints. */
export function hexToNumber(hex: string): number {
  return parseInt(hex.slice(1), 16);
}
