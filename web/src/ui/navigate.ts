// A single, swappable hook other UI pieces call to move the map to a folder
// or a file's folder — a future jump-to-folder search, or a folder-filter
// panel landing on a path, say. App.svelte installs the real handler once
// the renderer has started; calling navigateTo before that (or from a test
// that never installs one) is a harmless no-op.
let handler: ((path: string) => void) | null = null;

/** Installs `fn` as the navigateTo handler; call the returned function to remove it again. */
export function setNavigateHandler(fn: (path: string) => void): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/**
 * Move the map to `path` (a repo-relative folder, or a file's own folder), as
 * a discrete navigation: it lands on the nearest folder the map is currently
 * showing (same rule as a click or an Activity row) and pushes a history
 * entry (see location.ts).
 */
export function navigateTo(path: string): void {
  handler?.(path);
}
