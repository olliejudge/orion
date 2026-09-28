import { describe, expect, it } from "vitest";
import type { Box, Circle } from "../layout/pack";
import { capLabels, dashPolyline, fitText, focusOf, inset, perimeterSegments, pickBox } from "./rectGeometry";

const B = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });
const entry = (path: string, box: Box, over: Partial<Circle> = {}): [string, Circle] => [
  path,
  { path, x: 0, y: 0, r: 0, depth: path === "" ? 0 : path.split("/").length, isDir: false, box, ...over },
];

const length = (pts: readonly (readonly [number, number])[]): number =>
  pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]), 0);

describe("rect geometry", () => {
  it("insets a box without turning it inside out", () => {
    expect(inset(B(0, 0, 10, 4), 1)).toEqual(B(1, 1, 9, 3));
    expect(inset(B(0, 0, 10, 4), 5)).toEqual(B(5, 2, 5, 2));
    expect(inset(B(0, 0, 10, 4), -2)).toEqual(B(-2, -2, 12, 6));
  });

  it("splits a perimeter into equal runs that turn at the corners", () => {
    const whole = perimeterSegments(B(0, 0, 10, 20), 1);
    expect(whole).toHaveLength(1);
    expect(length(whole[0]!)).toBeCloseTo(60);
    expect(whole[0]!).toContainEqual([10, 0]);
    const two = perimeterSegments(B(0, 0, 10, 20), 2, 4);
    expect(two).toHaveLength(2);
    for (const run of two) expect(length(run)).toBeCloseTo(26); // 30 each, less the 4 px gap
    expect(two[0]![0]).toEqual([2, 0]);
    expect(two[0]!).toContainEqual([10, 0]);
    expect(two[0]!.at(-1)).toEqual([10, 18]);
    expect(perimeterSegments(B(0, 0, 0, 0), 2)).toEqual([]);
  });

  it("dashes a polyline, carrying the phase round corners", () => {
    const lines = dashPolyline([[0, 0], [5, 0], [5, 5]], 4, 2);
    expect(lines).toEqual([
      [0, 0, 4, 0],
      [5, 1, 5, 5],
    ]);
  });

  it("fits text to a width, with an ellipsis when cut", () => {
    const measure = (s: string): number => s.length * 5;
    expect(fitText("hello", 30, measure)).toBe("hello");
    expect(fitText("hello world", 30, measure)).toBe("hello…");
    expect(fitText("hello", 5, measure)).toBeNull();
  });

  it("picks the smallest non-hidden box under the point", () => {
    const layout = new Map([
      entry("", B(0, 0, 100, 100), { isDir: true, hidden: true }),
      entry("src", B(0, 0, 100, 100), { isDir: true }),
      entry("src/a.ts", B(10, 10, 30, 30)),
    ]);
    expect(pickBox(layout, 20, 20)).toBe("src/a.ts");
    expect(pickBox(layout, 50, 50)).toBe("src");
    expect(pickBox(layout, 150, 50)).toBeNull();
    expect(focusOf(layout)).toBe("src");
  });

  it("keeps the best-ranked labels up to the cap", () => {
    const got = capLabels([{ path: "c", rank: 2 }, { path: "a", rank: 0 }, { path: "b", rank: 2 }], 2);
    expect(got.map((l) => l.path)).toEqual(["a", "c"]);
  });
});
