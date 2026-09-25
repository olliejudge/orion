import { hexToNumber, lighten, worktreeColor } from "../colors";
import { isLive, isNew, type NodeVisual, type Touch } from "../layout/encoding";
import { contrast, over } from "../perceptual";
import type { WorktreeId } from "../protocol";
import { RING_GAP_PX, RING_W_PX } from "./draw";

/**
 * What each file (or collapsed folder) looks like, as plain data: the spec §6
 * encoding table turned into fills, marks and rings. MapRenderer only turns a
 * Look into Pixi objects, so every row of the table is unit-tested here
 * without WebGL.
 *
 * Who / what / when:
 * - WHO is colour: a changed file is filled flat in its worktree's colour.
 * - WHAT is a mark: "+" for new, "×" on a hollow rim for deleted, a hugging
 *   ring for committed on a branch, a glow for live (uncommitted) work, and
 *   nothing extra for a plain edit. Unchanged files are quiet neutral discs.
 * - WHEN is brightness: every bubble fades with the time since it was last
 *   touched (see recency), changed files always staying brighter than
 *   unchanged ones.
 */

export type Theme = "vision" | "night";

export const ISOLATE_DIM = 0.15;
/** A committed-on-branch ring hugs its bubble: at fit zoom most files are a few px wide, and a ring 2.5 px out would read as a hollow circle. */
export const TINT_RING_GAP_PX = 1;
export const TINT_RING_W_PX = 1;
/** Rim of a deleted (hollow) file, on screen. */
export const DELETED_RIM_W_PX = 1.25;

// ---- when: age → brightness ---------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Recency (1 = just touched, 0 = old) at each age, interpolated on log(age)
 * between stops. Agent-driven repos mostly live between hours and weeks, so
 * the curve spends its range there: full for the last hour, then a fifth
 * down at a day, a week, a month and half a year, and the floor at a year.
 */
export const AGE_STOPS: readonly (readonly [ageMs: number, recency: number])[] = [
  [HOUR, 1],
  [DAY, 0.8],
  [WEEK, 0.6],
  [30 * DAY, 0.4],
  [180 * DAY, 0.2],
  [365 * DAY, 0],
];

/** 1 for anything touched in the last hour (or in the future: clock skew), down to 0 at a year or more; Infinity (unknown) is 0. */
export function recency(ageMs: number): number {
  if (Number.isNaN(ageMs)) return 0;
  if (ageMs <= AGE_STOPS[0]![0]) return 1;
  for (let i = 1; i < AGE_STOPS.length; i++) {
    const [a1, r1] = AGE_STOPS[i]!;
    if (ageMs > a1) continue;
    const [a0, r0] = AGE_STOPS[i - 1]!;
    return r0 + ((r1 - r0) * Math.log(ageMs / a0)) / Math.log(a1 / a0);
  }
  return 0;
}

/**
 * How long ago a visual was last touched, ms: its newest touch or base
 * commit. A touch with an unknown time counts as just now (live work the
 * server has not timed yet); an unchanged file with no known time is
 * infinitely old, so it takes the faintest tone.
 */
export function ageOf(vis: NodeVisual, now: number): number {
  let latest = vis.touched ?? -Infinity;
  for (const t of vis.touches) latest = Math.max(latest, t.touched ?? now);
  return latest === -Infinity ? Infinity : Math.max(0, now - latest);
}

/** A theme's tones. Alpha ranges are [oldest, just touched]. */
export interface Tone {
  /** The map's background (darkest stop of Vision's gradient; Night's black): glyph ink is chosen against it. */
  bg: string;
  /** Unchanged files: a neutral that warms slightly from [oldest] to [just touched], and brightens a lot. */
  idle: readonly [number, number];
  idleAlpha: readonly [number, number];
  /** Changed files' fill (and their marks): well above idleAlpha at the same age. */
  changedAlpha: readonly [number, number];
  halo: number;
  /** A collapsed folder's disc: neutral when nothing below it is changed, else its worktree's colour. */
  aggIdleAlpha: readonly [number, number];
  aggChangedAlpha: readonly [number, number];
}

export const TONES: Readonly<Record<Theme, Tone>> = {
  vision: {
    bg: "#0c0c14",
    idle: [0xa8adc6, 0xe0dcd2],
    idleAlpha: [0.11, 0.78],
    changedAlpha: [0.62, 1],
    halo: 0.55,
    aggIdleAlpha: [0.05, 0.34],
    aggChangedAlpha: [0.3, 0.6],
  },
  night: {
    bg: "#000000",
    idle: [0x9ea1b4, 0xd8d4ca],
    idleAlpha: [0.12, 0.76],
    changedAlpha: [0.6, 1],
    halo: 0.45,
    aggIdleAlpha: [0.05, 0.3],
    aggChangedAlpha: [0.25, 0.5],
  },
};

