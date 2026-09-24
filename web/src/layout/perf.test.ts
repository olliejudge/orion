import { describe, expect, it } from "vitest";
import { encodeAll } from "./encoding";
import { bigState } from "./fixtures";
import { computeFrame } from "./frame";

// Smoke tests for the 20k-file hot paths. Bounds are deliberately generous
// so they only trip on an algorithmic regression, not on a slow CI runner.
describe("20k-file performance", () => {
  it("re-culls at a new zoom scale without re-packing", () => {
    const s = bigState();
    const t0 = performance.now();
    computeFrame(s, 1400, 900, 1);
    const first = performance.now() - t0;
    const t1 = performance.now();
    computeFrame(s, 1400, 900, 2);
    const again = performance.now() - t1;
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
    const s = bigState(); // fresh state object, so no per-state index is warm
    const t0 = performance.now();
    encodeAll(s, layout);
    expect(performance.now() - t0).toBeLessThan(150);
  });
});
