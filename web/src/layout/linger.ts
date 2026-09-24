/**
 * Paths kept in the layout for a while after a merge (see computeFrame's
 * `linger`), so a file too small to show at the current zoom still gets its
 * shimmer instead of vanishing like a deletion.
 */
export class Linger {
  #until = new Map<string, number>();
  readonly #ms: number;

  constructor(ms: number) {
    this.#ms = ms;
  }

  add(paths: readonly string[], now: number): void {
    for (const p of paths) this.#until.set(p, now + this.#ms);
  }

  /** The lingering paths, or undefined when there are none. */
  paths(): ReadonlySet<string> | undefined {
    return this.#until.size > 0 ? new Set(this.#until.keys()) : undefined;
  }

  /** When the next path is due to leave, or null. */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const t of this.#until.values()) if (next === null || t < next) next = t;
    return next;
  }

  /** Drops paths whose time is up; true if any were dropped (the layout must be recomputed). */
  expire(now: number): boolean {
    let dropped = false;
    for (const [p, t] of this.#until) {
      if (t > now) continue;
      this.#until.delete(p);
      dropped = true;
    }
    return dropped;
  }
}
