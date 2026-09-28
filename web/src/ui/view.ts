import { VIEW_KINDS, type ViewKind } from "../render/view";

export const VIEW_KEY = "orion.view";

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Remembered view; "bubbles" when unset, invalid, or storage is unavailable. */
export function loadView(storage: Storage | null = defaultStorage()): ViewKind {
  try {
    const v = storage?.getItem(VIEW_KEY);
    return VIEW_KINDS.find((k) => k === v) ?? "bubbles";
  } catch {
    return "bubbles";
  }
}

export function saveView(v: ViewKind, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(VIEW_KEY, v);
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}

/** The view after `v` (the V key cycles through them). */
export function nextView(v: ViewKind): ViewKind {
  return VIEW_KINDS[(VIEW_KINDS.indexOf(v) + 1) % VIEW_KINDS.length]!;
}
