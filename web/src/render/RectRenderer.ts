import { Application, CanvasTextMetrics, Container, Graphics, Text, TextStyle } from "pixi.js";
import type { NodeVisual } from "../layout/encoding";
import type { Box, Circle } from "../layout/pack";
import type { WorktreeId } from "../protocol";
import type { Change } from "../store";
import { AGE_TICK_MS, BREATH_FPS } from "./MapRenderer";
import type { FreeArea } from "../layout/frame";
import { motionPolicy, watchReducedMotion, type Motion } from "./motion";
import { boxH, boxW, capLabels, dashPolyline, fitText, focusOf, inset, perimeterSegments, pickBox, type LabelWant } from "./rectGeometry";
import { RectScene, type RectNode } from "./rectScene";
import {
  DELETED_RIM_W_PX,
  GLYPH_ARM,
  GLYPH_STROKE,
  aggregateLook,
  countColor,
  fileLook,
  glyphSize,
  type AggregateLook,
  type FileLook,
  type Glyph,
  type Rings,
  type Theme,
} from "./style";
import type { MapView } from "./view";

export type RectKind = "treemap" | "partition";

export interface RectRendererOptions {
  /** Tree map: the height of a folder's name strip, CSS px (the layout's header constant). Default 18. */
  headerPx?: number;
}

const FILE_INSET_PX = 0.5; // half the 1 px gap between neighbouring files
const GLOW_PX = 2.5; // live glow: a soft border this wide outside the box
const SPLIT_GAP_PX = 3;
const DASH_PX = 4;
const DASH_GAP_PX = 3;
const PING_REACH_PX = 10; // a ping's outline travels this far out (times the motion's reach)
const LABEL_FONT_PX = 11;
const LABEL_PAD_PX = 4;
const MAX_LABELS = 400;
/** A folder's name shows when its box is at least this wide. */
export const FOLDER_LABEL_MIN_W = 36;
/** A file's name shows when its box is at least this big. */
export const FILE_LABEL_MIN_W = 60;
export const FILE_LABEL_MIN_H = 16;

interface Label {
  text: Text;
  key: string; // name|width bucket|colour: the fitted text is recomputed when it changes
}

interface LabelSpot extends LabelWant {
  name: string;
  x: number;
  y: number;
  anchorX: number;
  maxWidth: number;
  color: string;
}

/**
 * Pixi v8 renderer for the rectangle views (tree map, partition). All
 * animation state lives in RectScene (pure, unit-tested); there is no camera,
 * since App hands over a new layout per folder in view and boxes spring to it.
 *
 * Two Graphics layers keep thousands of boxes cheap: `base` holds every box
 * and is redrawn only when something changed (layout, looks, theme,
 * isolation, the age tick, or boxes moving), and `fx` holds what changes
 * every frame (breathing glows, pings, shimmer, the highlight). Labels are
 * pooled Pixi Text per path, refitted when the boxes come to rest.
 */
export class RectRenderer implements MapView {
  #host: HTMLElement;
  #kind: RectKind;
  #headerPx: number;
  #app: Application | null = null;
  #destroyed = false;

  #base = new Graphics();
  #labelLayer = new Container();
  #fx = new Graphics();

  #scene = new RectScene();
  #layout = new Map<string, Circle>();
  #focus: string | null = null;
  #labels = new Map<string, Label>();
  #widths = new Map<string, number>();
  #style = new TextStyle({ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif', fontWeight: "500", fontSize: LABEL_FONT_PX });

  #theme: Theme = "vision";
  #isolated: WorktreeId | null = null;
  #highlighted: string | null = null;
  #styleGen = 0;
  #clock = Date.now();
  #ageGen = 0;
  #ageTimer: ReturnType<typeof setInterval> | null = null;
  #looks = new WeakMap<NodeVisual, { gen: number; ageGen: number; agg: boolean; look: FileLook | AggregateLook }>();

