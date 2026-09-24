import type { Theme } from "../render/MapRenderer";

export type { Theme };

export const THEME_KEY = "orion.theme";

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Remembered theme; "vision" when unset, invalid, or storage is unavailable. */
export function loadTheme(storage: Storage | null = defaultStorage()): Theme {
  try {
    const v = storage?.getItem(THEME_KEY);
    return v === "night" ? "night" : "vision";
  } catch {
    return "vision";
  }
}

export function saveTheme(t: Theme, storage: Storage | null = defaultStorage()): void {
  try {
    storage?.setItem(THEME_KEY, t);
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}

/** CSS tokens in theme.css switch on <html data-theme>. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}
