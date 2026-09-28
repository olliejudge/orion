import { describe, expect, it } from "vitest";
import { worldToScreen } from "./geometry";
import { RECT_MAX_ZOOM, boxToScreen, rectClampPan, rectHome, rectPanBy, rectZoomAround } from "./rectCamera";

const W = 800;
const H = 600;
const free = { x0: 0, y0: 0, x1: W, y1: H };
const bounds = { x0: 0, y0: 0, x1: W, y1: H };
const home = rectHome(W, H);

describe("rect camera", () => {
  it("is the identity at home", () => {
    expect(boxToScreen(home, W, H, { x0: 10, y0: 20, x1: 30, y1: 60 })).toEqual({ x0: 10, y0: 20, x1: 30, y1: 60 });
  });

  it("zooms about the pointer, keeping the point under it still", () => {
    const { target, path } = rectZoomAround(home, home, 2, 200, 150, W, H, bounds, free);
    expect(target.k).toBe(2);
    expect(worldToScreen(target, W, H, 200, 150)).toEqual({ x: 200, y: 150 });
    expect(path).not.toBeNull();
    const mid = path!(1.5);
    expect(worldToScreen({ ...mid, k: 1.5 }, W, H, 200, 150).x).toBeCloseTo(200);
  });

  it("clamps the scale to [1, RECT_MAX_ZOOM]", () => {
    const deep = { cx: 400, cy: 300, k: RECT_MAX_ZOOM * 0.9 };
    expect(rectZoomAround(deep, deep, 2, 400, 300, W, H, bounds, free).target.k).toBe(RECT_MAX_ZOOM);
    const near = { cx: 300, cy: 200, k: 1.2 };
    expect(rectZoomAround(near, near, 0.5, 100, 100, W, H, bounds, free).target).toEqual(home);
  });

  it("keeps the content from being dragged off screen", () => {
    const zoomed = { cx: 400, cy: 300, k: 4 };
    const far = rectPanBy(zoomed, 1e5, -1e5, bounds, W, H, free);
    // Dragged far right and up, the free area's centre stops at the content's bottom-left corner.
    expect(far.cx).toBeCloseTo(bounds.x0);
    expect(far.cy).toBeCloseTo(bounds.y1);
    const near = rectPanBy(zoomed, 40, 0, bounds, W, H, free);
    expect(near).toEqual({ cx: 390, cy: 300, k: 4 });
    expect(rectClampPan(zoomed, undefined, W, H, free)).toBe(zoomed);
  });
});