function at(range: readonly [number, number], r: number): number {
  return range[0] + (range[1] - range[0]) * r;
}

/** Channel-wise mix of two 0xrrggbb colours, `r` of the way from `range[0]` to `range[1]`. */
function mixColor(range: readonly [number, number], r: number): number {
  const [a, b] = range;
  let out = 0;
  for (const shift of [16, 8, 0]) out |= Math.round(at([(a >> shift) & 255, (b >> shift) & 255], r)) << shift;
  return out;
}

/** The unchanged-file disc colour at recency `r` (0..1). */
export function idleTint(theme: Theme, r: number): number {
  return mixColor(TONES[theme].idle, r);
}

// ---- what: marks -----------------------------------------------------------

export type GlyphShape = "plus" | "cross";

/** Glyphs show from this on-screen radius up; below it the fill alone carries the state. */
export const GLYPH_MIN_R_PX = 5;
/** Past this radius a glyph stops growing (an icon in the middle of a big bubble). */
export const GLYPH_MAX_R_PX = 24;
/** Glyph geometry as fractions of its half-size: arm length (centre to tip) and stroke width. */
export const GLYPH_ARM = 0.52;
export const GLYPH_STROKE = 0.24;

/** A glyph's half-size for a bubble of on-screen radius R, or null when it is too small to show one. */
export function glyphSize(R: number): number | null {
  return R >= GLYPH_MIN_R_PX ? Math.min(R, GLYPH_MAX_R_PX) : null;
}

const INKS = ["#ffffff", "#0b0b12"] as const;
const inkCache = new Map<string, number>();

/**
 * Ink for a glyph on a fill of `hex`: white or near-black, whichever keeps
 * the better worst-case contrast across the fill's whole age range (the fill
 * fades towards the background; the glyph does not).
 */
export function glyphInk(hex: string, theme: Theme): number {
  const key = `${hex}|${theme}`;
  let ink = inkCache.get(key);
  if (ink === undefined) {
    const tone = TONES[theme];
    const worst = (c: string): number => Math.min(...tone.changedAlpha.map((a) => contrast(c, over(hex, a, tone.bg))));
    ink = hexToNumber(worst(INKS[0]) >= worst(INKS[1]) ? INKS[0] : INKS[1]);
    inkCache.set(key, ink);
  }
  return ink;
}

// ---- looks -------------------------------------------------------------------

export interface RingArc {
  worktree: WorktreeId;
  color: number;
  alpha: number;
  dashed: boolean; // dashed = uncommitted, solid = committed
}

export interface Rings {
  gap: number; // on-screen px from the bubble's rim to the ring's centre line
  width: number;
  arcs: RingArc[]; // one arc per worktree (a split ring when several)
}

export interface Glyph {
  shape: GlyphShape;
  color: number;
  alpha: number;
}

export interface FileLook {
  /** A flat disc; null for a deletion, which is hollow. */
  body: { tint: number; alpha: number } | null;
  /** Glow in the colour of live (uncommitted) work. */
  halo: { color: number; alpha: number } | null;
  /** A deletion's rim (DELETED_RIM_W_PX wide). */
  outline: { color: number; alpha: number } | null;
  /** The state mark in the middle; drawn only when glyphSize() allows. */
  glyph: Glyph | null;
  rings: Rings;
  /** Recency alpha for the outline and rings as a group (the renderer sets it on their Graphics, so ageing never redraws them). */
  marks: number;
}

export interface AggregateLook {
  fill: { color: number; alpha: number };
  outline: { color: number; alpha: number };
  halo: FileLook["halo"];
  rings: Rings;
}

const touchSigs = new WeakMap<NodeVisual, string>();

/**
 * A string key for a visual's touches (who, which colour, what stage and kind),
 * part of the renderer's redraw key. Visuals are immutable once encoded, so it
 * is built once per visual rather than once per node per frame.
 */
export function touchSig(vis: NodeVisual): string {
  let sig = touchSigs.get(vis);
  if (sig === undefined) {
    sig = vis.touches.map((t) => `${t.worktree}:${t.colorIndex}:${t.stage}:${t.kind}`).join(",");
    touchSigs.set(vis, sig);
  }
  return sig;
}

/** Alpha for one worktree's marks: full, or dimmed while another worktree is isolated. */
export function touchAlpha(t: Touch, isolated: WorktreeId | null): number {
  return isolated === null || t.worktree === isolated ? 1 : ISOLATE_DIM;
}

const committedChange = (t: Touch): boolean => t.stage === "committed" && t.kind !== "deleted";

