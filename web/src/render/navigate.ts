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
}

/**
 * Wheel / pinch zoom about the pointer and drag-to-pan on the map canvas.
 * Listeners sit on the canvas only, so the chrome panels still scroll.
 */
export class MapNavigator {
  #el: HTMLElement;
  #host: NavHost;
  #down: { id: number; x: number; y: number; start: Camera } | null = null;
  #dragging = false;
  #swallowClick = false;

  constructor(el: HTMLElement, host: NavHost) {
    this.#el = el;
    this.#host = host;
    el.addEventListener("wheel", this.#onWheel, { passive: false });
    el.addEventListener("pointerdown", this.#onDown);
    el.addEventListener("pointermove", this.#onMove);
    el.addEventListener("pointerup", this.#onUp);
    el.addEventListener("pointercancel", this.#onUp);
    el.style.cursor = "grab";
  }

  get dragging(): boolean {
    return this.#dragging;
  }

  /** True (once) for the click the browser fires at the end of a drag. */
  swallowClick(): boolean {
    const s = this.#swallowClick;
    this.#swallowClick = false;
    return s;
  }

  destroy(): void {
    const el = this.#el;
    el.removeEventListener("wheel", this.#onWheel);
    el.removeEventListener("pointerdown", this.#onDown);
    el.removeEventListener("pointermove", this.#onMove);
    el.removeEventListener("pointerup", this.#onUp);
    el.removeEventListener("pointercancel", this.#onUp);
  }

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
  };

  #onMove = (ev: PointerEvent): void => {
    const d = this.#down;
    if (!d || ev.pointerId !== d.id) return;
    const dx = ev.clientX - d.x;
    const dy = ev.clientY - d.y;
    if (!this.#dragging) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      this.#dragging = true;
      this.#el.setPointerCapture?.(ev.pointerId);
      this.#el.style.cursor = "grabbing";
    }
    const { width, height } = this.#host.size();
    this.#host.view(panBy(d.start, dx, dy, this.#host.root(), width, height, this.#host.free()), null, true);
  };

  #onUp = (ev: PointerEvent): void => {
    const d = this.#down;
    if (!d || ev.pointerId !== d.id) return;
    if (this.#dragging) {
      this.#swallowClick = ev.type === "pointerup";
      if (this.#el.hasPointerCapture?.(ev.pointerId)) this.#el.releasePointerCapture(ev.pointerId);
      this.#el.style.cursor = "grab";
    }
    this.#down = null;
    this.#dragging = false;
  };
}
