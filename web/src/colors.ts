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

/** File-type chroma is at most this fraction of the least saturated worktree colour's. */
export const FILE_CHROMA_RATIO = 0.6;
/** Minimum CIE76 ΔE between any file-type stop and any worktree colour. */
export const MIN_FILE_WORKTREE_DELTA_E = 20;

// Curated file-type groups for Vision: muted, cool "frosted" tones (CIELAB
// chroma ≈ 2–20, highlight L ≈ 60–74, shadow L ≈ 30–42) so structure reads
// while worktree activity, drawn in the saturated Apple system colours above,
// stays the most salient thing on the map. colors.test.ts pins the chroma and
// ΔE separation from every worktree colour. Media and "other" are the
// dimmest, so unchanged images and vendored blobs never outshine changes.
export const EXT_GROUPS = {
  web: { light: "#98b4cc", base: "#3d627d" }, // slate blue
  systems: { light: "#aba8c5", base: "#585677" }, // lavender grey
  scripting: { light: "#92b8b2", base: "#3c6660" }, // sage
  docs: { light: "#c6b39b", base: "#726046" }, // sand
  styles: { light: "#c8a2a7", base: "#764f55" }, // dusty rose
  config: { light: "#b0b7bd", base: "#575f66" }, // cool grey
  media: { light: "#8e9989", base: "#434f3e" }, // moss
  other: { light: "#8f9194", base: "#44474b" }, // graphite
} as const satisfies Record<string, ExtColor>;

/** File-type spheres are slightly translucent in Vision ("frosted"); worktree tints stay opaque. */
export const VISION_FILE_ALPHA = 0.85;

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