  #dirty = true; // the base layer needs a redraw
  #wasMoving = false;
  #fxNodes: RectNode[] = []; // nodes that may glow, ping or shimmer (collected at the last base redraw)

  #hoverFns: ((path: string | null, screen: { x: number; y: number }) => void)[] = [];
  #clickFns: ((path: string | null) => void)[] = [];
  #dblFns: ((path: string | null) => void)[] = [];
  #firstPick: string | null = null;
  #lastHover: string | null = null;
  #idleFrames = 0;
  #breathing = false;
  #motion: Motion = motionPolicy(false);
  #stopMotionWatch = (): void => {};

  constructor(host: HTMLElement, kind: RectKind, opts: RectRendererOptions = {}) {
    this.#host = host;
    this.#kind = kind;
    this.#headerPx = opts.headerPx ?? 18;
  }

  async init(): Promise<void> {
    const app = new Application();
    await app.init({
      resizeTo: this.#host,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: "webgl",
    });
    if (this.#destroyed) {
      app.destroy(true);
      return;
    }
    this.#app = app;
    this.#host.appendChild(app.canvas);
    app.canvas.style.display = "block";
    app.canvas.style.cursor = "default";
    app.stage.addChild(this.#base, this.#labelLayer, this.#fx);
    app.canvas.addEventListener("pointermove", this.#onPointerMove);
    app.canvas.addEventListener("pointerleave", this.#onPointerLeave);
    app.canvas.addEventListener("click", this.#onClick);
    app.canvas.addEventListener("dblclick", this.#onDblClick);
    app.renderer.on("resize", this.#onResize);
    app.ticker.add((t) => this.#frame(t.deltaMS));
    // The ticker stops when idle, so ageing needs its own slow clock.
    this.#ageTimer = setInterval(() => {
      this.#clock = Date.now();
      this.#ageGen++;
      this.#invalidate();
    }, AGE_TICK_MS);
    this.#stopMotionWatch = watchReducedMotion((reduced) => {
      this.#motion = motionPolicy(reduced);
      this.#invalidate();
    });
    this.#invalidate();
  }

  update(layout: Map<string, Circle>, visuals: Map<string, NodeVisual>, change: Change): void {
    this.#layout = layout;
    this.#focus = focusOf(layout);
    this.#scene.update(layout, visuals, change, performance.now());
    this.#clock = Date.now();
    this.#invalidate();
  }

  setTheme(t: Theme): void {
    if (t === this.#theme) return;
    this.#theme = t;
    this.#styleGen++;
    this.#invalidate();
  }

  isolate(worktree: WorktreeId | null): void {
    this.#isolated = worktree;
    this.#styleGen++;
    this.#invalidate();
  }

  highlight(path: string | null): void {
    this.#highlighted = path;
    this.#wake();
  }

  // No camera: App zooms by handing over a new layout.
  zoomTo(_path: string): void {}
  setFreeArea(_rect: FreeArea): void {}
  onZoom(_fn: (scale: number) => void): void {}
  onFocus(_fn: (path: string) => void): void {}

  onHover(fn: (path: string | null, screen: { x: number; y: number }) => void): void {
    this.#hoverFns.push(fn);
  }

  onClick(fn: (path: string | null) => void): void {
    this.#clickFns.push(fn);
  }

  /** Fires on a double click with the path under its first click (null: the background). */
  onDoubleClick(fn: (path: string | null) => void): void {
    this.#dblFns.push(fn);
  }

  destroy(): void {
    this.#destroyed = true;
    const app = this.#app;
    if (!app) return;
    this.#stopMotionWatch();
    if (this.#ageTimer !== null) clearInterval(this.#ageTimer);
    app.canvas.removeEventListener("pointermove", this.#onPointerMove);
    app.canvas.removeEventListener("pointerleave", this.#onPointerLeave);
    app.canvas.removeEventListener("click", this.#onClick);
    app.canvas.removeEventListener("dblclick", this.#onDblClick);
    app.renderer.off("resize", this.#onResize);
    this.#labels.clear();
    app.destroy(true, { children: true });
    this.#app = null;
  }

  // ---- input ------------------------------------------------------------

  #pickAt(ev: MouseEvent): string | null {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    return pickBox(this.#layout, ev.clientX - rect.left, ev.clientY - rect.top);
  }

  #onPointerMove = (ev: PointerEvent): void => {
    const path = this.#pickAt(ev);
    if (this.#app) this.#app.canvas.style.cursor = path !== null && path !== this.#focus ? "pointer" : "default";
    this.#lastHover = path;
    for (const fn of this.#hoverFns) fn(path, { x: ev.clientX, y: ev.clientY });
  };

  #onPointerLeave = (ev: PointerEvent): void => {
    if (this.#lastHover === null) return;
    this.#lastHover = null;
    for (const fn of this.#hoverFns) fn(null, { x: ev.clientX, y: ev.clientY });
  };

  #onClick = (ev: MouseEvent): void => {
    if (ev.detail > 1) return; // a double click's second click is #onDblClick's
    const path = this.#pickAt(ev);
    this.#firstPick = path;
    for (const fn of this.#clickFns) fn(path);
  };

  #onDblClick = (): void => {
    for (const fn of this.#dblFns) fn(this.#firstPick);
  };

  #onResize = (): void => this.#invalidate();

  // ---- frame loop -------------------------------------------------------

  #invalidate(): void {
    this.#dirty = true;
    this.#wake();
  }

  #wake(): void {
    this.#idleFrames = 0;
    if (this.#app && !this.#app.ticker.started) this.#app.ticker.start();
  }

  #frame(dtMs: number): void {
    const app = this.#app;
    if (!app) return;
    const now = performance.now();
    const busy = this.#scene.step(dtMs, now, this.#motion.snap);
    const moving = this.#scene.moving;
    if (this.#dirty || moving || this.#wasMoving) {
      this.#drawBase();
      this.#drawLabels(!moving);
      this.#dirty = false;
    }
    this.#wasMoving = moving;
    this.#drawFx(now);

    // Stop the ticker once idle; while only live glows breathe, keep going at a capped frame rate.
    app.ticker.maxFPS = !busy && this.#breathing ? BREATH_FPS : 0;
    if (busy || this.#breathing) this.#idleFrames = 0;
    else if (++this.#idleFrames > 2) app.ticker.stop();
  }

  #look(vis: NodeVisual, agg: boolean): FileLook | AggregateLook {
    const hit = this.#looks.get(vis);
    if (hit && hit.gen === this.#styleGen && hit.ageGen === this.#ageGen && hit.agg === agg) return hit.look;
    const look = agg ? aggregateLook(vis, this.#theme, this.#isolated, this.#clock) : fileLook(vis, this.#theme, this.#isolated, this.#clock);
    this.#looks.set(vis, { gen: this.#styleGen, ageGen: this.#ageGen, agg, look });
    return look;
  }

  // ---- base layer -------------------------------------------------------

  #drawBase(): void {
    const g = this.#base;
    g.clear();
    this.#fxNodes = [];
    for (const n of this.#scene.nodes.values()) {
      const b = this.#scene.box(n);
      const a = n.alpha.value;
      if (boxW(b) < 0.5 || boxH(b) < 0.5 || a < 0.01) continue;
      if (!n.isDir) this.#drawFile(g, n, b, a);
      else if (n.aggregate !== undefined) this.#drawAggregate(g, n, b, a);
      else this.#drawFolder(g, n, b, a);
      const marked = !n.isDir || n.aggregate !== undefined;
      if (marked && !n.leaving && (n.pingAt !== null || n.shimmerAt !== null || this.#look(n.visual, n.isDir).halo)) this.#fxNodes.push(n);
    }
  }

  #drawFolder(g: Graphics, n: RectNode, b: Box, a: number): void {
    const night = this.#theme === "night";
    const focus = n.path === this.#focus;
    const line = { color: 0xffffff, width: 1 };
    const inner = inset(b, 0.5);
    if (this.#kind === "partition") {
      const cell = inset(b, FILE_INSET_PX);
      g.rect(cell.x0, cell.y0, boxW(cell), boxH(cell)).fill({ color: 0xffffff, alpha: (night ? 0.04 : 0.06) * a });
      g.rect(inner.x0, inner.y0, boxW(inner), boxH(inner)).stroke({ ...line, alpha: (night ? 0.08 : 0.12) * a });
      return;
    }
    // Tree map: a faint wash, a slightly stronger name strip, and an outline (the focus folder frames everything).
    if (!focus) {
      g.rect(b.x0, b.y0, boxW(b), boxH(b)).fill({ color: 0xffffff, alpha: (night ? 0.02 : 0.03) * a });
      const hh = Math.min(this.#headerPx, boxH(b));
      g.rect(b.x0, b.y0, boxW(b), hh).fill({ color: 0xffffff, alpha: (night ? 0.03 : 0.04) * a });
    }
    g.rect(inner.x0, inner.y0, boxW(inner), boxH(inner)).stroke({ ...line, alpha: (focus ? (night ? 0.12 : 0.18) : night ? 0.08 : 0.12) * a });
  }

  #drawAggregate(g: Graphics, n: RectNode, b: Box, a: number): void {
    const look = this.#look(n.visual, true) as AggregateLook;
    const cell = inset(b, FILE_INSET_PX);
    g.rect(cell.x0, cell.y0, boxW(cell), boxH(cell)).fill({ color: look.fill.color, alpha: look.fill.alpha * a });
    const o = inset(cell, 0.5);
    g.rect(o.x0, o.y0, boxW(o), boxH(o)).stroke({ color: look.outline.color, alpha: look.outline.alpha * a, width: 1 });
    this.#drawRings(g, cell, look.rings, a);
  }

  #drawFile(g: Graphics, n: RectNode, b: Box, a: number): void {
    const look = this.#look(n.visual, false) as FileLook;
    const cell = inset(b, FILE_INSET_PX);
    if (look.body) g.rect(cell.x0, cell.y0, boxW(cell), boxH(cell)).fill({ color: look.body.tint, alpha: look.body.alpha * a });
    const marks = look.marks * a;
    if (look.outline) {
      const o = inset(cell, DELETED_RIM_W_PX / 2);
      g.rect(o.x0, o.y0, boxW(o), boxH(o)).stroke({ color: look.outline.color, alpha: look.outline.alpha * marks, width: DELETED_RIM_W_PX });
    }
    this.#drawRings(g, cell, look.rings, marks);
    if (look.glyph) this.#drawGlyph(g, cell, look.glyph, a);
  }

  /** "+" or "×" in the middle of the box, sized like the bubble glyph for a circle of its shorter half-side (none under 10 px). */
  #drawGlyph(g: Graphics, b: Box, glyph: Glyph, a: number): void {
    const size = glyphSize(Math.min(boxW(b), boxH(b)) / 2);
    if (size === null) return;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const arm = size * GLYPH_ARM;
    const style = { color: glyph.color, alpha: glyph.alpha * a, width: size * GLYPH_STROKE, cap: "round" as const };
    if (glyph.shape === "plus") g.moveTo(cx - arm, cy).lineTo(cx + arm, cy).moveTo(cx, cy - arm).lineTo(cx, cy + arm).stroke(style);
    else {
      const d = arm / Math.SQRT2 * 1.2;
      g.moveTo(cx - d, cy - d).lineTo(cx + d, cy + d).moveTo(cx + d, cy - d).lineTo(cx - d, cy + d).stroke(style);
    }
  }

  /** A 1 px inner border in the ring colour; several worktrees split the perimeter, dashed where uncommitted. */
  #drawRings(g: Graphics, b: Box, rings: Rings, a: number): void {
    const arcs = rings.arcs;
    if (arcs.length === 0) return;
    const w = 1;
    const r = inset(b, w / 2);
    if (arcs.length === 1 && !arcs[0]!.dashed) {
      const arc = arcs[0]!;
      g.rect(r.x0, r.y0, boxW(r), boxH(r)).stroke({ color: arc.color, alpha: arc.alpha * a, width: w });
      return;
    }
    const segs = perimeterSegments(r, arcs.length, arcs.length > 1 ? SPLIT_GAP_PX : 0);
    arcs.forEach((arc, i) => {
      const pts = segs[i];
      if (!pts || pts.length < 2) return;
      if (arc.dashed) {
        const lines = dashPolyline(pts, DASH_PX, DASH_GAP_PX);
        if (lines.length === 0) return;
        for (const [x0, y0, x1, y1] of lines) g.moveTo(x0, y0).lineTo(x1, y1);
      } else {
        g.moveTo(pts[0]![0], pts[0]![1]);
        for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
      }
      g.stroke({ color: arc.color, alpha: arc.alpha * a, width: w });
    });
  }

  // ---- fx layer ---------------------------------------------------------

  #drawFx(now: number): void {
    const g = this.#fx;
    g.clear();
    this.#breathing = false;
    const breath = this.#motion.breath(now);
    for (const n of this.#fxNodes) {
      if (n.leaving) continue;
      const b = this.#scene.box(n);
      const a = n.alpha.value;
      const look = n.isDir ? (this.#look(n.visual, true) as AggregateLook) : (this.#look(n.visual, false) as FileLook);
      const halo = look.halo;
      if (halo) {
        // A soft border: a wide faint stroke under a narrow brighter one, just outside the box.
        const alpha = halo.alpha * breath.alpha * a;
        const out = GLOW_PX * breath.scale;
        const wide = inset(b, -out / 2);
        g.rect(wide.x0, wide.y0, boxW(wide), boxH(wide)).stroke({ color: halo.color, alpha: alpha * 0.5, width: out });
        const near = inset(b, -out / 4);
        g.rect(near.x0, near.y0, boxW(near), boxH(near)).stroke({ color: halo.color, alpha, width: out / 2 });
        if (this.#motion.breathes) this.#breathing = true;
      }
      const p = this.#scene.ping(n, now);
      const ping = p === null ? null : this.#motion.ping(p);
      const color = "body" in look ? (look.halo?.color ?? look.body?.tint ?? look.outline?.color) : (look.halo?.color ?? look.fill.color);
      if (ping && color !== undefined) {
        const o = inset(b, -(ping.scale - 1) * PING_REACH_PX);
        g.rect(o.x0, o.y0, boxW(o), boxH(o)).stroke({ color, alpha: ping.alpha * a, width: 2 });
      }
      const s = this.#scene.shimmer(n, now);
      if (s !== null) {
        const flash = this.#motion.shimmer(s);
        const grow = (flash.scale - 1) * Math.min(boxW(b), boxH(b)) * 0.25;
        const f = inset(b, -grow);
        g.rect(f.x0, f.y0, boxW(f), boxH(f)).fill({ color: 0xffffff, alpha: flash.alpha * a });
      }
    }
    this.#drawHighlight(g);
  }

  #drawHighlight(g: Graphics): void {
    const path = this.#highlighted;
    const n = path === null ? undefined : this.#scene.get(path);
    if (!n || n.leaving) return;
    const b = inset(this.#scene.box(n), 1);
    if (boxW(b) <= 0 || boxH(b) <= 0) return;
    g.rect(b.x0, b.y0, boxW(b), boxH(b)).stroke({ color: 0xffffff, alpha: 0.9, width: 2 });
  }

  // ---- labels -----------------------------------------------------------

  #measure = (s: string): number => {
    let w = this.#widths.get(s);
    if (w === undefined) {
      w = CanvasTextMetrics.measureText(s, this.#style).width;
      if (this.#widths.size > 5000) this.#widths.clear();
      this.#widths.set(s, w);
    }
    return w;
  };

  #folderColor(): string {
    return this.#theme === "night" ? "rgba(235,235,245,0.55)" : "rgba(235,235,245,0.78)";
  }

  /** Where each name (or collapsed folder's count) would go this frame, before the cap. */
  #labelSpots(): LabelSpot[] {
    const out: LabelSpot[] = [];
    const folder = this.#folderColor();
    const quiet = countColor(this.#theme);
    const hh = this.#headerPx;
    for (const n of this.#scene.nodes.values()) {
      if (n.leaving) continue;
      const b = this.#scene.box(n);
      const w = boxW(b);
      const h = boxH(b);
      const name = n.path === "" ? "" : n.path.slice(n.path.lastIndexOf("/") + 1);
      if (n.aggregate !== undefined) {
        const count = String(n.aggregate);
        if (w >= this.#measure(count) + LABEL_PAD_PX && h >= LABEL_FONT_PX + 3) {
          out.push({ path: n.path, rank: 1e6 - w * h, name: count, x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, anchorX: 0.5, maxWidth: w, color: quiet });
        }
      } else if (n.isDir) {
        if (name === "" || w < FOLDER_LABEL_MIN_W) continue;
        const strip = this.#kind === "treemap" ? hh : Math.min(hh, h);
        if (h < Math.min(strip, LABEL_FONT_PX + 3)) continue;
        out.push({ path: n.path, rank: n.depth, name, x: b.x0 + LABEL_PAD_PX, y: b.y0 + Math.min(strip, h) / 2, anchorX: 0, maxWidth: w - 2 * LABEL_PAD_PX, color: folder });
      } else if (w >= FILE_LABEL_MIN_W && h >= FILE_LABEL_MIN_H) {
        out.push({ path: n.path, rank: 1e6 - w * h, name, x: b.x0 + LABEL_PAD_PX, y: b.y0 + FILE_LABEL_MIN_H / 2, anchorX: 0, maxWidth: w - 2 * LABEL_PAD_PX, color: quiet });
      }
    }
    return out;
  }

  /** Places the pooled labels. `refit` (boxes at rest): re-truncate text to its box; otherwise only move what is already fitted. */
  #drawLabels(refit: boolean): void {
    const shown = new Set<string>();
    for (const s of capLabels(this.#labelSpots(), MAX_LABELS)) {
      let label = this.#labels.get(s.path);
      const key = `${s.name}|${Math.floor(s.maxWidth)}|${s.color}`;
      if (!label || (refit && label.key !== key)) {
        const text = fitText(s.name, s.maxWidth, this.#measure);
        if (text === null) continue;
        if (!label) {
          label = { text: new Text({ text, style: this.#style.clone() }), key: "" };
          this.#labelLayer.addChild(label.text);
          this.#labels.set(s.path, label);
        }
        label.text.text = text;
        label.text.style.fill = s.color;
        label.key = key;
      } else if (!refit && label.text.width > s.maxWidth + 1) continue; // mid-animation it no longer fits: hide until rest
      const n = this.#scene.get(s.path);
      label.text.anchor.set(s.anchorX, 0.5);
      label.text.position.set(Math.round(s.x), Math.round(s.y));
      label.text.alpha = n?.alpha.value ?? 1;
      label.text.visible = true;
      shown.add(s.path);
    }
    for (const [path, label] of this.#labels) {
      if (shown.has(path)) continue;
      if (this.#scene.get(path)) label.text.visible = false;
      else {
        label.text.destroy();
        this.#labels.delete(path);
      }
    }
  }
}
