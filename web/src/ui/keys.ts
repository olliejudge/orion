export type KeyAction = "theme" | "fullscreen" | "zoomOut";

/** N toggles Night/Vision, F toggles fullscreen, Esc zooms out. `/` search is Phase 2.
 * A held key does not repeat, so holding N or F cannot strobe the page. */
export function keyAction(e: KeyboardEvent): KeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return null;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return null;
  switch (e.key) {
    case "n":
    case "N":
      return "theme";
    case "f":
    case "F":
      return "fullscreen";
    case "Escape":
      return "zoomOut";
    default:
      return null;
  }
}
