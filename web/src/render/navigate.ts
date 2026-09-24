import type { Circle } from "../layout/pack";
import { panBy, wheelFactor, zoomAround, type CameraPath } from "./camera";
import type { Camera, Rect } from "./geometry";

/** A press that moves less than this (CSS px) is a click, not a drag. */
export const DRAG_PX = 4;

/** What the navigator needs from the renderer. */
export interface NavHost {
  camera(): Camera; // on screen now
  aimed(): Camera; // where the camera is heading
  size(): { width: number; height: number };
  root(): Circle | undefined;
  free(): Rect;
  /** Move the camera to `target` (along `path` if given); `snap` jumps there (drags follow the pointer 1:1). */
  view(target: Camera, path: CameraPath | null, snap: boolean): void;
  /** A real click: not the end of a drag, nor a double click's second click. */
  click(ev: MouseEvent): void;
  /** A double click whose presses were both clicks, not drags. */
  doubleClick(): void;
}

/**
 * Wheel / pinch zoom about the pointer, drag-to-pan, and the click /
 * double-click gating that goes with dragging, on the map canvas. Listeners
 * sit on the canvas only, so the chrome panels still scroll.
 */
export class MapNavigator {
  #el: HTMLElement;
  #host: NavHost;
  #down: { id: number; x: number; y: number; start: Camera } | null = null;
  #dragging = false;
  #swallowClick = false;
  #lastPressDragged = false;

  constructor(el: HTMLElement, host: NavHost) {
    this.#el = el;
    this.#host = host;
    el.addEventListener("wheel", this.#onWheel, { passive: false });
    el.addEventListener("pointerdown", this.#onDown);
    el.addEventListener("pointermove", this.#onMove);
    el.addEventListener("pointerup", this.#onUp);
    el.addEventListener("pointercancel", this.#onUp);
    el.addEventListener("lostpointercapture", this.#onUp);
    el.addEventListener("click", this.#onClick);
    el.addEventListener("dblclick", this.#onDblClick);
    el.style.cursor = "grab";
  }

  get dragging(): boolean {
    return this.#dragging;
  }

  destroy(): void {
    const el = this.#el;
    el.removeEventListener("wheel", this.#onWheel);
    el.removeEventListener("pointerdown", this.#onDown);
    el.removeEventListener("pointermove", this.#onMove);
    el.removeEventListener("pointerup", this.#onUp);
    el.removeEventListener("pointercancel", this.#onUp);
    el.removeEventListener("lostpointercapture", this.#onUp);
    el.removeEventListener("click", this.#onClick);
    el.removeEventListener("dblclick", this.#onDblClick);
  }

  #onClick = (ev: MouseEvent): void => {
    // The click the browser fires at the end of a drag is not a click.
    const swallow = this.#swallowClick;
    this.#swallowClick = false;
    if (swallow || ev.detail > 1) return; // a double click's second click is #onDblClick's
    this.#host.click(ev);
  };

  #onDblClick = (): void => {
    // A click then a quick drag from the same spot is a pan, not a double click.
    if (!this.#lastPressDragged) this.#host.doubleClick();
  };

  #onWheel = (ev: WheelEvent): void => {
    ev.preventDefault(); // no page zoom (pinch) or scroll over the map
    const factor = wheelFactor(ev, this.#host.size().height);
    if (factor === 1) return;
    const r = this.#el.getBoundingClientRect();
    const { width, height } = this.#host.size();
    const h = this.#host;
    const { target, path } = zoomAround(h.camera(), h.aimed(), factor, ev.clientX - r.left, ev.clientY - r.top, width, height, h.root(), h.free());
    h.view(target, path, false);
  };

  #onDown = (ev: PointerEvent): void => {
    this.#swallowClick = false;
    if (ev.button !== 0) return;
    this.#down = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, start: this.#host.camera() };
    this.#dragging = false;
    this.#lastPressDragged = false;
    // Capture from the press, so a release off the canvas (or over a panel) still ends it here.
    try {
      this.#el.setPointerCapture?.(ev.pointerId);
    } catch {
      // The pointer is already gone (e.g. released before this ran): #onMove checks the buttons too.
    }
  };

  #onMove = (ev: PointerEvent): void => {
    const d = this.#down;
    if (!d || ev.pointerId !== d.id) return;
    if ((ev.buttons & 1) === 0) {
      // The release was never delivered here: this is a hover, not a drag.
      this.#end(false);
      return;
    }
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    if (!this.#dragging) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      this.#dragging = true;
      this.#el.style.cursor = "grabbing";
    }
    const { width, height } = this.#host.size();
    this.#host.view(panBy(d.start, dx, dy, this.#host.root(), width, height, this.#host.free()), null, true);
  };

  /** pointerup, pointercancel or lostpointercapture. */
  #onUp = (ev: PointerEvent): void => {
    const d = this.#down;
    if (!d || ev.pointerId !== d.id) return;
    this.#end(ev.type === "pointerup");
  };

  /** Ends the press; `released` (a real pointerup) means a click event follows, which a drag swallows. */
  #end(released: boolean): void {
    const d = this.#down;
    if (!d) return;
    this.#down = null;
    if (this.#dragging) {
      this.#swallowClick = released;
      this.#lastPressDragged = true;
      this.#el.style.cursor = "grab";
    }
    this.#dragging = false;
    if (this.#el.hasPointerCapture?.(d.id)) this.#el.releasePointerCapture(d.id);
  }
}
