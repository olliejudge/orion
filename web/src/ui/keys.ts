export type KeyAction = "theme" | "fullscreen" | "zoomOut" | "zoomIn" | "home" | "back" | "forward";

/** N toggles Night/Vision, F toggles fullscreen, Esc/Backspace/- zoom out one level, +/= zoom in
 * one level, 0/Home go home, Alt+Left/Right retrace the navigation history. `/` search is Phase 2,
 * left unbound here on purpose. A held key does not repeat, so holding any of these cannot strobe the page. */
export function keyAction(e: KeyboardEvent): KeyAction | null {
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return null;
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.repeat) {
    if (e.key === "ArrowLeft") return "back";
    if (e.key === "ArrowRight") return "forward";
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return null;
  switch (e.key) {
    case "n":
    case "N":
      return "theme";
    case "f":
    case "F":
      return "fullscreen";
    case "Escape":
    case "Backspace":
      return "zoomOut";
    case "-":
    case "_":
      return "zoomOut";
    case "+":
    case "=":
      return "zoomIn";
    case "0":
    case "Home":
      return "home";
    default:
      return null;
  }
}
