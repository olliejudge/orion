import { describe, expect, it } from "vitest";
import type { Circle } from "../layout/pack";
import { MIN_ZOOM, clampPan, focusFolder, follow, isHome, panBy, scrollZoomCap, wheelFactor, zoomAround } from "./camera";
import { MAX_ZOOM, fitCamera, screenToWorld, worldToScreen, type Camera, type Rect } from "./geometry";

const W = 1000;
const H = 800;
const FREE: Rect = { x0: 0, y0: 0, x1: W, y1: H };
const HOME: Camera = { cx: W / 2, cy: H / 2, k: 1 };
const root: Circle = { path: "", x: 500, y: 400, r: 360, depth: 0, isDir: true };

describe("zoomAround", () => {
  it("keeps the world point under the pointer fixed, at the target and all along the way", () => {
    const cur: Camera = { cx: 520, cy: 380, k: 2 };
    const before = screenToWorld(cur, W, H, 700, 300);
    const { target, path } = zoomAround(cur, cur, 1.5, 700, 300, W, H, root, FREE);
    expect(target.k).toBeCloseTo(3);
    const after = worldToScreen(target, W, H, before.x, before.y);
    expect(after.x).toBeCloseTo(700);
    expect(after.y).toBeCloseTo(300);
    expect(path).not.toBeNull();
    for (const k of [2, 2.4, 3]) {
      const mid = path!(k);
      const s = worldToScreen({ ...mid, k }, W, H, before.x, before.y);
      expect(s.x).toBeCloseTo(700);
      expect(s.y).toBeCloseTo(300);
    }
    // The path starts where the camera is, so nothing jumps.
    expect(path!(2).cx).toBeCloseTo(cur.cx);
    expect(path!(2).cy).toBeCloseTo(cur.cy);
  });

  it("accumulates on the target scale so quick wheel ticks add up", () => {
    const cur: Camera = { cx: 500, cy: 400, k: 2 };
    const aimed: Camera = { cx: 500, cy: 400, k: 4 };
    expect(zoomAround(cur, aimed, 2, 500, 400, W, H, root, FREE).target.k).toBeCloseTo(8);
  });

  it("clamps at MAX_ZOOM", () => {
    const cur: Camera = { cx: 500, cy: 400, k: MAX_ZOOM / 2 };
    expect(zoomAround(cur, cur, 10, 500, 400, W, H, root, FREE).target.k).toBe(MAX_ZOOM);
  });

  it("clamps at the content-aware cap under the pointer, tighter than MAX_ZOOM, with no jitter (repeated ticks stay capped)", () => {
    const layout = new Map<string, Circle>([
      ["", root],
      ["web", { path: "web", x: 500, y: 400, r: 10, depth: 1, isDir: true }],
    ]);
    const cur: Camera = { cx: 500, cy: 400, k: 1 };
    // fitCamera's own margin: 0.9 * the free area's short side (800), over 2*r (20).
    const cap = (800 * 0.9) / 20;
    expect(cap).toBeLessThan(MAX_ZOOM);
    const first = zoomAround(cur, cur, 100, 500, 400, W, H, root, FREE, layout);
    expect(first.target.k).toBeCloseTo(cap);
    const second = zoomAround(first.target, first.target, 100, 500, 400, W, H, root, FREE, layout);
    expect(second.target.k).toBeCloseTo(cap);
  });

  it("ignores the cap (falls back to MAX_ZOOM) with no layout, or nothing but the root under the pointer", () => {
    const cur: Camera = { cx: 500, cy: 400, k: MAX_ZOOM / 2 };
    expect(zoomAround(cur, cur, 10, 500, 400, W, H, root, FREE, new Map([["", root]])).target.k).toBe(MAX_ZOOM);
  });

  it("a zoom-in never zooms out: holds the current scale when the pointer already sits past the cap (moved off a small circle onto a bigger one, or a gap)", () => {
    const layout = new Map<string, Circle>([
      ["", root],
      ["web", { path: "web", x: 500, y: 400, r: 10, depth: 1, isDir: true }],
    ]);
    const cap = (800 * 0.9) / 20; // 36, see above
    const cur: Camera = { cx: 500, cy: 400, k: cap * 2 }; // already well past the cap for what's now under the pointer
    const { target } = zoomAround(cur, cur, 1.5, 500, 400, W, H, root, FREE, layout);
    expect(target.k).toBeCloseTo(cur.k);
  });

  it("still zooms out normally starting from above the cap", () => {
    const layout = new Map<string, Circle>([
      ["", root],
      ["web", { path: "web", x: 500, y: 400, r: 10, depth: 1, isDir: true }],
    ]);
    const cap = (800 * 0.9) / 20;
    const cur: Camera = { cx: 500, cy: 400, k: cap * 2 };
    const { target } = zoomAround(cur, cur, 0.1, 500, 400, W, H, root, FREE, layout);
    expect(target.k).toBeCloseTo(cur.k * 0.1);
    expect(target.k).toBeLessThan(cap);
  });

  it("zooming out past the whole repo returns to the home camera", () => {
    const cur: Camera = { cx: 600, cy: 300, k: 1.2 };
    const { target } = zoomAround(cur, cur, 0.5, 100, 100, W, H, root, FREE);
    expect(target).toEqual(HOME);
    expect(MIN_ZOOM).toBe(1);
  });
});

