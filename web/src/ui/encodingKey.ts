// The map key: what each mark on the map means. Every swatch is a sample file
// run through the map's own encode() and fileLook(), so the key cannot drift
// from what the renderer draws.
import { encode, type NodeVisual } from "../layout/encoding";
import type { Kind, Stage, Worktree } from "../protocol";
import { DELETED_SCALE } from "../render/scene";
import { countFontPx, digitCount } from "../render/labels";
import { aggregateLook, countColor, fileLook, type FileLook, type Theme } from "../render/style";
import type { RepoState } from "../store";

export type KeyEntryId = "unchanged" | "edited" | "added" | "committed" | "deleted" | "merged";

/** One bubble in a swatch: where it sits in the swatch box, its radius, and how it is drawn. */
export interface KeyMark {
  cx: number;
  r: number;
  look: FileLook;
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

/** The main worktree ("you", always blue) stands in for any worktree. */
const MAIN: Worktree = { id: "key", path: "", label: "main", head: "", isMain: true, locked: false, colorIndex: 0 };

/** A file in the given state, encoded exactly as the map encodes a real one. */
function sample(ext: string, change?: { stage: Stage; kind: Kind }): NodeVisual {
  const path = `sample.${ext}`;
  const overlay = change ? new Map([[path, { path, size: 1, ...change }]]) : null;
  const state: RepoState = {
    repo: { name: "", base: "", baseSha: "" },
    seq: 0,
    worktrees: new Map([[MAIN.id, MAIN]]),
    tree: new Map([[path, 1]]),
    overlays: new Map(overlay ? [[MAIN.id, overlay]] : []),
    activity: [],
  };
  return encode(state, path);
}

function mark(vis: NodeVisual, theme: Theme, r = R, cx = CX, shimmer = false): KeyMark {
  return { cx, r, look: fileLook(vis, theme, null), shimmer };
}

export function keyEntries(theme: Theme): KeyEntry[] {
  const night = theme === "night";
  return [
    {
      id: "unchanged",
      label: "Unchanged file",
      hint: night
        ? "A file no worktree has changed. Bubble size is the file's size."
        : "A file no worktree has changed. Bubble size is the file's size; its tint is the file type.",
      // Two sizes (and, in Vision, two file types) so both size and tint read.
      marks: [mark(sample("md"), theme, 3.5, CX - 6.5), mark(sample("ts"), theme, R + 0.5, CX + 3.5)],
    },
    {
      id: "edited",
      label: "Edited, uncommitted",
      hint: "Changed in a worktree but not committed yet: a glow and a dashed ring in the worktree's colour.",
      marks: [mark(sample("ts", { stage: "uncommitted", kind: "modified" }), theme)],
    },
    {
      id: "added",
      label: "New, uncommitted",
      hint: "A new file, not committed yet: a ghost with a dashed outline in the worktree's colour.",
      marks: [mark(sample("ts", { stage: "uncommitted", kind: "added" }), theme)],
    },
    {
      id: "committed",
      label: "Committed on branch",
      hint: "Committed on the worktree's branch but not in base yet: filled in the worktree's colour, with a thin solid ring.",
      marks: [mark(sample("ts", { stage: "committed", kind: "modified" }), theme)],
    },
    {
      id: "deleted",
      label: "Deleted",
      hint: "Deleted in a worktree: a faint outline that stays until the deletion reaches base.",
      marks: [mark(sample("ts", { stage: "uncommitted", kind: "deleted" }), theme, R * DELETED_SCALE)],
    },
    {
      id: "merged",
      label: "Merged into base",
      hint: "The change reached base: the file returns to its usual look with a brief shimmer.",
      marks: [mark(sample("ts"), theme, R, CX, true)],
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
  const look = aggregateLook({ path: "", ext: "", touches: [], ghost: false, deleted: false, tinted: false }, theme, null);
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
