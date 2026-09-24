import { describe, expect, it } from "vitest";
import type { Circle } from "../layout/pack";
import {
  arcLetterAngles,
  clipArc,
  dashArcs,
  fitCamera,
  fitLabel,
  glideOffset,
  labelNames,
  parentDir,
  pick,
  rimView,
  screenToWorld,
  splitSegments,
  worldToScreen,
  zoomPath,
} from "./geometry";

const c = (path: string, x: number, y: number, r: number, depth: number, isDir = true): Circle => ({ path, x, y, r, depth, isDir });

describe("pick", () => {
  const layout = new Map<string, Circle>([
    ["", c("", 100, 100, 100, 0)],
    ["src", c("src", 80, 100, 50, 1)],
    ["src/a.ts", c("src/a.ts", 70, 100, 10, 2, false)],
    ["docs", c("docs", 160, 100, 30, 1)],
  ]);

  it("returns the deepest circle containing the point", () => {
    expect(pick(layout, 72, 102)).toBe("src/a.ts");
    expect(pick(layout, 110, 100)).toBe("src");
    expect(pick(layout, 160, 100)).toBe("docs");
    expect(pick(layout, 100, 190)).toBe("");
  });

  it("returns null outside the root", () => {
    expect(pick(layout, 0, 0)).toBeNull();
  });

  it("prefers the smaller circle when depths tie", () => {
    const l = new Map<string, Circle>([
      ["a", c("a", 0, 0, 10, 1)],
      ["b", c("b", 1, 0, 5, 1)],
    ]);
    expect(pick(l, 1, 0)).toBe("b");
  });
});

describe("camera", () => {
  it("fits the root to identity", () => {
    expect(fitCamera(c("", 500, 400, 397, 0), 1000, 800)).toEqual({ cx: 500, cy: 400, k: 1 });
  });

  it("fits a circle to 90% of the short side, centred", () => {
    const cam = fitCamera(c("src", 300, 200, 40, 1), 1000, 800);
    expect(cam.cx).toBe(300);
    expect(cam.cy).toBe(200);
    expect(cam.k).toBeCloseTo((800 * 0.9) / 80);
  });

  it("fits and centres a circle in the free area when one is given", () => {
    const free = { x0: 0, y0: 0, x1: 680, y1: 800 };
    const cam = fitCamera(c("src", 300, 200, 40, 1), 1000, 800, free);
    expect(cam.k).toBeCloseTo((680 * 0.9) / 80);
    const at = worldToScreen(cam, 1000, 800, 300, 200);
    expect(at.x).toBeCloseTo(340);
    expect(at.y).toBeCloseTo(400);
    expect(fitCamera(c("", 340, 400, 300, 0), 1000, 800, free)).toEqual({ cx: 500, cy: 400, k: 1 });
  });

  it("caps the zoom factor", () => {
    expect(fitCamera(c("x", 0, 0, 0.001, 3), 1000, 800).k).toBe(1000);
  });

  it("round-trips screen ↔ world", () => {
    const cam = { cx: 300, cy: 200, k: 4 };
    const s = worldToScreen(cam, 1000, 800, 310, 190);
    expect(s).toEqual({ x: 540, y: 360 });
    expect(screenToWorld(cam, 1000, 800, s.x, s.y)).toEqual({ x: 310, y: 190 });
  });
});

describe("labels", () => {
  it("centres glyphs on the top of the circle, left to right", () => {
    const a = arcLetterAngles([10, 10, 10], 100);
    expect(a).toHaveLength(3);
    expect(a[1]).toBeCloseTo(-Math.PI / 2);
    expect(a[0]).toBeCloseTo(-Math.PI / 2 - 0.1);
    expect(a[2]).toBeCloseTo(-Math.PI / 2 + 0.1);
  });

  it("keeps all glyphs when the label fits, else truncates to leave room for an ellipsis", () => {
    expect(fitLabel([10, 10, 10], 100, 1, 5)).toBe(3);
    expect(fitLabel([10, 10, 10, 10, 10], 20, 1.5, 5)).toBe(2);
    expect(fitLabel([10, 10], 1, 1, 5)).toBe(0);
  });
});

