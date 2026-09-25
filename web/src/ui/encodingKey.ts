// The map key: what each mark on the map means. Every swatch is a sample file
// run through the map's own encode() and fileLook(), so the key cannot drift
// from what the renderer draws.
import { blankVisual, encode, type NodeVisual } from "../layout/encoding";
import type { Kind, Stage, Worktree } from "../protocol";
import { DELETED_SCALE } from "../render/scene";
import { countFontPx, digitCount } from "../render/labels";
import { aggregateLook, countColor, fileLook, glyphSize, type FileLook, type Theme } from "../render/style";
import type { RepoState } from "../store";

export type KeyEntryId = "unchanged" | "edited" | "added" | "committed" | "deleted" | "merged" | "age";

/** One bubble in a swatch: where it sits in the swatch box, its radius, and how it is drawn. */
export interface KeyMark {
  cx: number;
  r: number;
  look: FileLook;
  /** The glyph's half-size as the map would draw it at this radius (glyphSize), or null when it shows none. */
  glyph: number | null;
  /** Drawn with the merge shimmer on top. */
  shimmer: boolean;
}

export interface KeyEntry {
  id: KeyEntryId;
  label: string;
  /** A fuller description (the row's tooltip). */
  hint: string;
  marks: KeyMark[];
}

/** Swatch box, CSS px. */
export const SWATCH_W = 30;
export const SWATCH_H = 22;
const R = 5.5;
const CX = SWATCH_W / 2;

/** The key's clock: samples are timed relative to it, so the swatches never change. */
const KEY_NOW = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Ages along the age strip: now, a day, a week, a month, half a year, a year (style.ts AGE_STOPS). */
export const AGE_SAMPLES_MS = [0, DAY, 7 * DAY, 30 * DAY, 180 * DAY, 365 * DAY] as const;

/** The main worktree ("you", always blue) stands in for any worktree. */
const MAIN: Worktree = { id: "key", path: "", label: "main", head: "", isMain: true, locked: false, colorIndex: 0 };

/** A file in the given state, touched `age` ms before the key's clock, encoded exactly as the map encodes a real one. */
function sample(age: number, change?: { stage: Stage; kind: Kind }): NodeVisual {
  const path = "sample.ts";
  const touched = KEY_NOW - age;
  const overlay = change ? new Map([[path, { path, size: 1, touched, ...change }]]) : null;
  const state: RepoState = {
    repo: { name: "", base: "", baseSha: "" },
    seq: 0,
    worktrees: new Map([[MAIN.id, MAIN]]),
    tree: new Map([[path, 1]]),
    touched: new Map([[path, touched]]),
    overlays: new Map(overlay ? [[MAIN.id, overlay]] : []),
    activity: [],
  };
  return encode(state, path);
}

function mark(vis: NodeVisual, theme: Theme, r = R, cx = CX, shimmer = false): KeyMark {
  return { cx, r, look: fileLook(vis, theme, null, KEY_NOW), glyph: glyphSize(r), shimmer };
}

export function keyEntries(theme: Theme): KeyEntry[] {
  const step = SWATCH_W / AGE_SAMPLES_MS.length;
  return [
    {
      id: "unchanged",
      label: "Unchanged file",
      hint: "A file no worktree has changed: a quiet grey disc. Bubble size is the file's size.",
      // Two sizes so size reads; both last committed a week ago.
      marks: [mark(sample(7 * DAY), theme, 3.5, CX - 6.5), mark(sample(7 * DAY), theme, R + 0.5, CX + 3.5)],
    },
    {
      id: "edited",
      label: "Edited, uncommitted",
      hint: "Changed in a worktree but not committed yet: filled in the worktree's colour, with a glow while the work is live.",
      marks: [mark(sample(0, { stage: "uncommitted", kind: "modified" }), theme)],
    },
    {
      id: "added",
      label: "New, uncommitted",
      hint: "A new file (or the new name of a moved one), not committed yet: filled in the worktree's colour with a +.",
      marks: [mark(sample(0, { stage: "uncommitted", kind: "added" }), theme)],
    },
    {
      id: "committed",
      label: "Committed on branch",
      hint: "Committed on the worktree's branch but not in base yet: filled in the worktree's colour, with a thin solid ring.",
      marks: [mark(sample(0, { stage: "committed", kind: "modified" }), theme)],
    },
    {
      id: "deleted",
      label: "Deleted",
      hint: "Deleted (or moved away) in a worktree: a hollow rim with a × in the worktree's colour, until the deletion reaches base.",
      // Shrunk as on the map, from a bubble just big enough that the × still shows.
      marks: [mark(sample(0, { stage: "uncommitted", kind: "deleted" }), theme, (R + 0.5) * DELETED_SCALE)],
    },
    {
      id: "merged",
      label: "Merged into base",
      hint: "The change reached base: the file turns back into a grey disc (freshly committed, so bright) with a brief shimmer.",
      marks: [mark(sample(0), theme, R, CX, true)],
    },
    {
      id: "age",
      label: "Now → a year ago",
      hint: "Brightness is how recently a file was touched (unchanged files: its last commit): brightest within the hour, then dimmer after a day, a week, a month and half a year, faintest after a year. Changed files stay brighter than unchanged ones of the same age.",
      // Unchanged files, last committed at each sample age, left to right.
      marks: AGE_SAMPLES_MS.map((age, i) => mark(sample(age), theme, 2.2, step * (i + 0.5))),
    },
  ];
}

/** The collapsed-folder row: a disc drawn as the map draws one, with its file count. */
export interface CountSwatch {
  label: string;
  hint: string;
  r: number;
  fill: { color: number; alpha: number };
  outline: { color: number; alpha: number };
  count: number;
  font: number;
  color: string;
}

const COUNT_R = 9;
const COUNT_SAMPLE = 12;

export function countSwatch(theme: Theme): CountSwatch {
  const look = aggregateLook(blankVisual(""), theme, null, KEY_NOW);
  return {
    label: "Files in a small folder",
    hint: "A folder too small to open up at this zoom is one faint disc; the number is how many files it holds. Zoom in to open it.",
    r: COUNT_R,
    fill: look.fill,
    outline: look.outline,
    count: COUNT_SAMPLE,
    font: countFontPx(COUNT_R, digitCount(COUNT_SAMPLE)) ?? 8,
    color: countColor(theme),
  };
}

/** 0xrrggbb → "#rrggbb". */
export function hexOf(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

export const KEY_OPEN_KEY = "orion.key";

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Whether the key is expanded: whatever the viewer last chose, else `fallback` (a first visit). */
export function loadKeyOpen(storage: Storage | null = defaultStorage(), fallback = true): boolean {
  try {
    const v = storage?.getItem(KEY_OPEN_KEY);
    return v === "open" ? true : v === "closed" ? false : fallback;
  } catch {
    return fallback;
  }
}

export function saveKeyOpen(open: boolean, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(KEY_OPEN_KEY, open ? "open" : "closed");
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}
