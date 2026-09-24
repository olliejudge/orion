import { afterEach, describe, expect, it, vi } from "vitest";
import type { Circle } from "../layout/pack";
import type { Camera } from "./geometry";
import { DRAG_PX, MapNavigator, type NavHost } from "./navigate";

const root: Circle = { path: "", x: 500, y: 400, r: 360, depth: 0, isDir: true };

function setup(cam: Camera = { cx: 500, cy: 400, k: 4 }) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}) });
  const captured = new Set<number>();
  el.setPointerCapture = (id: number) => void captured.add(id);
  el.releasePointerCapture = (id: number) => void captured.delete(id);
  el.hasPointerCapture = (id: number) => captured.has(id);
  const views: { target: Camera; snap: boolean }[] = [];
  const clicks: MouseEvent[] = [];
  let doubles = 0;
  const host: NavHost = {
    camera: () => cam,
    aimed: () => cam,
    size: () => ({ width: 1000, height: 800 }),
    root: () => root,
    free: () => ({ x0: 0, y0: 0, x1: 1000, y1: 800 }),
    view: (target, _path, snap) => void views.push({ target, snap }),
    click: (ev) => void clicks.push(ev),
    doubleClick: () => void doubles++,
  };
  const nav = new MapNavigator(el, host);
  return { el, nav, views, clicks, captured, doubles: () => doubles };
}

const ptr = (type: string, x: number, y: number, buttons = 1, extra: PointerEventInit = {}) =>
  new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons, pointerId: 1, bubbles: true, cancelable: true, ...extra });

function press(el: HTMLElement, from: [number, number], to: [number, number]): void {
  el.dispatchEvent(ptr("pointerdown", ...from));
  el.dispatchEvent(ptr("pointermove", ...to));
  el.dispatchEvent(ptr("pointerup", ...to, 0));
}

const click = (el: HTMLElement, detail = 1) => el.dispatchEvent(new MouseEvent("click", { detail, bubbles: true }));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("MapNavigator: drag", () => {
  it("lets a press that moves less than the threshold click", () => {
    const { el, views, clicks } = setup();
    press(el, [100, 100], [100 + DRAG_PX - 1, 100]);
    click(el);
    expect(views).toEqual([]);
    expect(clicks).toHaveLength(1);
  });

  it("pans past the threshold and swallows the click that ends the drag, once", () => {
    const { el, nav, views, clicks } = setup();
    press(el, [100, 100], [140, 80]);
    expect(views.at(-1)).toEqual({ target: { cx: 490, cy: 405, k: 4 }, snap: true });
    expect(nav.dragging).toBe(false);
    click(el);
    expect(clicks).toHaveLength(0);
    click(el);
    expect(clicks).toHaveLength(1);
  });

  it("forgets a swallowed click on the next press (no click came after the drag)", () => {
    const { el, clicks } = setup();
    press(el, [100, 100], [140, 80]);
    press(el, [300, 300], [300, 300]);
    click(el);
    expect(clicks).toHaveLength(1);
  });

  it("captures the pointer from the press, and releases it on release", () => {
    const { el, captured } = setup();
    el.dispatchEvent(ptr("pointerdown", 100, 100));
    expect(captured.has(1)).toBe(true);
    el.dispatchEvent(ptr("pointerup", 100, 100, 0));
    expect(captured.has(1)).toBe(false);
  });

  it("does not pan with no button held after a release it never saw", () => {
    const { el, nav, views } = setup();
    el.dispatchEvent(ptr("pointerdown", 100, 100));
    // The release happened off the canvas: the next event is a plain hover.
    el.dispatchEvent(ptr("pointermove", 300, 300, 0));
    el.dispatchEvent(ptr("pointermove", 400, 300, 0));
    expect(views).toEqual([]);
    expect(nav.dragging).toBe(false);
  });

  it("ends the drag when capture is lost", () => {
    const { el, nav, views } = setup();
    el.dispatchEvent(ptr("pointerdown", 100, 100));
    el.dispatchEvent(ptr("pointermove", 200, 100));
    expect(nav.dragging).toBe(true);
    el.dispatchEvent(ptr("lostpointercapture", 200, 100, 0));
    expect(nav.dragging).toBe(false);
    const n = views.length;
    el.dispatchEvent(ptr("pointermove", 300, 100));
    expect(views).toHaveLength(n);
  });
});

describe("MapNavigator: clicks", () => {
  it("skips a double click's second click (the double click handles it)", () => {
    const { el, clicks } = setup();
    click(el, 1);
    click(el, 2);
    expect(clicks.map((e) => e.detail)).toEqual([1]);
  });

  it("forwards a double click, unless its second press was a drag", () => {
    const { el, doubles } = setup();
    press(el, [100, 100], [100, 100]);
    click(el, 1);
    press(el, [100, 100], [100, 100]);
    click(el, 2);
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(doubles()).toBe(1);

    press(el, [100, 100], [100, 100]);
    click(el, 1);
    press(el, [100, 100], [200, 160]); // click, then quickly drag from the same spot
    click(el, 2);
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(doubles()).toBe(1);
  });
});

describe("MapNavigator: wheel", () => {
  const wheel = (deltaY: number, ctrlKey = false) => new WheelEvent("wheel", { deltaY, ctrlKey, clientX: 500, clientY: 400, bubbles: true, cancelable: true });

  it("zooms about the pointer and blocks page scroll/zoom on the map only", () => {
    const { el, views } = setup({ cx: 500, cy: 400, k: 2 });
    const ev = wheel(-100);
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(views.at(-1)!.snap).toBe(false);
    expect(views.at(-1)!.target.k).toBeGreaterThan(2);

    const outside = wheel(-100);
    document.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(false);
    expect(views).toHaveLength(1);
  });

  it("zooms faster per pixel for a pinch (ctrl+wheel)", () => {
    const { el, views } = setup({ cx: 500, cy: 400, k: 2 });
    el.dispatchEvent(wheel(-10));
    el.dispatchEvent(wheel(-10, true));
    expect(views[1]!.target.k).toBeGreaterThan(views[0]!.target.k);
  });
});

describe("MapNavigator: destroy", () => {
  it("removes every listener", () => {
    const { el, nav, views, clicks, doubles } = setup();
    const spy = vi.spyOn(el, "removeEventListener");
    nav.destroy();
    const types = new Set(spy.mock.calls.map((c) => c[0]));
    for (const t of ["wheel", "pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "click", "dblclick"]) expect(types).toContain(t);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true }));
    press(el, [100, 100], [200, 200]);
    click(el);
    el.dispatchEvent(new MouseEvent("dblclick"));
    expect(views).toEqual([]);
    expect(clicks).toEqual([]);
    expect(doubles()).toBe(0);
  });
});
