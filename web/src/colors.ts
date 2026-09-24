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

export interface ExtColor {
  base: string; // outer (darker) gradient stop
  light: string; // highlight stop at 35%/30%
}

// Curated file-type groups. Purple, blue and yellow are the exact stops from
// the approved Vision mockup; the rest are tuned to sit beside them.
export const EXT_GROUPS = {
  web: { light: "#8cc4ff", base: "#2f6fe6" },
  systems: { light: "#b5a6ff", base: "#6a4fe0" },
  scripting: { light: "#8fe3d9", base: "#1f9e93" },
  docs: { light: "#ffe08a", base: "#e8a820" },
  styles: { light: "#ffb3c7", base: "#d9507a" },
  config: { light: "#c9ccd8", base: "#737891" },
  media: { light: "#a9eeb4", base: "#35a353" },
  other: { light: "#a4a4b0", base: "#5c5c68" },
} as const satisfies Record<string, ExtColor>;

type Group = keyof typeof EXT_GROUPS;

const BY_EXT: Record<string, Group> = {};
function add(group: Group, exts: string): void {
  for (const e of exts.split(" ")) BY_EXT[e] = group;
}
add("web", "ts tsx js jsx mjs cjs mts cts svelte vue astro html htm");
add("systems", "go rs c h cc cpp hpp cxx swift m mm java kt kts scala zig cs fs");
add("scripting", "py rb ex exs erl hrl php lua sh bash zsh fish pl r jl clj dart");
add("docs", "md mdx txt rst adoc org tex license");
add("styles", "css scss sass less styl pcss");
add("config", "json jsonc yaml yml toml xml ini cfg conf env lock sum mod sql graphql proto makefile dockerfile gitignore .gitignore .gitattributes .editorconfig .npmrc");
add("media", "png jpg jpeg gif webp svg ico bmp avif mp4 mov webm mp3 wav ogg woff woff2 ttf otf eot pdf");

/** Lower-cased extension of the base name; the whole base name if it has none (or is a dotfile). */
export function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : name;
}

export function colorForExt(ext: string): { base: string; light: string } {
  return EXT_GROUPS[BY_EXT[ext.toLowerCase()] ?? "other"];
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
