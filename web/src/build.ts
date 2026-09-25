/** The `src` of the page's hashed module entry script (Vite's `<script type="module" src="...">`), or null if absent. */
function moduleEntrySrc(doc: Document): string | null {
  return doc.querySelector("script[type=\"module\"][src]")?.getAttribute("src") ?? null;
}

/** Only the path, so origin differences between a fetched and the live document don't cause false positives. */
function pathnameOf(src: string): string | null {
  try {
    return new URL(src, window.location.origin).pathname;
  } catch {
    return null;
  }
}

/**
 * Fetches `/` fresh and compares its module entry script against `doc`'s.
 * A mismatch means Orion restarted on a newer build serving a different
 * bundle, so the running page's JS is stale. In dev mode both are always
 * `/src/main.ts`, so this naturally reports no change.
 */
export async function servedBuildChanged(doc: Document, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn("/", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return false;
    const html = await res.text();
    const served = moduleEntrySrc(new DOMParser().parseFromString(html, "text/html"));
    const current = moduleEntrySrc(doc);
    if (served === null || current === null) return false;
    const servedPath = pathnameOf(served);
    const currentPath = pathnameOf(current);
    if (servedPath === null || currentPath === null) return false;
    return servedPath !== currentPath;
  } catch {
    return false;
  }
}
