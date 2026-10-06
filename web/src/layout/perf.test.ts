import { describe, expect, it } from "vitest";
import { encodeAll } from "./encoding";
import { bigState } from "./fixtures";
import { computeFrame } from "./frame";

// Smoke tests for the 20k-file hot paths. Bounds are deliberately generous
// so they only trip on an algorithmic regression, not on a slow CI runner,
// and timings take the best of a few runs: one run on a busy machine (a
// box's hourly upgrade under memory pressure, say) can stall for a GC or a
// context switch without anything being slower.
const RUNS = 3;

function best(fn: () => void): number {
  let min = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

describe("20k-file performance", () => {
  it("re-culls at a new zoom scale without re-packing", () => {
    const s = bigState();
    const t0 = performance.now();
    computeFrame(s, 1400, 900, 1);
    const first = performance.now() - t0;
    const again = best(() => computeFrame(s, 1400, 900, 2));
    expect(again).toBeLessThan(first * 0.25);
  });

  it("gives the same frame from the cache as from a cold computation", () => {
    const s = bigState(2_000, 200);
    computeFrame(s, 1400, 900, 1, 48); // warms the pack cache for this size
    const cached = computeFrame(s, 1400, 900, 3, 48);
    const cold = computeFrame(bigState(2_000, 200), 1400, 900, 3, 48);
    expect([...cached.layout]).toEqual([...cold.layout]);
    expect([...cached.visuals]).toEqual([...cold.visuals]);
  });

  it("encodes a culled 20k-file layout with 2000 touched paths quickly", () => {
    const { layout } = computeFrame(bigState(), 1400, 900, 1);
    // A fresh state object per run, so no per-state index is warm.
    const states = Array.from({ length: RUNS }, () => bigState());
    let i = 0;
    expect(best(() => encodeAll(states[i++]!, layout))).toBeLessThan(300);
  });
});
