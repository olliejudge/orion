import { describe, expect, it } from "vitest";
import { makeState } from "./fixtures";
import { computeFrame } from "./frame";

describe("computeFrame", () => {
  const files: Record<string, number> = { "big.bin": 10_000_000, "tiny.txt": 1 };

  it("returns a visual for every circle in the layout", () => {
    const f = computeFrame(makeState(files, { w1: [{ path: "big.bin", kind: "modified", stage: "uncommitted", size: 1 }] }), 400, 400, 1);
    expect([...f.visuals.keys()]).toEqual([...f.layout.keys()]);
    expect(f.visuals.get("big.bin")!.touches).toHaveLength(1);
  });

  it("culls against on-screen radius: zooming in (scale > 1) reveals smaller files", () => {
    expect(computeFrame(makeState(files), 400, 400, 1).layout.has("tiny.txt")).toBe(false);
    expect(computeFrame(makeState(files), 400, 400, 1000).layout.has("tiny.txt")).toBe(true);
  });

  it("pads the root inside the viewport while keeping it centred", () => {
    const f = computeFrame(makeState(files), 1000, 800, 1, 48);
    const root = f.layout.get("")!;
    expect(root.x).toBeCloseTo(500);
    expect(root.y).toBeCloseTo(400);
    expect(root.r).toBeLessThanOrEqual(400 - 48);
  });

  it("never pads away more than half the viewport", () => {
    const root = computeFrame(makeState(files), 100, 100, 1, 500).layout.get("")!;
    expect(root.r).toBeGreaterThan(20);
  });
});
