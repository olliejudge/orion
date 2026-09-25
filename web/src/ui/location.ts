// The focused folder's location in the URL hash: "#/<repo-relative path>",
// percent-encoded per path segment so any character round-trips safely; the
// root is "#/". Resolving a decoded path against the current layout (e.g. a
// path that no longer exists) is nearestShown's job (layout/shown.ts); the
// public navigateTo hook other UI pieces call lives in navigate.ts.

/** `path` (a repo-relative path, "" = root) as a URL hash. */
export function encodeLocation(path: string): string {
  if (path === "") return "#/";
  return `#/${path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/")}`;
}

/**
 * The repo-relative path a location hash names, or null if `hash` isn't one
 * (missing, or malformed percent-encoding) — so callers can tell "no
 * location in the URL" apart from "the root" (`decodeLocation("#/") === ""`).
 * A trailing slash (or several) is ignored.
 */
export function decodeLocation(hash: string): string | null {
  if (!hash.startsWith("#/")) return null;
  const rest = hash.slice(2).replace(/\/+$/, "");
  if (rest === "") return "";
  try {
    return rest
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");
  } catch {
    return null; // e.g. a lone "%" from a hand-edited URL
  }
}

/** The subset of the History API HashSync needs, so tests can inject a fake. */
export interface HistoryLike {
  pushState(data: unknown, unused: string, url?: string): void;
  replaceState(data: unknown, unused: string, url?: string): void;
}

const REPLACE_DEBOUNCE_MS = 300;

/**
 * Keeps the URL hash following the focused folder.
 *
 * - `push`: a discrete move (click, double-click, a breadcrumb, Esc/Backspace,
 *   an Activity row, navigateTo) — adds a history entry so Back/Forward
 *   retrace it.
 * - `replace`: a continuous camera move (wheel zoom, drag) — writes the hash
 *   in place, debounced, so a flurry of wheel ticks doesn't flood history;
 *   only the last target lands, once the pointer settles.
 * - `replaceNow`: an immediate, undebounced correction (e.g. a load-time hash
 *   naming a path that's gone, corrected to its nearest existing ancestor).
 * - `sync`: records a path as the hash's current value without writing it,
 *   for `popstate`/`hashchange` (the browser already changed the URL) and for
 *   a load-time restore that finds nothing to correct.
 * - `flush`: commits a pending debounced `replace` immediately, so a reload
 *   right after a scroll-zoom doesn't lose the last few hundred milliseconds
 *   of camera movement (call this from a `pagehide` listener).
 */
export class HashSync {
  readonly #history: HistoryLike;
  readonly #debounceMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (id: ReturnType<typeof setTimeout>) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: string | null = null; // the path a running debounce will write
  #written: string; // the path last actually written to the hash (or assumed correct at construction)

  constructor(
    initial: string,
    history: HistoryLike = window.history,
    debounceMs: number = REPLACE_DEBOUNCE_MS,
    setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id: ReturnType<typeof setTimeout>) => void = (id) => clearTimeout(id),
  ) {
    this.#written = initial;
    this.#history = history;
    this.#debounceMs = debounceMs;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  push(path: string): void {
    this.#cancelPending();
    if (path === this.#written) return;
    this.#written = path;
    this.#history.pushState(null, "", encodeLocation(path));
  }

  replace(path: string): void {
    this.#cancelPending();
    if (path === this.#written) return; // back to where we started before the debounce fired: nothing to write
    this.#pending = path;
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.#commitPending();
    }, this.#debounceMs);
  }

  replaceNow(path: string): void {
    this.#cancelPending();
    if (path === this.#written) return;
    this.#written = path;
    this.#history.replaceState(null, "", encodeLocation(path));
  }

  sync(path: string): void {
    this.#cancelPending();
    this.#written = path;
  }

  flush(): void {
    if (this.#timer === null) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#commitPending();
  }

  #commitPending(): void {
    if (this.#pending === null) return;
    this.#written = this.#pending;
    this.#pending = null;
    this.#history.replaceState(null, "", encodeLocation(this.#written));
  }

  #cancelPending(): void {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#pending = null;
  }
}
