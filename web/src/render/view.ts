import type { NodeVisual } from "../layout/encoding";
import type { FreeArea } from "../layout/frame";
import type { Circle } from "../layout/pack";
import type { WorktreeId } from "../protocol";
import type { Change } from "../store";
import type { Theme } from "./style";

/** Which map the page draws: circle packing (MapRenderer), or rectangles (RectRenderer). */
export type ViewKind = "bubbles" | "treemap" | "partition";

export const VIEW_KINDS: readonly ViewKind[] = ["bubbles", "treemap", "partition"];

export const VIEW_LABELS: Readonly<Record<ViewKind, string>> = {
  bubbles: "Bubbles",
  treemap: "Tree map",
  partition: "Partition",
};

/**
 * What App needs from a map renderer. MapRenderer (bubbles) zooms with a
 * camera; RectRenderer (tree map, partition) is handed a new layout per
 * folder in view instead, and its free camera (wheel zoom, drag) only
 * magnifies that layout: its zoomTo just sends the camera home, and it never
 * calls the onZoom or onFocus callbacks.
 */
export interface MapView {
  init(): Promise<void>;
  update(layout: Map<string, Circle>, visuals: Map<string, NodeVisual>, change: Change): void;
  setTheme(t: Theme): void;
  isolate(worktree: WorktreeId | null): void;
  highlight(path: string | null): void;
  zoomTo(path: string): void;
  setFreeArea(rect: FreeArea): void;
  onHover(fn: (path: string | null, screen: { x: number; y: number }) => void): void;
  onClick(fn: (path: string | null) => void): void;
  onZoom(fn: (scale: number) => void): void;
  onFocus(fn: (path: string) => void): void;
  onDoubleClick(fn: (path: string | null) => void): void;
  destroy(): void;
}
