import { describe, expect, it } from "vitest";
import { labelNames, parentDir } from "../render/geometry";
import { crumbs } from "../ui/nav";
import { makeState } from "./fixtures";
import { PARTITION_FOCUS_ROW_PX, PARTITION_ROW_PX, computeRectFrame, type RectKind } from "./rects";
import type { Box, Circle } from "./pack";

function repo(): Record<string, number> {
  const files: Record<string, number> = {};
  for (let d = 0; d < 5; d++) {
    for (let f = 0; f < 6; f++) files[`pkg${d}/file${f}.ts`] = 400 + ((d * 37 + f * 91) % 900);
    for (let f = 0; f < 4; f++) files[`pkg${d}/sub/deep/leaf${f}.ts`] = 300 + f * 50;
  }
  files["README.md"] = 800;
  return files;
}

const EPS = 1e-6;
function within(a: Box, b: Box): boolean {
  return a.x0 >= b.x0 - EPS && a.y0 >= b.y0 - EPS && a.x1 <= b.x1 + EPS && a.y1 <= b.y1 + EPS;
}

const kinds: RectKind[] = ["treemap", "partition"];

describe("computeRectFrame", () => {
  for (const kind of kinds) {
    it(`${kind}: nests every box in its parent and in the free area`, () => {
      const f = computeRectFrame(makeState(repo()), kind, "", 1000, 800, 40);
      const free = f.free;
      expect(f.layout.size).toBeGreaterThan(10);
      for (const c of f.layout.values()) {
        expect(c.box).toBeDefined();
        expect(within(c.box!, free)).toBe(true);
        expect(c.x).toBeCloseTo((c.box!.x0 + c.box!.x1) / 2);
        expect(c.r).toBeCloseTo(Math.min(c.box!.x1 - c.box!.x0, c.box!.y1 - c.box!.y0) / 2);
        if (c.path === "") continue;
        const parent = f.layout.get(parentDir(c.path))!;
        expect(parent).toBeDefined();
        if (kind === "treemap") expect(within(c.box!, parent.box!)).toBe(true);
        else {
          expect(c.box!.x0).toBeGreaterThanOrEqual(parent.box!.x0 - EPS);
          expect(c.box!.x1).toBeLessThanOrEqual(parent.box!.x1 + EPS);
          expect(c.box!.y0).toBeCloseTo(parent.box!.y1);
        }
      }
      expect([...f.visuals.keys()]).toEqual([...f.layout.keys()]);
    });

    it(`${kind}: fills the free area with the focus, with hidden ancestors for navigation`, () => {
      const f = computeRectFrame(makeState(repo()), kind, "pkg1/sub/deep", 1000, 800, { top: 40, right: 300, bottom: 40, left: 40 });
      const focus = f.layout.get("pkg1/sub/deep")!;
      expect(focus.hidden).toBeUndefined();
      expect(focus.depth).toBe(3);
      expect(focus.box!.x0).toBeCloseTo(f.free.x0);
      expect(focus.box!.x1).toBeCloseTo(f.free.x1);
      expect(focus.box!.y0).toBeCloseTo(f.free.y0);
      if (kind === "treemap") expect(focus.box!.y1).toBeCloseTo(f.free.y1);
      for (const [p, depth] of [["", 0], ["pkg1", 1], ["pkg1/sub", 2]] as const) {
        expect(f.layout.get(p)).toMatchObject({ hidden: true, isDir: true, depth, box: f.free });
      }
      expect(f.layout.get("pkg1/sub/deep/leaf0.ts")!.depth).toBe(4);
      expect(f.layout.has("pkg0")).toBe(false);
      const chain = crumbs("pkg1/sub/deep", f.layout, labelNames(f.layout), "repo");
      expect(chain[0]).toEqual({ path: "", label: "repo" });
      expect(chain.map((c) => c.path)).toEqual(["", "pkg1", "pkg1/sub", "pkg1/sub/deep"]); // hidden ancestors are levels of their own
      expect(crumbs("pkg1/sub/deep", f.layout, undefined, "repo").map((c) => c.path)).toEqual(["", "pkg1", "pkg1/sub", "pkg1/sub/deep"]);
    });
  }

  it("falls back to the nearest folder when the focus is a file or missing", () => {
    const s = makeState(repo());
    const f = computeRectFrame(s, "treemap", "pkg2/file0.ts", 800, 600);
    expect(f.layout.get("pkg2")!.hidden).toBeUndefined();
    expect(f.layout.get("pkg2")!.box).toEqual({ x0: 0, y0: 0, x1: 800, y1: 600 });
    expect(computeRectFrame(s, "partition", "nope/x", 800, 600).layout.get("")!.hidden).toBeUndefined();
  });

  it("returns just the focus for an empty repo", () => {
    const f = computeRectFrame(makeState({}), "treemap", "", 800, 600, 20);
    expect([...f.layout.values()]).toEqual([expect.objectContaining({ path: "", depth: 0, isDir: true, box: { x0: 20, y0: 20, x1: 780, y1: 580 } })]);
  });
});

