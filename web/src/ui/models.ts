// View models for the chrome. Pure functions of RepoState so they are unit-tested
// without rendering, and the Svelte components stay thin.
import { worktreeColor } from "../colors";
import { encode, encodeAll } from "../layout/encoding";
import { freeArea, type Insets } from "../layout/frame";
import type { Circle } from "../layout/pack";
import type { Activity, WorktreeId } from "../protocol";
import { parentDir } from "../render/geometry";
import type { RepoState } from "../store";
import { humanSize, splitPath } from "./format";
import type { Theme } from "./theme";

/** A worktree counts as active with changes, or with activity in the last 10 minutes. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;
const COALESCE_MS = 5000;

export interface LegendItem {
  id: WorktreeId;
  label: string;
  color: string;
  changed: number;
  isMain: boolean;
  path: string;
}

export function legendModel(state: RepoState, now: number): { active: LegendItem[]; idle: LegendItem[] } {
  const recent = new Set<WorktreeId>();
  for (const a of state.activity) if (now - a.ts <= ACTIVE_WINDOW_MS) recent.add(a.worktree);
  const active: LegendItem[] = [];
  const idle: LegendItem[] = [];
  for (const w of state.worktrees.values()) {
    const changed = state.overlays.get(w.id)?.size ?? 0;
    const item: LegendItem = { id: w.id, label: w.label, color: worktreeColor(w.colorIndex), changed, isMain: w.isMain, path: w.path };
    if (changed > 0 || recent.has(w.id)) active.push(item);
    else idle.push(item);
  }
  const order = (a: LegendItem, b: LegendItem): number =>
    Number(b.isMain) - Number(a.isMain) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  // Unassigned colours (-1) sort after every assigned one, so main stays first.
  const rank = (id: WorktreeId): number => {
    const i = state.worktrees.get(id)?.colorIndex ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const colorOrder = (a: LegendItem, b: LegendItem): number => rank(a.id) - rank(b.id) || order(a, b);
  active.sort(colorOrder);
  idle.sort(order);
  return { active, idle };
}

export interface ActivityRow {
  key: string;
  worktree: WorktreeId;
  kind: Activity["kind"];
  ts: number; // newest item in the row
  count: number; // coalesced items
  path?: string;
  from?: string;
  subject?: string;
  files?: number;
  emphasis: boolean;
}

/**
 * Newest-first rows. Consecutive edits of the same path by the same worktree
 * with the same kind, each ≤5 s after the previous, collapse into one row
 * (the server already coalesces modifications; this also absorbs bursts of
 * added/deleted events and duplicate deliveries).
 *
 * A row's key comes from its OLDEST item, not its position: the store trims
 * the buffer from the front, and new items join the newest row, so the key
 * survives both and Svelte keeps the row's DOM (focus, hover) across patches.
 */
export function activityRows(activity: Activity[], limit = 80): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const oldest: Activity[] = [];
  for (let i = activity.length - 1; i >= 0 && rows.length <= limit; i--) {
    const a = activity[i]!;
    const prev = rows[rows.length - 1];
    const fileKind = a.kind !== "commit" && a.kind !== "merge";
    if (prev && fileKind && prev.kind === a.kind && prev.worktree === a.worktree && prev.path === a.path && oldest[oldest.length - 1]!.ts - a.ts <= COALESCE_MS) {
      prev.count++;
      oldest[oldest.length - 1] = a;
      continue;
    }
    const row: ActivityRow = { key: "", worktree: a.worktree, kind: a.kind, ts: a.ts, count: 1, emphasis: !fileKind };
    if (a.path !== undefined) row.path = a.path;
    if (a.from !== undefined) row.from = a.from;
    if (a.subject !== undefined) row.subject = a.subject;
    if (a.files !== undefined) row.files = a.files;
    rows.push(row);
    oldest.push(a);
  }
  const out = rows.slice(0, limit);
  const seen = new Map<string, number>();
  out.forEach((row, i) => {
    const o = oldest[i]!;
    const base = `${o.ts}:${o.worktree}:${o.kind}:${o.path ?? o.sha ?? ""}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    row.key = n === 0 ? base : `${base}#${n}`;
  });
  return out;
}

/** Night mode: rows fade linearly over ACTIVE_WINDOW_MS, floor 0.15. */
export function rowFade(ts: number, now: number): number {
  const age = Math.max(0, now - ts) / ACTIVE_WINDOW_MS;
  return 0.15 + 0.85 * (1 - Math.min(1, age));
}

export interface TooltipInfo {
  dir: string;
  name: string;
  detail: string;
  touches: { color: string; label: string; text: string }[];
}

const VERB: Record<string, string> = { added: "New", modified: "Edited", deleted: "Deleted", renamed: "Moved" };

