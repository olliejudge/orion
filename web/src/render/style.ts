import { VISION_FILE_ALPHA, colorForExt, hexToNumber, lighten, worktreeColor, type ExtColor } from "../colors";
import type { NodeVisual, Touch } from "../layout/encoding";
import type { WorktreeId } from "../protocol";
import { RING_GAP_PX, RING_W_PX } from "./draw";

/**
 * What each file (or collapsed folder) looks like, as plain data: the spec §6
 * worktree-encoding table turned into fills, glows and rings. MapRenderer only
 * turns a Look into Pixi objects, so every row of the table is unit-tested
 * here without WebGL.
 */

export type Theme = "vision" | "night";

export const NIGHT_IDLE = 0x3a3a44;
export const ISOLATE_DIM = 0.15;
/** A committed-on-branch ring hugs its sphere: at fit zoom most files are a few px wide, and a ring 2.5 px out would read as a hollow circle. */
export const TINT_RING_GAP_PX = 0.5; // with TINT_RING_W_PX the ring's inner edge touches the rim
export const TINT_RING_W_PX = 1;
const HALO_ALPHA = { vision: 0.6, night: 0.5 };
const DELETED_ALPHA = 0.45;
const GHOST_FILL = 0.15;
const AGG_TINT_FILL = { vision: 0.55, night: 0.45 };

export type Body =
  | { kind: "ext"; color: ExtColor; alpha: number } // Vision: file-type sphere
  | { kind: "worktree"; color: string; alpha: number } // Vision: sphere tinted in a worktree colour
  | { kind: "flat"; tint: number; alpha: number }; // Night: flat disc

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

export interface FileLook {
  /** The solid body; null for ghosts and deletions, which have none. */
  body: Body | null;
  /** Glow in the colour of live (uncommitted) work. */
  halo: { color: number; alpha: number } | null;
  /** Ghost: a faint worktree-coloured fill with a dashed outline. Deleted: a faint solid outline. */
  outline: { color: number; alpha: number; dashed: boolean; fill: number; fillAlpha: number } | null;
  rings: Rings;
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

function wt(t: Touch): number {
  return hexToNumber(worktreeColor(t.colorIndex));
}

function halo(vis: NodeVisual, theme: Theme, isolated: WorktreeId | null): FileLook["halo"] {
  const live = vis.touches.filter((t) => t.stage === "uncommitted" && t.kind !== "deleted");
  const glow = live.find((t) => touchAlpha(t, isolated) === 1) ?? live[0];
  return glow ? { color: wt(glow), alpha: HALO_ALPHA[theme] * touchAlpha(glow, isolated) } : null;
}

function rings(vis: NodeVisual, touches: Touch[], isolated: WorktreeId | null): Rings {
  return {
    gap: vis.tinted ? TINT_RING_GAP_PX : RING_GAP_PX,
    width: vis.tinted ? TINT_RING_W_PX : RING_W_PX,
    arcs: touches.map((t) => ({
      worktree: t.worktree,
      color: hexToNumber(lighten(worktreeColor(t.colorIndex), 0.25)),
      alpha: touchAlpha(t, isolated),
      dashed: t.stage === "uncommitted",
    })),
  };
}

export function fileLook(vis: NodeVisual, theme: Theme, isolated: WorktreeId | null): FileLook {
  const lead = vis.touches[0];
  if (vis.deleted && lead) {
    // Deleted (either stage): a faint outline until the deletion reaches base.
    return {
      body: null,
      halo: null,
      outline: { color: wt(lead), alpha: DELETED_ALPHA * touchAlpha(lead, isolated), dashed: false, fill: 0xffffff, fillAlpha: 0.02 },
      rings: rings(vis, [], isolated),
    };
  }
  if (vis.ghost && lead) {
    // Uncommitted added: ~15% worktree-coloured fill and a dashed outline;
    // any other worktree touching the path still gets its ring arc.
    const g = vis.touches.find((t) => t.stage === "uncommitted" && t.kind === "added") ?? lead;
    const a = touchAlpha(g, isolated);
    return {
      body: null,
      halo: null,
      outline: { color: wt(g), alpha: a, dashed: true, fill: wt(g), fillAlpha: theme === "vision" ? GHOST_FILL * a : 0 },
      rings: rings(
        vis,
        vis.touches.filter((t) => t.worktree !== g.worktree),
        isolated,
      ),
    };
  }
  // The touch that colours the body: the isolated worktree's, else the first.
  const visible = vis.touches.find((t) => touchAlpha(t, isolated) === 1);
  let body: Body;
  if (theme === "night") {
    body = { kind: "flat", tint: visible ? wt(visible) : NIGHT_IDLE, alpha: visible?.stage === "committed" ? 0.85 : 1 };
  } else if (vis.tinted && visible) {
    // Committed on branch: a solid sphere in the worktree colour.
    body = { kind: "worktree", color: worktreeColor(visible.colorIndex), alpha: 1 };
  } else {
    body = { kind: "ext", color: colorForExt(vis.ext), alpha: VISION_FILE_ALPHA };
  }
  return { body, halo: halo(vis, theme, isolated), outline: null, rings: rings(vis, vis.touches, isolated) };
}

/** Colour of the file count on a collapsed folder's disc (CSS colour, for canvas and SVG text). */
export function countColor(theme: Theme): string {
  return theme === "night" ? "rgba(235,235,245,0.5)" : "rgba(235,235,245,0.62)";
}

/** A collapsed folder: a faint disc carrying its descendants' touches; tinted solid when all of them are committed. */
export function aggregateLook(vis: NodeVisual, theme: Theme, isolated: WorktreeId | null): AggregateLook {
  const visible = vis.touches.find((t) => touchAlpha(t, isolated) === 1);
  const fill =
    vis.tinted && visible
      ? { color: wt(visible), alpha: AGG_TINT_FILL[theme] }
      : { color: 0xffffff, alpha: theme === "night" ? 0.05 : 0.07 };
  return {
    fill,
    outline: { color: 0xffffff, alpha: 0.14 },
    halo: halo(vis, theme, isolated),
    rings: rings(vis, vis.touches, isolated),
  };
}
