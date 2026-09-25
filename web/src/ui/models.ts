// View models for the chrome. Pure functions of RepoState so they are unit-tested
// without rendering, and the Svelte components stay thin.
import { worktreeColor } from "../colors";
import { encode } from "../layout/encoding";
import { isExcluded } from "../layout/exclude";
import { freeArea, type Insets } from "../layout/frame";
import type { Circle } from "../layout/pack";
import type { Activity, WorktreeId } from "../protocol";
import { parentDir } from "../render/geometry";
import type { RepoState } from "../store";
import { folderStats } from "./folderStats";
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

export function legendModel(state: RepoState, now: number, excluded?: ReadonlySet<string>): { active: LegendItem[]; idle: LegendItem[] } {
  const recent = new Set<WorktreeId>();
  for (const a of state.activity) {
    if (now - a.ts > ACTIVE_WINDOW_MS) continue;
    if (excluded && a.path !== undefined && isExcluded(a.path, excluded)) continue;
    recent.add(a.worktree);
  }
  const active: LegendItem[] = [];
  const idle: LegendItem[] = [];
  for (const w of state.worktrees.values()) {
    let changed = 0;
    for (const path of state.overlays.get(w.id)?.keys() ?? []) if (!excluded || !isExcluded(path, excluded)) changed++;
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
export function activityRows(activity: Activity[], limit = 80, excluded?: ReadonlySet<string>): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const oldest: Activity[] = [];
  for (let i = activity.length - 1; i >= 0 && rows.length <= limit; i--) {
    const a = activity[i]!;
    if (excluded && a.path !== undefined && isExcluded(a.path, excluded)) continue;
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

const stageText = (stage: string): string => (stage === "committed" ? "committed on branch" : "uncommitted");
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Hover card for files and folders (collapsed or not): most folders are too
 * small on screen for a name, so the card names them, with their file count
 * and each worktree's changed files below them (both leaving out `excluded`
 * folders, as the map does). Null for the repo root.
 */
export function tooltipInfo(state: RepoState, c: Circle, excluded?: ReadonlySet<string>): TooltipInfo | null {
  if (c.isDir) return c.depth === 0 ? null : folderInfo(state, c.path, excluded);
  const visual = encode(state, c.path);
  const touches = visual.touches.map((t) => {
    const w = state.worktrees.get(t.worktree);
    const entry = state.overlays.get(t.worktree)?.get(c.path);
    let verb = VERB[t.kind] ?? t.kind;
    if (t.kind === "renamed" && entry?.from) verb = `Moved from ${entry.from}`;
    else if (!entry && t.kind === "deleted") verb = "Moved away";
    return { color: worktreeColor(t.colorIndex), label: w?.label ?? t.worktree, text: `${verb}, ${stageText(t.stage)}` };
  });
  let size = state.tree.get(c.path) ?? 0;
  for (const m of state.overlays.values()) {
    const e = m.get(c.path);
    if (e && e.kind !== "deleted") size = Math.max(size, e.size);
  }
  const { dir, name } = splitPath(c.path);
  return { dir, name, detail: humanSize(size), touches };
}

function folderInfo(state: RepoState, path: string, excluded?: ReadonlySet<string>): TooltipInfo {
  const stats = folderStats(state, path, excluded);
  const rank = (id: WorktreeId): number => {
    const i = state.worktrees.get(id)?.colorIndex ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const ids = [...stats.changed.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const touches = ids.map((id) => {
    const w = state.worktrees.get(id);
    const { count, stage } = stats.changed.get(id)!;
    return { color: worktreeColor(w?.colorIndex ?? -1), label: w?.label ?? id, text: `${count} changed, ${stageText(stage)}` };
  });
  const { dir, name } = splitPath(path);
  return { dir, name: `${name}/`, detail: plural(stats.files, "file"), touches };
}

export interface HoverTarget {
  path: string;
  at: { x: number; y: number };
}

/**
 * The tooltip for what's under the pointer, recomputed from the latest state
 * and layout (a patch can change the file under a still pointer). Null when
 * nothing is hovered, the hovered path has left the map, or it is `current`
 * (the folder in view: its background is everywhere, and the breadcrumbs name it).
 */
export function hoverTip(
  state: RepoState | null,
  layout: Map<string, Circle>,
  hover: HoverTarget | null,
  current?: string,
  excluded?: ReadonlySet<string>,
): { info: TooltipInfo; x: number; y: number } | null {
  const c = hover === null || hover.path === current ? undefined : layout.get(hover.path);
  const info = c && state ? tooltipInfo(state, c, excluded) : null;
  return info && hover ? { info, x: hover.at.x, y: hover.at.y } : null;
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

const LEGEND_CLEAR = 8; // min gap between the root circle and a corner panel

/** On-screen size of a corner panel (the legend or the map key, at the gutter), CSS px. */
export interface Footprint {
  width: number;
  height: number;
}

const STACK_GAP = 8; // gap between two panels stacked in the same corner

/**
 * Two panels stacked in the same corner (e.g. the map key and the directory
 * filter, both bottom-left) as the one combined footprint `mapInsets` treats
 * as a single obstacle. An unmeasured panel (zero size) is ignored.
 */
export function stackFootprint(a: Footprint, b: Footprint, gap = STACK_GAP): Footprint {
  const hasA = a.width > 0 && a.height > 0;
  const hasB = b.width > 0 && b.height > 0;
  if (hasA && hasB) return { width: Math.max(a.width, b.width), height: a.height + gap + b.height };
  return hasA ? a : hasB ? b : { width: 0, height: 0 };
}

// DirFilter.svelte's own header (the "Folders" toggle button plus the open
// panel's "Show all" row and padding), which sits above its scrolling tree.
const DIRFILTER_CHROME = 84;

/**
 * How tall the open folder filter's scrolling tree may grow, CSS px, before
 * the panel — anchored at the gutter and lifted `liftBy` above it to stack
 * over the map key (see `stackFootprint`) — would overlap the legend above
 * it. Driven entirely by measured/viewport inputs, so it adapts to the
 * legend growing or shrinking (worktrees appearing), a window resize, and
 * the map key being open or collapsed (which changes `liftBy`).
 */
export function dirFilterTreeMaxHeight(viewportHeight: number, legend: Footprint, liftBy: number): number {
  const legendBottom = legend.width > 0 && legend.height > 0 ? GUTTER + legend.height + STACK_GAP : GUTTER;
  const panelBottom = viewportHeight - GUTTER - liftBy;
  return Math.max(0, panelBottom - legendBottom - DIRFILTER_CHROME);
}

/** A panel in a left corner: the legend at the top, the map key at the bottom. */
interface CornerPanel {
  edge: "top" | "bottom";
  box: Footprint;
}

/**
 * Where the map may sit. Vision's activity panel is opaque-ish glass, so the
 * map centres in the space beside it (or above it, where it becomes a bottom
 * sheet on narrow screens). Night's stream floats over the map: full-bleed.
 *
 * On wide Vision layouts the footprints of the legend (top-left) and the map
 * key (bottom-left) count too: if the root circle would pass under either,
 * the map moves right of that panel or away from its edge (below the legend,
 * above the key), whichever clears every panel with the largest circle.
 */
export function mapInsets(theme: Theme, width: number, height: number, legend?: Footprint, key?: Footprint): Insets {
  const pad: Insets = { top: MAP_PAD, right: MAP_PAD, bottom: MAP_PAD, left: MAP_PAD };
  if (theme === "night") return pad;
  if (width <= NARROW_W) return { ...pad, bottom: SHEET_BOTTOM + height * SHEET_VH + GUTTER };
  const wide: Insets = { ...pad, right: ACTIVITY_W + 2 * GUTTER };
  const measured = (b?: Footprint): b is Footprint => b !== undefined && b.width > 0 && b.height > 0;
  const panels: CornerPanel[] = [];
  if (measured(legend)) panels.push({ edge: "top", box: legend });
  if (measured(key)) panels.push({ edge: "bottom", box: key });

  const circle = (insets: Insets): { cx: number; cy: number; r: number } => {
    const f = freeArea(width, height, insets);
    return { cx: (f.x0 + f.x1) / 2, cy: (f.y0 + f.y1) / 2, r: Math.min(f.x1 - f.x0, f.y1 - f.y0) / 2 };
  };
  const clears = (insets: Insets): boolean => {
    const c = circle(insets);
    return panels.every(({ edge, box }) => {
      const dx = Math.max(0, c.cx - (GUTTER + box.width)); // from the panel's inner corner
      const dy = edge === "top" ? Math.max(0, c.cy - (GUTTER + box.height)) : Math.max(0, height - GUTTER - box.height - c.cy);
      return Math.hypot(dx, dy) >= c.r + LEGEND_CLEAR;
    });
  };
  if (clears(wide)) return wide;

  // Every way of stepping around each panel (or leaving it), fewest moves and
  // "beside" first, so ties keep the earlier (the map's usual) placement.
  type Option = { insets: Insets; movedAll: boolean };
  let options: Option[] = [{ insets: wide, movedAll: true }];
  for (const { edge, box } of panels) {
    const clear = GUTTER + box.height + GUTTER; // inset that keeps the map off the panel's edge
    options = options.flatMap(({ insets, movedAll }) => [
      { insets, movedAll: false },
      { insets: { ...insets, left: Math.max(insets.left, GUTTER + box.width + GUTTER) }, movedAll },
      { insets: { ...insets, [edge]: Math.max(insets[edge], clear) }, movedAll },
    ]);
  }
  // At small sizes even a moved map can still touch a panel; then the largest
  // circle that steps around every panel wins, as if each had cleared.
  const clearing = options.filter((o) => clears(o.insets));
  const pool = clearing.length > 0 ? clearing : options.filter((o) => o.movedAll);
  let best = pool[0]!;
  for (const o of pool) if (circle(o.insets).r > circle(best.insets).r) best = o;
  return best.insets;
}

const CRUMBS_MAX_W = 560; // Breadcrumbs.svelte's max-width
const CRUMBS_MIN_W = 200; // narrowest the pill gets beside the legend before it moves below it
const PANEL_GAP = 8; // min gap between the breadcrumbs and a panel

/** The breadcrumbs pill's width, CSS px: the whole trail, and with its middle collapsed to "…". */
export interface CrumbsSize {
  full: number;
  min: number;
}

/** Where the breadcrumbs pill goes: its centre x and top, and the width it may take (CSS px). */
export interface CrumbsSlot {
  x: number;
  top: number;
  maxWidth: number;
}

/**
 * The breadcrumbs sit at the top, centred over the map's free area
 * (`centerX`; null centres on the viewport), in the band between the legend
 * (top-left) and, on wide Vision layouts, the activity panel (top-right).
 * They slide sideways to stay in that band, and take at most its width (the
 * trail collapses to fit, then its longest labels ellipsize). Only when the
 * band is narrower than the collapsed trail and CRUMBS_MIN_W (a phone-width
 * window) do they drop below the legend instead.
 */
export function crumbsSlot(theme: Theme, width: number, legend: Footprint | undefined, centerX: number | null, size: CrumbsSize): CrumbsSlot {
  const cap = Math.max(0, Math.min(CRUMBS_MAX_W, width - 2 * GUTTER));
  const right = theme === "vision" && width > NARROW_W ? width - GUTTER - ACTIVITY_W - PANEL_GAP : width - GUTTER;
  const want = centerX ?? width / 2;
  const place = (left: number, top: number): CrumbsSlot => {
    const maxWidth = Math.max(0, Math.min(cap, right - left));
    const half = Math.min(size.full, maxWidth) / 2;
    return { x: Math.max(left + half, Math.min(want, right - half)), top, maxWidth };
  };
  if (legend === undefined || legend.width <= 0 || legend.height <= 0) return place(GUTTER, GUTTER);
  const beside = place(GUTTER + legend.width + PANEL_GAP, GUTTER);
  if (beside.maxWidth > 0 && beside.maxWidth >= Math.min(size.min, CRUMBS_MIN_W)) return beside;
  return place(GUTTER, GUTTER + legend.height + PANEL_GAP);
}

/**
 * How much of a breadcrumb trail fits in `maxWidth`: the index of the first
 * crumb shown after the repo name. Crumbs 1…start-1 collapse into one "…"
 * (never the repo name or the current folder), shortest collapse first.
 * `widths` are each crumb's natural width with its separator, `ellipsis` the
 * "…" crumb's, and `chrome` the pill's own padding and border.
 */
export function crumbsStart(widths: number[], ellipsis: number, chrome: number, maxWidth: number): number {
  const n = widths.length;
  if (n <= 2) return 1;
  let tail = 0; // widths[start..n-1]
  for (let i = 1; i < n; i++) tail += widths[i]!;
  if (chrome + widths[0]! + tail <= maxWidth) return 1;
  for (let start = 2; start < n; start++) {
    tail -= widths[start - 1]!;
    if (chrome + widths[0]! + ellipsis + tail <= maxWidth) return start;
  }
  return n - 1;
}

/** The pill's width for the whole trail, and for its most collapsed form (see crumbsStart). */
export function crumbsSize(widths: number[], ellipsis: number, chrome: number): CrumbsSize {
  const n = widths.length;
  const sum = widths.reduce((a, b) => a + b, 0);
  const min = n <= 2 ? sum : widths[0]! + ellipsis + widths[n - 1]!;
  return { full: chrome + sum, min: chrome + min };
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