/** The touch that gives a changed visual its colour: one behind its state, the isolated worktree's if it has one. */
function leadTouch(vis: NodeVisual, isolated: WorktreeId | null): Touch | undefined {
  const fits = vis.state === "added" ? isNew : vis.state === "edited" ? isLive : vis.state === "committed" ? committedChange : () => true;
  const cands = vis.touches.filter(fits);
  return cands.find((t) => touchAlpha(t, isolated) === 1) ?? cands[0] ?? vis.touches[0];
}

function ringColor(t: Touch): number {
  return hexToNumber(lighten(worktreeColor(t.colorIndex), 0.25));
}

function halo(vis: NodeVisual, theme: Theme, isolated: WorktreeId | null, fade: number): FileLook["halo"] {
  const live = vis.touches.filter(isLive);
  const glow = live.find((t) => touchAlpha(t, isolated) === 1) ?? live[0];
  return glow ? { color: hexToNumber(worktreeColor(glow.colorIndex)), alpha: TONES[theme].halo * touchAlpha(glow, isolated) * fade } : null;
}

function arcs(touches: Touch[], isolated: WorktreeId | null): RingArc[] {
  return touches.map((t) => ({ worktree: t.worktree, color: ringColor(t), alpha: touchAlpha(t, isolated), dashed: t.stage === "uncommitted" }));
}

/** Two or more worktrees: a split ring, one arc each. One worktree: a hugging solid ring once committed, else none. */
function fileRings(vis: NodeVisual, isolated: WorktreeId | null): Rings {
  if (vis.touches.length > 1) return { gap: RING_GAP_PX, width: RING_W_PX, arcs: arcs(vis.touches, isolated) };
  if (vis.state === "committed") return { gap: TINT_RING_GAP_PX, width: TINT_RING_W_PX, arcs: arcs(vis.touches, isolated) };
  return { gap: RING_GAP_PX, width: RING_W_PX, arcs: [] };
}

/** How a file looks at time `now` (unix ms). */
export function fileLook(vis: NodeVisual, theme: Theme, isolated: WorktreeId | null, now: number): FileLook {
  const tone = TONES[theme];
  const r = recency(ageOf(vis, now));
  const lead = leadTouch(vis, isolated);
  if (vis.state === "unchanged" || !lead) {
    return { body: { tint: idleTint(theme, r), alpha: at(tone.idleAlpha, r) }, halo: null, outline: null, glyph: null, rings: fileRings(vis, isolated), marks: 1 };
  }
  const fade = at(tone.changedAlpha, r);
  const a = touchAlpha(lead, isolated);
  if (vis.state === "deleted") {
    // Hollow: a rim and a cross in the worktree's (ring) colour until the deletion reaches base.
    const color = ringColor(lead);
    return { body: null, halo: null, outline: { color, alpha: a }, glyph: { shape: "cross", color, alpha: a }, rings: fileRings(vis, isolated), marks: fade };
  }
  const hex = worktreeColor(lead.colorIndex);
  return {
    body: { tint: hexToNumber(hex), alpha: fade * a },
    halo: halo(vis, theme, isolated, fade),
    outline: null,
    glyph: vis.state === "added" ? { shape: "plus", color: glyphInk(hex, theme), alpha: a } : null,
    rings: fileRings(vis, isolated),
    marks: fade,
  };
}

/** Colour of the file count on a collapsed folder's disc (CSS colour, for canvas and SVG text). */
export function countColor(theme: Theme): string {
  return theme === "night" ? "rgba(235,235,245,0.5)" : "rgba(235,235,245,0.62)";
}

/**
 * A collapsed folder at time `now`: a disc in the colour of the worktree
 * changing something below it (neutral when nothing is), as bright as the
 * most recent touch below it, with one ring arc per worktree (dashed while
 * any of its changes are uncommitted) and the glow of live work.
 */
export function aggregateLook(vis: NodeVisual, theme: Theme, isolated: WorktreeId | null, now: number): AggregateLook {
  const tone = TONES[theme];
  const r = recency(ageOf(vis, now));
  const lead = vis.state === "unchanged" ? undefined : leadTouch(vis, isolated);
  const fill = lead
    ? { color: hexToNumber(worktreeColor(lead.colorIndex)), alpha: at(tone.aggChangedAlpha, r) * touchAlpha(lead, isolated) }
    : { color: 0xffffff, alpha: at(tone.aggIdleAlpha, r) };
  const committed = vis.state === "committed";
  return {
    fill,
    outline: { color: 0xffffff, alpha: 0.14 },
    halo: halo(vis, theme, isolated, 1),
    rings: { gap: committed ? TINT_RING_GAP_PX : RING_GAP_PX, width: committed ? TINT_RING_W_PX : RING_W_PX, arcs: arcs(vis.touches, isolated) },
  };
}
