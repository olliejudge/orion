import { describe, expect, it } from "vitest";
import type { NodeVisual } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import { MapRenderer } from "./MapRenderer";

// jsdom has no WebGL, so init() is not called here. Drawing is verified by the
// Playwright smoke test (Task 14); this pins the pre-init contract the Svelte
// app relies on (update/zoom/destroy are safe before init resolves).
describe("MapRenderer (without WebGL)", () => {
  const circle = (path: string, x: number, y: number, r: number, depth: number, isDir: boolean): Circle => ({ path, x, y, r, depth, isDir });
  const layout = new Map<string, Circle>([
    ["", circle("", 500, 400, 397, 0, true)],
    ["src", circle("src", 400, 400, 100, 1, true)],
    ["src/a.ts", circle("src/a.ts", 400, 400, 10, 2, false)],
  ]);
  const visuals = new Map<string, NodeVisual>(
    [...layout.keys()].map((p) => [p, { path: p, ext: "ts", touches: [], ghost: false, deleted: false, tinted: false }]),
  );

  function host(): HTMLElement {
    const el = document.createElement("div");
    Object.defineProperty(el, "clientWidth", { value: 1000 });
    Object.defineProperty(el, "clientHeight", { value: 800 });
    return el;
  }

  it("reports the target zoom scale when zooming, and 1 when zooming back out", () => {
    const r = new MapRenderer(host());
    const scales: number[] = [];
    r.onZoom((k) => scales.push(k));
    r.update(layout, visuals, { kind: "snapshot", merged: [] });
    r.zoomTo("src");
    r.zoomTo("");
    r.zoomTo("does/not/exist");
    expect(scales[0]).toBeCloseTo((800 * 0.9) / 200);
    expect(scales.slice(1)).toEqual([1, 1]);
  });

  it("can be destroyed before init", () => {
    const r = new MapRenderer(host());
    expect(() => r.destroy()).not.toThrow();
  });
});