describe("rings", () => {
  it("splits a full ring into equal segments starting at 12 o'clock with gaps", () => {
    expect(splitSegments(1, 0.1)).toEqual([[-Math.PI / 2, (3 * Math.PI) / 2]]);
    const s = splitSegments(2, 0.1);
    expect(s[0]![0]).toBeCloseTo(-Math.PI / 2 + 0.05);
    expect(s[0]![1]).toBeCloseTo(Math.PI / 2 - 0.05);
    expect(s[1]![0]).toBeCloseTo(Math.PI / 2 + 0.05);
  });

  it("covers an arc with dashes of the requested length", () => {
    const d = dashArcs(10, 4, 3, 0, Math.PI);
    expect(d.length).toBe(Math.ceil((Math.PI * 10) / 7));
    expect(d[0]![1] - d[0]![0]).toBeCloseTo(0.4);
    expect(d[1]![0]).toBeCloseTo(0.7);
    for (const [a0, a1] of d) {
      expect(a0).toBeLessThan(a1);
      expect(a1).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });
});

describe("dashArcs guards", () => {
  it("returns no dashes for a degenerate radius or pattern instead of looping", () => {
    expect(dashArcs(0, 4, 3, 0, Math.PI)).toEqual([]);
    expect(dashArcs(10, 0, 0, 0, Math.PI)).toEqual([]);
    expect(dashArcs(10, 2, -3, 0, Math.PI)).toEqual([]);
  });
});

describe("glideOffset", () => {
  it("is zero at the start and end, and bows sideways mid-way", () => {
    const g = { fromX: 0, fromY: 0, toX: 100, toY: 0 };
    const start = glideOffset(g, 0, 0);
    expect(start.x).toBeCloseTo(0);
    expect(start.y).toBeCloseTo(0);
    expect(glideOffset(g, 100, 0).y).toBeCloseTo(0);
    const mid = glideOffset(g, 50, 0);
    expect(Math.abs(mid.y)).toBeCloseTo(15);
    expect(mid.x).toBeCloseTo(0);
  });
});

describe("parentDir", () => {
  it("returns the containing directory ('' at the top level)", () => {
    expect(parentDir("src/lib/a.ts")).toBe("src/lib");
    expect(parentDir("a.ts")).toBe("");
    expect(parentDir("")).toBe("");
  });
});

describe("labelNames", () => {
  it("labels folders by name, skipping the root and collapsed folders", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 100, 0)],
      ["src", c("src", 0, 0, 50, 1)],
      ["src/a.ts", c("src/a.ts", 0, 0, 5, 2, false)],
      ["vendor", { ...c("vendor", 0, 0, 4, 1), aggregate: 12 }],
    ]);
    expect([...labelNames(l)]).toEqual([["src", "src"]]);
  });

  it("compresses single-folder chains onto the innermost folder", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 100, 0)],
      ["web", c("web", 0, 0, 50, 1)],
      ["web/src", c("web/src", 0, 0, 47, 2)],
      ["web/src/ui", c("web/src/ui", 0, 0, 44, 3)],
      ["web/src/ui/a.ts", c("web/src/ui/a.ts", 0, 0, 5, 4, false)],
      ["web/src/ui/b.ts", c("web/src/ui/b.ts", 0, 0, 5, 4, false)],
    ]);
    expect([...labelNames(l)]).toEqual([["web/src/ui", "web/src/ui"]]);
  });

  it("compresses a dominant child (r ≥ 0.85 × its parent's) into one label, deep chains included", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 200, 0)],
      ["a", c("a", 0, 0, 100, 1)],
      ["a/x.go", c("a/x.go", 0, 0, 3, 2, false)],
      ["a/b", c("a/b", 0, 0, 90, 2)],
      ["a/b/y.go", c("a/b/y.go", 0, 0, 3, 3, false)],
      ["a/b/c", c("a/b/c", 0, 0, 80, 3)],
      ["a/b/c/z.go", c("a/b/c/z.go", 0, 0, 3, 4, false)],
      ["a/b/c/d", c("a/b/c/d", 0, 0, 70, 4)],
      ["a/b/c/d/e.go", c("a/b/c/d/e.go", 0, 0, 20, 5, false)],
      ["a/b/c/d/f.go", c("a/b/c/d/f.go", 0, 0, 20, 5, false)],
    ]);
    expect([...labelNames(l)]).toEqual([["a/b/c/d", "a/b/c/d"]]);
  });

  it("gives a dominant child's small sibling folder only its own name", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 200, 0)],
      ["a", c("a", 0, 0, 100, 1)],
      ["a/big", c("a/big", 0, 0, 88, 2)],
      ["a/big/x.go", c("a/big/x.go", 0, 0, 30, 3, false)],
      ["a/tiny", c("a/tiny", 0, 0, 8, 2)],
      ["a/tiny/y.go", c("a/tiny/y.go", 0, 0, 3, 3, false)],
    ]);
    expect(new Map(labelNames(l))).toEqual(new Map([["a/big", "a/big"], ["a/tiny", "tiny"]]));
  });

  it("labels parent and child separately when the child is clearly smaller", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 200, 0)],
      ["a", c("a", 0, 0, 100, 1)],
      ["a/b", c("a/b", 0, 0, 84, 2)],
      ["a/b/x.go", c("a/b/x.go", 0, 0, 30, 3, false)],
      ["a/y.go", c("a/y.go", 0, 0, 10, 2, false)],
    ]);
    expect(new Map(labelNames(l))).toEqual(new Map([["a", "a"], ["a/b", "b"]]));
  });

  it("keeps a parent's label when its only child is a collapsed folder", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 100, 0)],
      ["lib", c("lib", 0, 0, 50, 1)],
      ["lib/deep", { ...c("lib/deep", 0, 0, 5, 2), aggregate: 3 }],
    ]);
    expect(labelNames(l).get("lib")).toBe("lib");
  });
});

