import { describe, expect, it } from "vitest";
import { LABEL_LINE_PX, LABEL_MAX_SPAN, labelSpan, placeLabels, type LabelCandidate } from "./labels";

const cand = (path: string, x: number, y: number, r: number, width = 30): LabelCandidate => ({ path, x, y, r, width });

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
    const spots = placeLabels([cand("p", 100, 100, 80), cand("p/c", 100, 75, 40)]);
    expect(spots.get("p/c")!.textR).toBe(40);
  });

  it("leaves a child alone when the labels do not overlap sideways", () => {
    // Child touches the parent's top band but far to the side of the parent's short name.
    const spots = placeLabels([cand("p", 100, 100, 80, 10), cand("p/c", 160, 60, 40, 10)]);
    expect(spots.get("p/c")!.textR).toBe(40);
  });

  it("keeps the larger (outer) label and hides one that collides even when pushed in", () => {
    const spots = placeLabels([cand("b", 100, 100, 50, 60), cand("a", 100, 100, 50.5, 60)]);
    expect(spots.get("a")!.textR).toBe(50.5);
    expect(spots.has("b")).toBe(false);
  });

  it("hides rather than pushing a label into a circle too small for it", () => {
    const spots = placeLabels([cand("p", 100, 100, 80), cand("p/c", 100, 45, 25)]);
    expect(spots.has("p/c")).toBe(false);
  });
});