describe("scrollZoomCap", () => {
  const layout = new Map<string, Circle>([
    ["", root],
    ["web", { path: "web", x: 500, y: 400, r: 10, depth: 1, isDir: true }],
  ]);

  it("is the fit-scale of the deepest circle under the pointer", () => {
    const cur: Camera = { cx: 500, cy: 400, k: 1 };
    expect(scrollZoomCap(cur, 500, 400, W, H, FREE, layout)).toBeCloseTo((800 * 0.9) / 20);
  });

  it("falls back to MAX_ZOOM off the map, or with nothing but the root under the pointer", () => {
    const cur: Camera = { cx: 500, cy: 400, k: 1 };
    expect(scrollZoomCap(cur, 0, 0, W, H, FREE, layout)).toBe(MAX_ZOOM); // off the root entirely
    expect(scrollZoomCap(cur, 500, 400, W, H, FREE, new Map([["", root]]))).toBe(MAX_ZOOM); // only the root
  });
});

describe("clampPan / panBy", () => {
  it("leaves a camera whose view centre is over the repo alone", () => {
    const cam: Camera = { cx: 600, cy: 500, k: 3 };
    expect(clampPan(cam, root, W, H, FREE)).toEqual(cam);
  });

  it("keeps the free area's centre inside the root circle", () => {
    const c = clampPan({ cx: 500 + 2000, cy: 400, k: 2 }, root, W, H, FREE);
    expect(c.cx).toBeCloseTo(500 + 360);
    expect(c.cy).toBeCloseTo(400);
    expect(c.k).toBe(2);
  });

  it("measures from the free area's centre, not the viewport's", () => {
    const free: Rect = { x0: 0, y0: 0, x1: 700, y1: 800 }; // a side panel on the right
    // At k = 1, the free centre (350, 400) sees world (350, 400) at camera (500, 400).
    const c = clampPan({ cx: 500 + 1000, cy: 400, k: 1 }, { ...root, x: 350 }, W, H, free);
    expect(c.cx - 150).toBeCloseTo(350 + 360);
  });

  it("pans by screen pixels, dragging the world with the pointer", () => {
    const start: Camera = { cx: 500, cy: 400, k: 4 };
    const c = panBy(start, 40, -20, root, W, H, FREE);
    expect(c).toEqual({ cx: 490, cy: 405, k: 4 });
    const far = panBy(start, -1e6, 0, root, W, H, FREE);
    expect(far.cx).toBeCloseTo(500 + 360);
  });

  it("does nothing without a root", () => {
    const cam: Camera = { cx: 1e6, cy: 0, k: 2 };
    expect(clampPan(cam, undefined, W, H, FREE)).toEqual(cam);
  });
});

describe("wheelFactor", () => {
  const ev = (deltaY: number, over: Partial<{ deltaMode: number; ctrlKey: boolean }> = {}) => ({ deltaY, deltaMode: 0, ctrlKey: false, ...over });

  it("zooms in for wheel up / pinch out and out for the opposite", () => {
    expect(wheelFactor(ev(-100), H)).toBeGreaterThan(1);
    expect(wheelFactor(ev(100), H)).toBeLessThan(1);
    expect(wheelFactor(ev(0), H)).toBe(1);
  });

  it("is symmetric, and pinches (ctrl) zoom faster per pixel", () => {
    expect(wheelFactor(ev(-50), H) * wheelFactor(ev(50), H)).toBeCloseTo(1);
    expect(wheelFactor(ev(-5, { ctrlKey: true }), H)).toBeGreaterThan(wheelFactor(ev(-5), H));
  });

  it("normalises line and page deltas, and caps a single event", () => {
    expect(wheelFactor(ev(-3, { deltaMode: 1 }), H)).toBeCloseTo(wheelFactor(ev(-48), H));
    expect(wheelFactor(ev(-1e6), H)).toBeLessThanOrEqual(2);
  });
});

