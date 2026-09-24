import type { Change } from "../store";

/**
 * Folds `next` into a pending change: a snapshot if either was one, the
 * latest patch, and the union of both `merged` lists (in order, no
 * duplicates), so coalescing never drops a merge shimmer.
 */
export function mergeChange(pending: Change | null, next: Change): Change {
  if (pending === null) return next;
  const merged = [...new Set([...pending.merged, ...next.merged])];
  const kind = pending.kind === "snapshot" || next.kind === "snapshot" ? "snapshot" : "patch";
  const patch = next.patch ?? pending.patch;
  return patch ? { kind, patch, merged } : { kind, merged };
}

/**
 * Runs `run` at most once per animation frame with every change requested
 * since the last run merged together (see mergeChange). Re-laying out a 20k
 * file repo is too slow to do per socket message or per resize event.
 */
export class FrameCoalescer {
  #pending: Change | null = null;
  #frame: number | null = null;
  readonly #run: (c: Change) => void;
  readonly #raf: (cb: () => void) => number;
  readonly #caf: (id: number) => void;

  constructor(
    run: (c: Change) => void,
    raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
    caf: (id: number) => void = (id) => cancelAnimationFrame(id),
  ) {
    this.#run = run;
    this.#raf = raf;
    this.#caf = caf;
  }

  /** Queues `c` for the next frame. */
  request(c: Change): void {
    this.#pending = mergeChange(this.#pending, c);
    this.#frame ??= this.#raf(() => {
      this.#frame = null;
      this.flush();
    });
  }

  /** Runs the pending change now, if any (e.g. mid-zoom, where a frame of lag shows). */
  flush(): void {
    if (this.#frame !== null) this.#caf(this.#frame);
    this.#frame = null;
    const c = this.#pending;
    this.#pending = null;
    if (c !== null) this.#run(c);
  }

  /** Drops the pending change. */
  cancel(): void {
    if (this.#frame !== null) this.#caf(this.#frame);
    this.#frame = null;
    this.#pending = null;
  }
}
