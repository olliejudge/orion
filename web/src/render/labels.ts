/**
 * Folder label placement. A name is set along the top of its folder's rim
 * (the outline is broken behind it). A folder tangent to its parent's top
 * would print its name over the parent's, so an at-rest pass places labels
 * outer (larger) first and pushes a colliding one up to MAX_INSET lines
 * inward, or hides it if that still collides: in a deep chain of nearly
 * concentric folders the inner name is dropped rather than drawn on top of,
 * or nearly touching, an outer one. Pure, so it is unit-tested without Pixi.
 *
 * The folders a click in the view would land in (the next level, see
 * nextLevels) are named first and from a much smaller size, so the map
 * always says where a click goes: where their name doesn't fit whole on
 * the rim, it is set straight across the folder's middle instead. Deeper
 * folders are named only once they are LABEL_MIN_R across on screen.
 */

export const LABEL_FONT_PX = 11;
/**
 * One inward step: a line of label text plus room for NEAR_PX clearance and a
 * short name's arc sag, so a child tangent to its parent's top clears it in one step.
 */
export const LABEL_LINE_PX = 16;
export const LABEL_MAX_SPAN = Math.PI * 0.8;
const SIDE_PAD_PX = 2;
/** Labels whose bands come closer than this (vertically) count as colliding: prefer hiding over near-overlapping text. */
const NEAR_PX = 2.5;
export const MAX_INSET = 2;

/** On-screen radius (CSS px) a folder deeper than the next level needs before it gets its name. */
export const LABEL_MIN_R = 48;
/** On-screen radius (CSS px) a next-level folder needs before it gets its name. */
export const NEXT_LABEL_MIN_R = 16;
/** How far a straight label may reach past its folder's rim on each side, CSS px. */
export const STRAIGHT_OVERHANG_PX = 5;
/** A straight label narrower than this (or its whole name) would be mostly ellipsis: the tooltip names the folder instead. */
const STRAIGHT_MIN_PX = 24;
/** Clearance above and below a straight label's text. */
const STRAIGHT_PAD_PX = 1.5;

/**
 * - outer: the folder in view and its ancestors (placed first: their rims frame the view);
 * - next: the folders a click in the view lands in;
 * - inner: everything else (deeper folders, and the view's neighbours).
 */
export type LabelTier = "outer" | "next" | "inner";
const TIER_RANK: Record<LabelTier, number> = { outer: 0, next: 1, inner: 2 };

export interface LabelCandidate {
  path: string;
  /** Circle centre and radius on screen, CSS px. */
  x: number;
  y: number;
  r: number;
  /** Width of the label text, CSS px. */
  width: number;
  /** Placement priority and fallbacks (default "inner"). */
  tier?: LabelTier;
}

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface LabelSpot {
  /** Along the top of the rim, or straight across the middle of the folder. */
  kind: "arc" | "straight";
  tier: LabelTier;
  /** Lines pushed inward from the rim: 0 (on the rim) up to MAX_INSET (arc only). */
  inset: number;
  /** Radius of the text's centre line: r on the rim, less when pushed inward (arc only). */
  textR: number;
  /** Half the angle the text spans, centred on 12 o'clock (arc only). */
  half: number;
  /** Widest the text may be drawn, CSS px (straight only; longer names are truncated). */
  maxWidth: number;
  /** The space the label takes on screen, CSS px. */
  box: Box;
}

/** Smallest on-screen radius at which a folder of this tier is named. */
export function labelMinR(tier: LabelTier): number {
  return tier === "next" ? NEXT_LABEL_MIN_R : LABEL_MIN_R;
}

/** Whether `dir` is the folder at `path` or one of its ancestors ("" is the root). */
function contains(dir: string, path: string): boolean {
  return dir === "" || path === dir || (path.length > dir.length && path.startsWith(dir) && path[dir.length] === "/");
}

/**
 * The next level below `focus`: the named folders (keys of `labels`, see
 * labelNames) inside it with no other named folder between them and it.
 * These are where a click inside the view zooms to (see nav.ts clickTarget).
 */
export function nextLevels(labels: ReadonlyMap<string, string>, focus: string): Set<string> {
  const out = new Set<string>();
  for (const path of labels.keys()) {
    if (path === focus || !contains(focus, path)) continue;
    let between = false;
    for (let slash = path.lastIndexOf("/"); slash > focus.length; slash = path.lastIndexOf("/", slash - 1)) {
      if (labels.has(path.slice(0, slash))) {
        between = true;
        break;
      }
    }
    if (!between) out.add(path);
  }
  return out;
}

/** A folder's tier with the view on `focus`, `next` being nextLevels(labels, focus). */
export function labelTier(path: string, focus: string, next: ReadonlySet<string>): LabelTier {
  if (contains(path, focus)) return "outer";
  return next.has(path) ? "next" : "inner";
}

/** Widest a straight label may be in a folder of on-screen radius r. */
export function straightWidth(r: number): number {
  return 2 * (r + STRAIGHT_OVERHANG_PX - SIDE_PAD_PX);
}

/** Angle a label of `width` px spans at radius `textR` (long names are truncated to LABEL_MAX_SPAN). */
export function labelSpan(width: number, textR: number): number {
  return Math.min(width / textR, LABEL_MAX_SPAN);
}

