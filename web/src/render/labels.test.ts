import { describe, expect, it } from "vitest";
import {
  COUNT_MIN_R,
  LABEL_LINE_PX,
  LABEL_MAX_SPAN,
  LABEL_MIN_R,
  NEXT_LABEL_MIN_R,
  countFontPx,
  digitCount,
  labelMinR,
  labelSpan,
  labelTier,
  nextLevels,
  placeCounts,
  placeLabels,
  straightWidth,
  type LabelCandidate,
  type LabelTier,
} from "./labels";

const cand = (path: string, x: number, y: number, r: number, width = 30, tier?: LabelTier): LabelCandidate => ({
  path,
  x,
  y,
  r,
  width,
  ...(tier ? { tier } : {}),
});

describe("labelSpan", () => {
  it("is the text's angle on the circle, capped at the maximum span", () => {
    expect(labelSpan(30, 60)).toBeCloseTo(0.5);
    expect(labelSpan(1000, 60)).toBe(LABEL_MAX_SPAN);
  });
});

describe("placeLabels", () => {
  it("sets every label on its own rim when nothing collides", () => {
    const spots = placeLabels([cand("a", 50, 100, 40), cand("b", 150, 100, 40)]);
    expect(spots.get("a")!.textR).toBe(40);
    expect(spots.get("b")!.textR).toBe(40);
    expect(spots.get("a")!.half).toBeCloseTo(30 / 40 / 2);
  });

  it("pushes a child folder tangent to its parent's top one line inward", () => {
    const spots = placeLabels([cand("p", 100, 100, 80), cand("p/c", 100, 60, 40)]);
    expect(spots.get("p")!.textR).toBe(80);
    expect(spots.get("p/c")).toMatchObject({ inset: 1, textR: 40 - LABEL_LINE_PX });
  });

  it("leaves a child alone when its rim is more than a line below the parent's", () => {
    const spots = placeLabels([cand("p", 100, 100, 80), cand("p/c", 100, 77, 40)]);
    expect(spots.get("p/c")!.textR).toBe(40);
  });

  it("leaves a child alone when the labels do not overlap sideways", () => {
    // Child touches the parent's top band but far to the side of the parent's short name.
    const spots = placeLabels([cand("p", 100, 100, 80, 10), cand("p/c", 160, 60, 40, 10)]);
    expect(spots.get("p/c")!.textR).toBe(40);
  });

  it("keeps the larger (outer) label and hides one that collides even when pushed in twice", () => {
    const spots = placeLabels([cand("b", 100, 100, 50, 120), cand("a", 100, 100, 50.5, 120)]);
    expect(spots.get("a")!.textR).toBe(50.5);
    expect(spots.has("b")).toBe(false);
  });

  it("pushes a third nested label two lines inward (deep chains)", () => {
    const spots = placeLabels([cand("a", 200, 200, 160), cand("a/b", 200, 180, 140), cand("a/b/c", 200, 160, 120)]);
    expect(spots.get("a")!.inset).toBe(0);
    expect(spots.get("a/b")!.inset).toBe(1);
    expect(spots.get("a/b/c")).toMatchObject({ inset: 2, textR: 120 - 2 * LABEL_LINE_PX });
  });

  it("hides a fourth label that would still collide after two inward steps", () => {
    const spots = placeLabels([
      cand("a", 200, 200, 160),
      cand("a/b", 200, 180, 140),
      cand("a/b/c", 200, 160, 120),
      cand("a/b/c/d", 200, 140, 100),
    ]);
    expect(spots.has("a/b/c/d")).toBe(false);
  });

  // The parent's band ends at y ≈ 26.90; the child's starts at cy − 40 − 5.5.
  it("treats text that nearly touches another label as a collision", () => {
    // Bands ~0.25 px and ~1 px apart: legible only when pushed in.
    expect(placeLabels([cand("p", 100, 100, 80), cand("p/c", 100, 72.65, 40)]).get("p/c")!.inset).toBe(1);
    expect(placeLabels([cand("p", 100, 100, 80), cand("p/c", 100, 73.4, 40)]).get("p/c")!.inset).toBe(1);
    expect(placeLabels([cand("p", 100, 100, 80), cand("p/c", 100, 74.8, 40)]).get("p/c")!.inset).toBe(1);
  });

  it("keeps a label on its rim once its band clears the other's by a few px", () => {
    // Bands ~3 px apart.
    expect(placeLabels([cand("p", 100, 100, 80), cand("p/c", 100, 75.4, 40)]).get("p/c")!.inset).toBe(0);
  });

  it("hides rather than pushing a label into a circle too small for it", () => {
    const spots = placeLabels([cand("p", 100, 100, 80), cand("p/c", 100, 45, 25)]);
    expect(spots.has("p/c")).toBe(false);
  });
});

