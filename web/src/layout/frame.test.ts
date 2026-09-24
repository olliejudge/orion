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

  it("keeps a tiny touched file visible beside a big sibling", () => {
    const f = computeFrame(makeState(files, { w1: [{ path: "tiny.txt", kind: "modified", stage: "committed", size: 1 }] }), 400, 400, 1);
    expect(f.layout.get("tiny.txt")!.r).toBeGreaterThanOrEqual(1.5);
    expect(f.visuals.get("tiny.txt")).toMatchObject({ tinted: true, touches: [{ worktree: "w1" }] });
  });

  it("keeps a tiny uncommitted add beside a subfolder as its own ghost", () => {
    const s = makeState({ "src/lib/big.bin": 10_000_000 }, { w2: [{ path: "src/new.ts", kind: "added", stage: "uncommitted", size: 1 }] });
    const f = computeFrame(s, 400, 400, 1);
    expect(f.layout.get("src/new.ts")!.r).toBeGreaterThanOrEqual(1.5);
    expect(f.visuals.get("src/new.ts")).toMatchObject({ ghost: true, touches: [{ worktree: "w2", stage: "uncommitted" }] });
  });

  it("carries a touched file in a collapsed folder on the aggregate, and keeps its touched sibling", () => {
    const s = makeState(
      { "big.bin": 50_000_000, "vendor/sub/f0.js": 10, "vendor/sub/f1.js": 10, "vendor/g.js": 10 },
      { w1: [{ path: "vendor/sub/f1.js", kind: "added", stage: "uncommitted", size: 10 }], w2: [{ path: "vendor/g.js", kind: "modified", stage: "committed", size: 10 }] },
    );
    const f = computeFrame(s, 400, 400, 1);
    expect(f.layout.get("vendor/sub")!.aggregate).toBe(2);
    expect(f.layout.has("vendor/sub/f1.js")).toBe(false);
    expect(f.visuals.get("vendor/sub")!.touches).toEqual([{ worktree: "w1", colorIndex: 1, stage: "uncommitted", kind: "modified" }]);
    expect(f.visuals.get("vendor/g.js")!.touches).toEqual([{ worktree: "w2", colorIndex: 2, stage: "committed", kind: "modified" }]);
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
