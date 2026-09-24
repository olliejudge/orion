import { describe, expect, it } from "vitest";
import type { Circle } from "../layout/pack";
import {
  arcLetterAngles,
  clickTarget,
  dashArcs,
  fitCamera,
  fitLabel,
  glideOffset,
  labelNames,
  parentDir,
  pick,
  screenToWorld,
  splitSegments,
  worldToScreen,
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

describe("clickTarget", () => {
  const layout = new Map<string, Circle>([
    ["", c("", 0, 0, 100, 0)],
    ["src", c("src", 0, 0, 50, 1)],
    ["src/lib", c("src/lib", 0, 0, 20, 2)],
    ["src/lib/a.ts", c("src/lib/a.ts", 0, 0, 5, 3, false)],
  ]);

  it("zooms into folders and to a file's folder", () => {
    expect(clickTarget("src", layout, "")).toBe("src");
    expect(clickTarget("src/lib/a.ts", layout, "")).toBe("src/lib");
  });

  it("steps out one level when the folder in view is clicked", () => {
    expect(clickTarget("src/lib", layout, "src/lib")).toBe("src");
    expect(clickTarget("", layout, "")).toBe("");
  });

  it("returns to the root for background clicks and unknown paths", () => {
    expect(clickTarget(null, layout, "src")).toBe("");
    expect(clickTarget("gone", layout, "src")).toBe("");
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

  it("keeps a parent's label when its only child is a collapsed folder", () => {
    const l = new Map<string, Circle>([
      ["", c("", 0, 0, 100, 0)],
      ["lib", c("lib", 0, 0, 50, 1)],
      ["lib/deep", { ...c("lib/deep", 0, 0, 5, 2), aggregate: 3 }],
    ]);
    expect(labelNames(l).get("lib")).toBe("lib");
  });
});