describe("nextLevels / labelTier", () => {
  // Named folders as labelNames gives them: "app/src/features" is a compressed chain (app and app/src unnamed).
  const labels = new Map(
    ["app/src/features", "app/src/features/login", "app/src/features/login/form", "docs", "docs/guides", "lib"].map((p) => [p, p]),
  );

  it("at home is the top level, including a compressed chain as one level", () => {
    expect([...nextLevels(labels, "")].sort()).toEqual(["app/src/features", "docs", "lib"]);
  });

  it("inside a folder is its named children, skipping unnamed folders between", () => {
    expect([...nextLevels(labels, "docs")]).toEqual(["docs/guides"]);
    expect([...nextLevels(labels, "app/src/features")]).toEqual(["app/src/features/login"]);
    // A free zoom can focus an unnamed folder in a chain.
    expect([...nextLevels(labels, "app")]).toEqual(["app/src/features"]);
    expect(nextLevels(labels, "lib").size).toBe(0);
  });

  it("does not mistake a folder sharing a name prefix for a child", () => {
    const l = new Map([["doc", "doc"], ["docs", "docs"], ["docs/a", "a"]]);
    expect([...nextLevels(l, "doc")]).toEqual([]);
  });

  it("tiers: the view and its ancestors are outer, the next level next, everything else inner", () => {
    const next = nextLevels(labels, "app/src/features");
    expect(labelTier("app/src/features", "app/src/features", next)).toBe("outer");
    expect(labelTier("app", "app/src/features", next)).toBe("outer");
    expect(labelTier("app/src/features/login", "app/src/features", next)).toBe("next");
    expect(labelTier("app/src/features/login/form", "app/src/features", next)).toBe("inner");
    expect(labelTier("docs", "app/src/features", next)).toBe("inner");
  });

  it("names the next level from a much smaller size than deeper folders", () => {
    expect(labelMinR("next")).toBe(NEXT_LABEL_MIN_R);
    expect(labelMinR("inner")).toBe(LABEL_MIN_R);
    expect(labelMinR("outer")).toBe(LABEL_MIN_R);
    expect(NEXT_LABEL_MIN_R).toBeLessThan(LABEL_MIN_R / 2);
  });
});

describe("placeLabels: next level", () => {
  it("keeps an arc for a small next-level folder whose whole name fits on its rim", () => {
    const spots = placeLabels([cand("docs", 100, 100, 30, 25, "next")]);
    expect(spots.get("docs")).toMatchObject({ kind: "arc", inset: 0, textR: 30 });
  });

  it("sets a small next-level name straight across the folder where the arc would truncate it", () => {
    // 90 px of text on a 30 px rim would span 3 rad > LABEL_MAX_SPAN.
    const spot = placeLabels([cand("components", 100, 100, 30, 90, "next")]).get("components")!;
    expect(spot.kind).toBe("straight");
    expect(spot.maxWidth).toBe(straightWidth(30));
    expect(spot.box.x0).toBeLessThan(100 - 30);
    expect((spot.box.y0 + spot.box.y1) / 2).toBe(100);
  });

  it("sets a next-level name straight when the folder is too small for any arc", () => {
    expect(placeLabels([cand("db", 100, 100, NEXT_LABEL_MIN_R, 14, "next")]).get("db")!.kind).toBe("straight");
  });

  it("never sets a deeper folder's name straight, and truncates big folders' arcs as before", () => {
    expect(placeLabels([cand("deep", 100, 100, 20, 14)]).has("deep")).toBe(false);
    expect(placeLabels([cand("big", 100, 100, 60, 400, "next")]).get("big")!.kind).toBe("arc");
    expect(placeLabels([cand("big", 100, 100, 60, 400)]).get("big")!.kind).toBe("arc");
  });

  it("hides a straight label that would be mostly ellipsis, or collides", () => {
    // straightWidth(2) is 10 px: under the 24 px minimum.
    expect(placeLabels([cand("tiny", 100, 100, 2, 80, "next")]).has("tiny")).toBe(false);
    const spots = placeLabels([cand("a", 100, 100, 18, 40, "next"), cand("b", 110, 104, 18, 40, "next")]);
    expect(spots.size).toBe(1);
  });

  it("places the next level before larger deeper folders, and the view's own rim first", () => {
    const view = cand("app", 200, 200, 190, 30, "outer");
    // A deeper folder whose arc sits where a next-level folder's straight name goes.
    const deeper = cand("app/big/inner", 200, 170, 49, 60);
    const next = cand("app/small", 200, 120, 20, 60, "next");
    const spots = placeLabels([deeper, next, view]);
    expect(spots.get("app")!.inset).toBe(0);
    expect(spots.get("app/small")!.kind).toBe("straight");
    expect(spots.get("app/big/inner")!.inset).toBe(1); // pushed inward, clear of the next level's name
  });
});

describe("file counts on collapsed folders", () => {
  it("counts digits", () => {
    expect([0, 7, 10, 99, 421, 2497].map(digitCount)).toEqual([1, 1, 2, 2, 3, 4]);
  });

  it("shows a count from about 14 px across, when the number fits inside the disc", () => {
    expect(countFontPx(COUNT_MIN_R - 0.1, 1)).toBeNull();
    expect(countFontPx(COUNT_MIN_R, 2)).toBe(8);
    expect(countFontPx(COUNT_MIN_R, 3)).toBeNull();
    expect(countFontPx(9, 3)).toBe(8);
    expect(countFontPx(12, 4)).toBeNull();
    expect(countFontPx(14, 4)).toBe(10);
    expect(countFontPx(40, 4)).toBe(11);
  });

  it("hides a count that a placed name covers", () => {
    const spots = placeLabels([cand("lib", 100, 100, 20, 40, "next")]);
    const shown = placeCounts(
      [
        { path: "lib/vendor", x: 104, y: 102, digits: 2, font: 8 },
        { path: "lib/assets", x: 104, y: 113, digits: 2, font: 8 },
        { path: "other", x: 300, y: 300, digits: 3, font: 9 },
      ],
      spots,
    );
    expect([...shown]).toEqual(["other"]);
  });
});