describe("focusFolder", () => {
  const c = (path: string, x: number, y: number, r: number, depth: number, isDir = true): Circle => ({ path, x, y, r, depth, isDir });
  const layout = new Map<string, Circle>([
    ["", c("", 500, 400, 360, 0)],
    ["web", c("web", 400, 400, 200, 1)],
    ["web/src", c("web/src", 380, 400, 120, 2)],
    ["web/src/a.ts", c("web/src/a.ts", 380, 400, 100, 3, false)],
    ["docs", c("docs", 750, 400, 80, 1)],
  ]);

  it("is the root at the home camera", () => {
    expect(focusFolder(layout, HOME, W, H, FREE)).toBe("");
  });

  it("is the root at the home camera even when a folder dominates the repo", () => {
    // big spans 2*300 = 600 px of the 800 px short side (75%) at k = 1.
    const dominated = new Map<string, Circle>([
      ["", c("", 500, 400, 360, 0)],
      ["big", c("big", 480, 400, 300, 1)],
    ]);
    expect(focusFolder(dominated, HOME, W, H, FREE)).toBe("");
    // Scrolling fully out lands exactly on the home camera.
    const cur: Camera = { cx: 480, cy: 400, k: 1.3 };
    const out = zoomAround(cur, cur, 0.5, 500, 400, W, H, dominated.get(""), FREE, dominated);
    expect(focusFolder(dominated, out.target, W, H, FREE)).toBe("");
    expect(focusFolder(dominated, { ...HOME, k: 1.2 }, W, H, FREE)).toBe("big");
  });

  it("keeps a near-full-size folder in focus when it is fitted at about the home scale, and when panned", () => {
    // A folder nearly as big as the repo: its fit camera's scale is under 1.05 (here under 1).
    const nearFull = new Map<string, Circle>([
      ["", c("", 500, 400, 397, 0)],
      ["app", c("app", 500, 400, 390, 1)],
      ["app/src", c("app/src", 500, 400, 100, 2)],
    ]);
    const fitted = fitCamera(nearFull.get("app")!, W, H, FREE);
    expect(fitted.k).toBeLessThan(1.05);
    expect(focusFolder(nearFull, fitted, W, H, FREE)).toBe("app");
    expect(focusFolder(nearFull, { ...fitted, cx: fitted.cx + 20 }, W, H, FREE)).toBe("app");
    expect(isHome(fitted, W, H)).toBe(false);
    expect(isHome(HOME, W, H)).toBe(true);
  });

  it("is the deepest folder under the view centre that fills most of the view", () => {
    // web fills 2*200*2 = 800 px of the 800 px short side; web/src fills 480 px (60%): too small.
    expect(focusFolder(layout, { cx: 400, cy: 400, k: 2 }, W, H, FREE)).toBe("web");
    expect(focusFolder(layout, { cx: 380, cy: 400, k: 4 }, W, H, FREE)).toBe("web/src");
  });

  it("ignores files and folders not under the view centre", () => {
    expect(focusFolder(layout, { cx: 380, cy: 400, k: 40 }, W, H, FREE)).toBe("web/src");
    expect(focusFolder(layout, { cx: 600, cy: 150, k: 3 }, W, H, FREE)).toBe("");
  });
});

describe("follow", () => {
  it("keeps the same part of the focused folder in view when it moves and grows", () => {
    const was: Circle = { path: "web", x: 400, y: 400, r: 100, depth: 1, isDir: true };
    const now: Circle = { ...was, x: 300, y: 450, r: 200 };
    const cam: Camera = { cx: 420, cy: 390, k: 4 };
    const next = follow(cam, was, now);
    expect(next).toEqual({ cx: 340, cy: 430, k: 2 });
    // The folder's rim point on screen stays put.
    const before = worldToScreen(cam, W, H, was.x + was.r, was.y);
    const after = worldToScreen(next, W, H, now.x + now.r, now.y);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});
