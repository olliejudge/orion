import { describe, expect, it } from "vitest";
import { makeState } from "./fixtures";
import { computeFrame, packedFor } from "./frame";
import { buildTree } from "./nodes";
import { cullLayout, packTree } from "./pack";

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

  it("centres the root in the free area left by per-side insets", () => {
    const f = computeFrame(makeState(files), 1000, 800, 1, { top: 48, right: 320, bottom: 48, left: 48 });
    const root = f.layout.get("")!;
    expect(root.x).toBeCloseTo(48 + 632 / 2);
    expect(root.y).toBeCloseTo(400);
    expect(root.r).toBeLessThanOrEqual(632 / 2);
    expect(f.free).toEqual({ x0: 48, y0: 48, x1: 680, y1: 752 });
  });

  it("reports the free area for a scalar pad too", () => {
    expect(computeFrame(makeState(files), 1000, 800, 1, 48).free).toEqual({ x0: 48, y0: 48, x1: 952, y1: 752 });
    expect(computeFrame(makeState(files), 1000, 800, 1).free).toEqual({ x0: 0, y0: 0, x1: 1000, y1: 800 });
  });

  it("never insets away more than half the viewport on either axis", () => {
    const f = computeFrame(makeState(files), 400, 400, 1, { top: 0, right: 600, bottom: 0, left: 200 });
    expect(f.free.x1 - f.free.x0).toBeCloseTo(200);
    expect(f.free.x0).toBeCloseTo(50);
  });

  it("never pads away more than half the viewport", () => {
    const root = computeFrame(makeState(files), 100, 100, 1, 500).layout.get("")!;
    expect(root.r).toBeGreaterThan(20);
  });

  it("keeps lingering paths (just merged, shimmering) in the cull like touched files", () => {
    const f = computeFrame(makeState(files), 400, 400, 1, 0, new Set(["tiny.txt", "not/in/tree.ts"]));
    expect(f.layout.get("tiny.txt")!.r).toBeGreaterThanOrEqual(1.5);
    expect(f.visuals.get("tiny.txt")!.touches).toEqual([]);
    expect(f.layout.has("not/in/tree.ts")).toBe(false);
  });

  it("drops an excluded directory and its files entirely from the layout", () => {
    const s = makeState({ "src/a.ts": 100, "docs/guide.md": 5000 });
    const f = computeFrame(s, 400, 400, 1, 0, undefined, new Set(["docs"]));
    expect(f.layout.has("docs")).toBe(false);
    expect(f.layout.has("docs/guide.md")).toBe(false);
    expect(f.layout.has("src")).toBe(true);
  });

  it("leaves a hidden subdirectory's files out of a collapsed sibling's aggregate", () => {
    const s = makeState({ "big.bin": 50_000_000, "vendor/sub/f0.js": 10, "vendor/sub/f1.js": 10, "vendor/sub/hide/f2.js": 10, "vendor/g.js": 10 });
    // With `hide` present, vendor/sub still nests a directory, so it stays expanded rather than collapsing.
    expect(computeFrame(s, 400, 400, 1).layout.get("vendor/sub")?.aggregate).toBeUndefined();
    // Excluding it leaves only the two plain files, small enough to collapse; the hidden file isn't counted.
    const withoutHide = computeFrame(s, 400, 400, 1, 0, undefined, new Set(["vendor/sub/hide"])).layout.get("vendor/sub")!.aggregate;
    expect(withoutHide).toBe(2);
  });
});

// Each patch makes a new RepoState, but most patches (an edit that stays in
// its size bucket, a new stage) leave the packed geometry unchanged.
describe("pack reuse across states", () => {
  it("reuses the pack when the node set and every size bucket are unchanged", () => {
    const a = packedFor(makeState({ "a.ts": 100, "src/b.ts": 200 }), 400, 400);
    const b = packedFor(makeState({ "a.ts": 101, "src/b.ts": 200 }, { w1: [{ path: "src/b.ts", kind: "modified", stage: "committed", size: 201 }] }), 400, 400);
    expect(b).toBe(a);
  });

  it("re-packs when a size bucket, the node set or the viewport changes", () => {
    const a = packedFor(makeState({ "a.ts": 100, "src/b.ts": 200 }), 400, 400);
    expect(packedFor(makeState({ "a.ts": 400, "src/b.ts": 200 }), 400, 400)).not.toBe(a);
    const c = packedFor(makeState({ "a.ts": 100, "src/b.ts": 200 }), 400, 400);
    expect(packedFor(makeState({ "a.ts": 100, "src/b.ts": 200 }, { w1: [{ path: "src/c.ts", kind: "added", stage: "uncommitted", size: 5 }] }), 400, 400)).not.toBe(c);
    const d = packedFor(makeState({ "a.ts": 100, "src/b.ts": 200 }), 400, 400);
    expect(packedFor(makeState({ "a.ts": 100, "src/b.ts": 200 }), 500, 400)).not.toBe(d);
  });

  it("re-packs when the excluded set changes on the very same state", () => {
    const s = makeState({ "a.ts": 100, "src/b.ts": 200 });
    const a = packedFor(s, 400, 400);
    const withExclusion = packedFor(s, 400, 400, new Set(["src"]));
    expect(withExclusion).not.toBe(a);
    expect(withExclusion.node?.leaves().some((l) => l.data.path === "src/b.ts")).toBe(false);
    // Same state, same exclusion again (no other call in between): the single-slot pack cache reuses it.
    expect(packedFor(s, 400, 400, new Set(["src"]))).toBe(withExclusion);
  });

  it("culls a reused pack with the current state's touched files", () => {
    const files = { "big.bin": 10_000_000, "tiny.txt": 1 };
    const untouched = makeState(files);
    const touched = makeState(files, { w1: [{ path: "tiny.txt", kind: "modified", stage: "committed", size: 1 }] });
    expect(computeFrame(touched, 400, 400, 1).layout.has("tiny.txt")).toBe(true);
    expect(computeFrame(untouched, 400, 400, 1).layout.has("tiny.txt")).toBe(false);
    expect(computeFrame(touched, 400, 400, 1).layout.has("tiny.txt")).toBe(true);
    const cold = cullLayout(packTree(buildTree(touched), 400, 400));
    expect([...computeFrame(touched, 400, 400, 1).layout]).toEqual([...cold]);
  });
});