describe("zoomPath", () => {
  it("scales about the point that keeps its screen position, ending exactly at the target", () => {
    const from = { cx: 500, cy: 400, k: 1 };
    const to = { cx: 700, cy: 250, k: 40 };
    const at = zoomPath(from, to)!;
    expect(at(1).cx).toBeCloseTo(500);
    expect(at(1).cy).toBeCloseTo(400);
    expect(at(40).cx).toBeCloseTo(700);
    expect(at(40).cy).toBeCloseTo(250);
    // The pivot (the world point at the same screen spot in both cameras)
    // stays put on screen at every intermediate scale.
    const px = (700 * 40 - 500 * 1) / 39;
    const py = (250 * 40 - 400 * 1) / 39;
    const s0 = worldToScreen(from, 1000, 800, px, py);
    for (const k of [2, 5, 13, 39]) {
      const s = worldToScreen({ ...at(k), k }, 1000, 800, px, py);
      expect(s.x).toBeCloseTo(s0.x);
      expect(s.y).toBeCloseTo(s0.y);
    }
  });

  it("is null when the scale barely changes (a pan)", () => {
    expect(zoomPath({ cx: 0, cy: 0, k: 2 }, { cx: 50, cy: 0, k: 2.01 })).toBeNull();
    expect(zoomPath({ cx: 0, cy: 0, k: Number.NaN }, { cx: 50, cy: 0, k: 2 })).toBeNull();
  });
});

describe("rimView", () => {
  const rect = { x0: 0, y0: 0, x1: 100, y1: 80 };

  it("is hidden when the circle misses the rect", () => {
    expect(rimView(300, 40, 50, rect)).toEqual({ kind: "hidden" });
    expect(rimView(-20, -20, 10, rect)).toEqual({ kind: "hidden" });
  });

  it("covers when the rect lies inside the circle", () => {
    expect(rimView(50, 40, 1000, rect)).toEqual({ kind: "covers" });
    expect(rimView(5000, 40, 1e6, rect)).toEqual({ kind: "covers" });
  });

  it("is full when the centre is inside the rect", () => {
    expect(rimView(50, 40, 30, rect)).toEqual({ kind: "full" });
  });

  it("gives the angles the rect spans, seen from an outside centre", () => {
    const v = rimView(50, 1040, 1000, rect);
    expect(v.kind).toBe("arc");
    if (v.kind !== "arc") return;
    // The rect is straight "up" (−π/2) from the centre, spanning its width.
    expect((v.a0 + v.a1) / 2).toBeCloseTo(-Math.PI / 2, 2);
    expect(v.a1 - v.a0).toBeGreaterThan(0.09);
    expect(v.a1 - v.a0).toBeLessThan(0.11);
  });

  it("unwraps a window that straddles ±π", () => {
    const v = rimView(1100, 40, 1050, rect);
    expect(v.kind).toBe("arc");
    if (v.kind !== "arc") return;
    expect(v.a0).toBeLessThan(Math.PI);
    expect(v.a1).toBeGreaterThan(Math.PI);
  });
});

describe("clipArc", () => {
  it("intersects an arc with a window, trying whole turns", () => {
    expect(clipArc(-Math.PI / 2, Math.PI, { a0: 0, a1: 0.5 })).toEqual([[0, 0.5]]);
    const shifted = clipArc(0, 1, { a0: 2 * Math.PI + 0.25, a1: 2 * Math.PI + 0.5 });
    expect(shifted).toHaveLength(1);
    expect(shifted[0]![0]).toBeCloseTo(0.25);
    expect(shifted[0]![1]).toBeCloseTo(0.5);
    expect(clipArc(0, 1, { a0: 2, a1: 3 })).toEqual([]);
  });

  it("returns both ends of a full ring when the window straddles its seam", () => {
    const parts = clipArc(-Math.PI / 2, (3 * Math.PI) / 2, { a0: -Math.PI / 2 - 0.1, a1: -Math.PI / 2 + 0.1 });
    expect(parts).toHaveLength(2);
    expect(parts[0]![0]).toBeCloseTo(-Math.PI / 2);
    expect(parts[0]![1]).toBeCloseTo(-Math.PI / 2 + 0.1);
    expect(parts[1]![0]).toBeCloseTo((3 * Math.PI) / 2 - 0.1);
    expect(parts[1]![1]).toBeCloseTo((3 * Math.PI) / 2);
  });
});