describe("tree map", () => {
  const files = { "big.bin": 50_000_000, "vendor/sub/f0.js": 10, "vendor/sub/f1.js": 10, "vendor/g.js": 10, "tiny.txt": 1 };

  it("collapses tiny folders into aggregates with their file count", () => {
    const f = computeRectFrame(makeState(files), "treemap", "", 400, 400);
    const vendor = f.layout.get("vendor")!;
    expect(vendor.aggregate).toBe(3);
    expect(f.layout.has("vendor/sub")).toBe(false);
    expect(f.layout.has("vendor/g.js")).toBe(false);
    expect(f.layout.has("tiny.txt")).toBe(false);
    expect(f.layout.get("")!.aggregate).toBeUndefined();
  });

  it("keeps a tiny touched or lingering file", () => {
    const s = makeState(files, { w1: [{ path: "tiny.txt", kind: "modified", stage: "committed", size: 1 }] });
    expect(computeRectFrame(s, "treemap", "", 400, 400).layout.has("tiny.txt")).toBe(true);
    expect(computeRectFrame(makeState(files), "treemap", "", 400, 400, 0, new Set(["tiny.txt"])).layout.has("tiny.txt")).toBe(true);
  });

  it("never collapses the focus, however small", () => {
    const f = computeRectFrame(makeState(files), "treemap", "vendor/sub", 20, 20);
    expect(f.layout.get("vendor/sub")!.aggregate).toBeUndefined();
  });
});

describe("partition", () => {
  // Seven levels deep, so a 200 px tall area (7 rows max) cuts it.
  const deep: Record<string, number> = { "a/b/c/d/e/f/g/x.ts": 1000, "a/b/c/d/e/f/g/y.ts": 1000, "a/z.ts": 1000, "top.ts": 500 };

  it("keeps rows at least a row tall and folds folders at the cap into aggregates", () => {
    const f = computeRectFrame(makeState(deep), "partition", "", 600, 200);
    const maxRows = Math.floor(200 / PARTITION_ROW_PX);
    for (const c of f.layout.values()) {
      expect(c.box!.y1 - c.box!.y0).toBeGreaterThanOrEqual(PARTITION_ROW_PX - EPS);
      expect(c.depth).toBeLessThan(maxRows);
    }
    const cap = f.layout.get("a/b/c/d/e/f")!;
    expect(cap.depth).toBe(maxRows - 1);
    expect(cap.aggregate).toBe(2);
    expect(f.layout.has("a/b/c/d/e/f/g")).toBe(false);
    // The aggregate keeps its full width: it and "a/z.ts" span the same widths as the files beneath.
    const a = f.layout.get("a")!.box!;
    expect(cap.box!.x1 - cap.box!.x0).toBeCloseTo(((a.x1 - a.x0) * 2) / 3);
  });

  it("keeps the focus row short even when the focus holds files directly (they sit in the next row)", () => {
    const f = computeRectFrame(makeState(deep), "partition", "", 600, 800);
    const row = (800 - PARTITION_FOCUS_ROW_PX) / 8; // eight levels below the root, down to x.ts
    expect(f.layout.get("")!.box!.y1).toBeCloseTo(PARTITION_FOCUS_ROW_PX);
    expect(f.layout.get("top.ts")!.box).toMatchObject({ y0: expect.closeTo(PARTITION_FOCUS_ROW_PX), y1: expect.closeTo(PARTITION_FOCUS_ROW_PX + row) });
  });

  it("gives children at most their parent's width", () => {
    const f = computeRectFrame(makeState(repo()), "partition", "", 1000, 800);
    const widths = new Map<string, number>();
    for (const c of f.layout.values()) {
      if (c.path === "") continue;
      const p = parentDir(c.path);
      widths.set(p, (widths.get(p) ?? 0) + c.box!.x1 - c.box!.x0);
    }
    for (const [p, w] of widths) {
      const pb = f.layout.get(p)!.box!;
      expect(w).toBeLessThanOrEqual(pb.x1 - pb.x0 + EPS);
    }
  });

  it("drops narrow cells unless they are touched", () => {
    const files = { "big.bin": 50_000_000, "tiny.txt": 1 };
    expect(computeRectFrame(makeState(files), "partition", "", 400, 400).layout.has("tiny.txt")).toBe(false);
    const s = makeState(files, { w1: [{ path: "tiny.txt", kind: "modified", stage: "uncommitted", size: 1 }] });
    expect(computeRectFrame(s, "partition", "", 400, 400).layout.has("tiny.txt")).toBe(true);
  });

  it("uses absolute depths when the focus is nested", () => {
    const f = computeRectFrame(makeState(deep), "partition", "a/b", 600, 800);
    const byPath = (p: string): Circle => f.layout.get(p)!;
    expect(byPath("a/b").depth).toBe(2);
    expect(byPath("a/b/c").depth).toBe(3);
    expect(byPath("a/b/c/d/e/f/g/x.ts").depth).toBe(8);
    expect(byPath("a/b").box!.y0).toBeCloseTo(0);
    // a/b holds only a folder: its row is short, and the six rows below share the rest.
    expect(byPath("a/b").box!.y1).toBeCloseTo(PARTITION_FOCUS_ROW_PX);
    expect(byPath("a/b/c").box!.y0).toBeCloseTo(PARTITION_FOCUS_ROW_PX);
    const row = (800 - PARTITION_FOCUS_ROW_PX) / 6;
    expect(byPath("a/b/c").box!.y1).toBeCloseTo(PARTITION_FOCUS_ROW_PX + row);
    expect(byPath("a/b/c/d/e/f/g/x.ts").box!.y1).toBeCloseTo(800);
    expect(byPath("a").hidden).toBe(true);
    expect(f.layout.has("a/z.ts")).toBe(false);
  });
});