/** Hover card for files and collapsed folders; null for plain folders (their names are on the map). */
export function tooltipInfo(state: RepoState, c: Circle): TooltipInfo | null {
  if (c.isDir && c.aggregate === undefined) return null;
  const visual = c.isDir ? encodeAll(state, new Map([[c.path, c]])).get(c.path)! : encode(state, c.path);
  const touches = visual.touches.map((t) => {
    const w = state.worktrees.get(t.worktree);
    const entry = state.overlays.get(t.worktree)?.get(c.path);
    let verb = VERB[t.kind] ?? t.kind;
    if (c.isDir) verb = "Changes";
    else if (t.kind === "renamed" && entry?.from) verb = `Moved from ${entry.from}`;
    else if (!entry && t.kind === "deleted") verb = "Moved away";
    const stage = t.stage === "committed" ? "committed on branch" : "uncommitted";
    return { color: worktreeColor(t.colorIndex), label: w?.label ?? t.worktree, text: `${verb}, ${stage}` };
  });
  if (c.isDir) {
    const n = c.aggregate ?? 0;
    return { dir: splitPath(c.path).dir, name: `${splitPath(c.path).name}/`, detail: `${n} ${n === 1 ? "file" : "files"}`, touches };
  }
  let size = state.tree.get(c.path) ?? 0;
  for (const m of state.overlays.values()) {
    const e = m.get(c.path);
    if (e && e.kind !== "deleted") size = Math.max(size, e.size);
  }
  const { dir, name } = splitPath(c.path);
  return { dir, name, detail: humanSize(size), touches };
}

/**
 * Where "zoom to this file" goes: the file's folder, or its nearest ancestor
 * that is on the map (the folder may be collapsed or gone), else the root "".
 */
export function shownFolder(path: string, layout: Map<string, Circle>): string {
  for (let dir = parentDir(path); dir !== ""; dir = parentDir(dir)) {
    if (layout.get(dir)?.isDir) return dir;
  }
  return "";
}

// Mirrors the chrome's CSS (theme.css --gutter, Activity.svelte sizes).
const MAP_PAD = 48; // keeps the repo circle clear of the legend and live pill
const GUTTER = 16;
const ACTIVITY_W = 288;
const NARROW_W = 720; // Activity.svelte's max-width breakpoint
const SHEET_BOTTOM = 64;
const SHEET_VH = 0.32;

const LEGEND_CLEAR = 8; // min gap between the root circle and the legend panel

/** On-screen size of the legend panel (top-left, at the gutter), CSS px. */
export interface Footprint {
  width: number;
  height: number;
}

/**
 * Where the map may sit. Vision's activity panel is opaque-ish glass, so the
 * map centres in the space beside it (or above it, where it becomes a bottom
 * sheet on narrow screens). Night's stream floats over the map: full-bleed.
 *
 * On wide Vision layouts the legend's footprint counts too: if the root
 * circle would pass under the legend, the map moves right of it or below it,
 * whichever leaves the larger circle.
 */
export function mapInsets(theme: Theme, width: number, height: number, legend?: Footprint): Insets {
  const pad: Insets = { top: MAP_PAD, right: MAP_PAD, bottom: MAP_PAD, left: MAP_PAD };
  if (theme === "night") return pad;
  if (width <= NARROW_W) return { ...pad, bottom: SHEET_BOTTOM + height * SHEET_VH + GUTTER };
  const wide: Insets = { ...pad, right: ACTIVITY_W + 2 * GUTTER };
  if (!legend || legend.width <= 0 || legend.height <= 0) return wide;
  const right = GUTTER + legend.width; // the legend's far corner
  const bottom = GUTTER + legend.height;
  const circle = (insets: Insets): { cx: number; cy: number; r: number } => {
    const f = freeArea(width, height, insets);
    return { cx: (f.x0 + f.x1) / 2, cy: (f.y0 + f.y1) / 2, r: Math.min(f.x1 - f.x0, f.y1 - f.y0) / 2 };
  };
  const c = circle(wide);
  const dx = Math.max(0, c.cx - right);
  const dy = Math.max(0, c.cy - bottom);
  if (Math.hypot(dx, dy) >= c.r + LEGEND_CLEAR) return wide;
  const beside: Insets = { ...wide, left: Math.max(wide.left, right + GUTTER) };
  const below: Insets = { ...wide, top: Math.max(wide.top, bottom + GUTTER) };
  return circle(below).r > circle(beside).r ? below : beside;
}

const TIP_OFFSET = 14;
const TIP_MARGIN = 8;

/**
 * Tooltip placement for a card of w×h at pointer (x, y): below-right, flipped
 * to the other side when it would overflow, then clamped into the viewport.
 */
export function tooltipPosition(x: number, y: number, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  const place = (p: number, size: number, view: number): number => {
    let v = p + TIP_OFFSET;
    if (v + size > view - TIP_MARGIN) v = p - TIP_OFFSET - size;
    return Math.max(TIP_MARGIN, Math.min(v, view - size - TIP_MARGIN));
  };
  return { left: place(x, w, vw), top: place(y, h, vh) };
}