function boxOf(c: LabelCandidate, textR: number, half: number): Box {
  const dx = textR * Math.sin(Math.min(half, Math.PI / 2)) + SIDE_PAD_PX;
  return {
    x0: c.x - dx,
    x1: c.x + dx,
    y0: c.y - textR - LABEL_FONT_PX / 2,
    y1: c.y - textR * Math.cos(half) + LABEL_FONT_PX / 2,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 + NEAR_PX && b.y0 < a.y1 + NEAR_PX;
}

function straightBox(c: LabelCandidate, width: number): Box {
  const dx = width / 2 + SIDE_PAD_PX;
  const dy = LABEL_FONT_PX / 2 + STRAIGHT_PAD_PX;
  return { x0: c.x - dx, x1: c.x + dx, y0: c.y - dy, y1: c.y + dy };
}

/** On the rim, or pushed up to MAX_INSET lines inward; `whole`: only where the name fits untruncated. */
function arcSpot(c: LabelCandidate, tier: LabelTier, whole: boolean, placed: readonly Box[]): LabelSpot | null {
  for (let inset = 0; inset <= MAX_INSET; inset++) {
    const textR = c.r - inset * LABEL_LINE_PX;
    if (textR < 2 * LABEL_FONT_PX) break;
    if (whole && c.width / textR > LABEL_MAX_SPAN) break; // further in only truncates more
    const half = labelSpan(c.width, textR) / 2;
    const box = boxOf(c, textR, half);
    if (placed.some((p) => overlaps(p, box))) continue;
    return { kind: "arc", tier, inset, textR, half, maxWidth: 0, box };
  }
  return null;
}

/** Straight across the folder's middle, truncated to the folder's width. */
function straightSpot(c: LabelCandidate, tier: LabelTier, placed: readonly Box[]): LabelSpot | null {
  const maxWidth = straightWidth(c.r);
  const width = Math.min(c.width, maxWidth);
  if (width < Math.min(c.width, STRAIGHT_MIN_PX)) return null;
  const box = straightBox(c, width);
  if (placed.some((p) => overlaps(p, box))) return null;
  return { kind: "straight", tier, inset: 0, textR: 0, half: 0, maxWidth, box };
}

/**
 * Where each label goes; paths missing from the result are hidden. Outer
 * folders are placed first, then the next level, then the rest, each
 * largest first. A next-level folder smaller than LABEL_MIN_R keeps its arc
 * only where its whole name fits on it; otherwise (and when every arc
 * collides) its name goes straight across its middle.
 */
export function placeLabels(cands: readonly LabelCandidate[]): Map<string, LabelSpot> {
  const tierOf = (c: LabelCandidate): LabelTier => c.tier ?? "inner";
  const order = [...cands].sort(
    (a, b) => TIER_RANK[tierOf(a)] - TIER_RANK[tierOf(b)] || b.r - a.r || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const placed: Box[] = [];
  const out = new Map<string, LabelSpot>();
  for (const c of order) {
    const tier = tierOf(c);
    const next = tier === "next";
    const spot = arcSpot(c, tier, next && c.r < LABEL_MIN_R, placed) ?? (next ? straightSpot(c, tier, placed) : null);
    if (!spot) continue;
    placed.push(spot.box);
    out.set(c.path, spot);
  }
  return out;
}

// ---- file counts on collapsed folders ------------------------------------

/** On-screen radius (CSS px) a collapsed folder needs before it shows its file count. */
export const COUNT_MIN_R = 7;
const COUNT_MIN_FONT_PX = 8;
const COUNT_MAX_FONT_PX = LABEL_FONT_PX;
/** A digit's advance as a fraction of the font size (the system UI font's digits are tabular). */
export const DIGIT_EM = 0.62;

/** Decimal digits in a non-negative integer. */
export function digitCount(n: number): number {
  let d = 1;
  for (let v = Math.floor(Math.abs(n)); v >= 10; v = Math.floor(v / 10)) d++;
  return d;
}

/**
 * Font size (CSS px) for a collapsed folder's file count of `digits` digits
 * in a disc of on-screen radius r, growing with the disc; null when the disc
 * is under COUNT_MIN_R or the number would not fit inside it.
 */
export function countFontPx(r: number, digits: number): number | null {
  if (!(r >= COUNT_MIN_R)) return null;
  const font = Math.max(COUNT_MIN_FONT_PX, Math.min(COUNT_MAX_FONT_PX, Math.floor(r * 0.75)));
  return digits * DIGIT_EM * font <= 2 * r - 3 ? font : null;
}

export interface CountCandidate {
  path: string;
  /** Disc centre on screen, CSS px. */
  x: number;
  y: number;
  /** Digits in the count, and its font size (countFontPx). */
  digits: number;
  font: number;
}

/** The collapsed folders whose count shows: those clear of every placed label (a folder's name wins over a count). */
export function placeCounts(cands: readonly CountCandidate[], spots: ReadonlyMap<string, LabelSpot>): Set<string> {
  const out = new Set<string>();
  for (const c of cands) {
    const dx = (c.digits * DIGIT_EM * c.font) / 2;
    const dy = c.font / 2;
    const box: Box = { x0: c.x - dx, x1: c.x + dx, y0: c.y - dy, y1: c.y + dy };
    let clear = true;
    for (const s of spots.values()) {
      if (overlaps(s.box, box)) {
        clear = false;
        break;
      }
    }
    if (clear) out.add(c.path);
  }
  return out;
}
