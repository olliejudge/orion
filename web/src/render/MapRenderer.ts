import { Application, Container, Graphics, Sprite } from "pixi.js";
import type { NodeVisual } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import type { WorktreeId } from "../protocol";
import type { Change } from "../store";
import { WHOLE, clipFor, dashed, disk, outline, solidArc, type Clip } from "./draw";
import {
  fitCamera,
  labelNames,
  pick,
  rimView,
  screenToWorld,
  splitSegments,
  zoomPath,
  type Camera,
  type Rect,
} from "./geometry";
import { motionPolicy, watchReducedMotion, type Motion } from "./motion";
import { focusFolder, follow, type CameraPath } from "./camera";
import { MapNavigator } from "./navigate";
import { Scene, type SceneNode } from "./scene";
import {
  LABEL_LINE_PX,
  countFontPx,
  digitCount,
  labelMinR,
  labelSpan,
  labelTier,
  nextLevels,
  placeCounts,
  placeLabels,
  straightWidth,
  type CountCandidate,
  type LabelCandidate,
  type LabelSpot,
} from "./labels";
import { HALO_RING_FRAC, TextureBank, labelWidth, renderArcLabel, renderStraightLabel } from "./sprites";
import { SETTLE_EPS, SPRING_OMEGA, isSettled, makeSpring, retarget, snapSpring, stepSpring, type Spring } from "./springs";
import {
  DELETED_RIM_W_PX,
  aggregateLook,
  countColor,
  fileLook,
  glyphSize,
  touchSig,
  type AggregateLook,
  type FileLook,
  type Rings,
  type Theme,
} from "./style";

export type { Theme } from "./style";

const LABEL_FADE_MS = 200; // labels fade in over time once placed at rest
const LABEL_GAP_PAD_PX = 4; // outline clearance either side of a rim label
const HALO_PX = 5; // halo peak this far outside the bubble, on screen
const SPLIT_GAP_PX = 3;
const LOGK_EPS = 1e-4; // camera scale settles within 0.01%
/** How often bubbles re-age (their brightness is how long ago they were touched); the finest step, an hour's quarter, is far slower. */
export const AGE_TICK_MS = 30_000;

/** Settle epsilon for world-space springs at zoom k: half a screen pixel, or SETTLE_EPS if k is unusable. */
function worldEps(k: number): number {
  const e = 0.5 / k;
  return Number.isFinite(e) && e > 0 ? e : SETTLE_EPS;
}

interface View {
  kind: string; // "file" | "dir" | "aggregate": a node that changes kind gets a fresh view
  root: Container;
  body: Sprite | null; // files only
  halo: Sprite | null;
  flash: Sprite | null; // merge shimmer
  glyph: Sprite | null; // a file's state mark ("+", "×"), made on first use
  g: Graphics; // dir outline, aggregate disc, deleted rim, rings
  gKey: string;
  label: Sprite | null;
  labelKey: string;
  labelR: number; // on-screen text radius (arc) or folder radius (straight) the label was rendered for
  labelShownAt: number | null; // when the label last appeared (for its fade-in)
  count: Sprite | null; // a collapsed folder's file count
  countN: number; // what the count sprite's texture shows: the number, its font size, and the style generation
  countFont: number;
  countGen: number;
}

/**
 * The camera's springs. While `path` is set (a zoom), only the scale springs
 * and the centre follows it; otherwise the centre springs on its own (a pan).
 */
interface CameraAnim {
  cx: Spring;
  cy: Spring;
  logk: Spring;
  target: Camera;
  path: CameraPath | null;
}

interface FrameCtx {
  bank: TextureBank;
  k: number;
  ox: number; // screen = world * k + (ox, oy)
  oy: number;
  rect: Rect; // the viewport, in screen px
  big: number; // circles larger than this on screen are clipped to the viewport
  now: number;
  camBusy: boolean;
  spots: Map<string, LabelSpot>; // label placements (from the last frame at rest while the camera moves)
  counts: Set<string>; // collapsed folders whose file count shows (likewise)
}

/**
 * Pixi v8 scene for the map. All animation state lives in Scene (pure,
 * unit-tested); this class only turns SceneNodes into display objects each
 * frame, owns the camera, and does picking in JS from the layout map.
 *
 * Everything is drawn in screen pixels (the stage is never scaled): Pixi
 * tessellates circles and arcs by their local radius, so geometry built in
 * world units would turn polygonal when zoomed in. Nodes off screen are
 * culled, and circles far bigger than the viewport draw only their visible
 * arc, so deep zooms stay cheap.
 *
 * Visual behaviour is verified by the Playwright smoke test (Task 14).
 */
export class MapRenderer {
  #host: HTMLElement;
  #app: Application | null = null;
  #bank: TextureBank | null = null;
  #destroyed = false;

  #dirLayer = new Container();
  #fileLayer = new Container();
  #labelLayer = new Container();
  #fx = new Graphics();

  #scene = new Scene();
  #views = new Map<string, View>();
  #layout = new Map<string, Circle>();
  #labels = new Map<string, string>();
  #labelWidths = new Map<string, number>();
  #spots = new Map<string, LabelSpot>();
  #counts = new Set<string>();
  #labelsFading = false;
  // The next level below the folder in view (nextLevels), recomputed when the names or the view change.
  #next: { labels: Map<string, string>; focus: string; set: Set<string> } | null = null;

  #theme: Theme = "vision";
  #isolated: WorktreeId | null = null;
  #highlighted: string | null = null;
  #styleGen = 0;
  // Ages are measured against this wall-clock time, advanced every AGE_TICK_MS (#ageGen counts the ticks).
  #clock = Date.now();
  #ageGen = 0;
  #ageTimer: ReturnType<typeof setInterval> | null = null;
  // Looks per visual (the store makes new visuals per patch), recomputed when the theme, isolation or clock changes.
  #looks = new WeakMap<NodeVisual, { gen: number; ageGen: number; look: FileLook | AggregateLook }>();

  #zoomPath = "";
  #free: Rect | undefined; // where zoom targets are fitted (see fitCamera)
  #cam: CameraAnim;

  #hoverFns: ((path: string | null, screen: { x: number; y: number }) => void)[] = [];
  #clickFns: ((path: string | null) => void)[] = [];
  #zoomFns: ((scale: number) => void)[] = [];
  #focusFns: ((path: string) => void)[] = [];
  #dblFns: ((path: string | null) => void)[] = [];
  #nav: MapNavigator | null = null;
  // After a wheel zoom or drag the camera is free: relayouts carry it along
  // with the focused folder instead of refitting that folder.
  #freeView: { focus: Circle } | null = null;
  #reportedK = 1; // last scale sent to onZoom (culling)
  #firstPick: string | null = null; // the path under a double click's first click
  #idleFrames = 0;
  #lastHover: string | null = null;
  #motion: Motion = motionPolicy(false);
  #stopMotionWatch = (): void => {};

  constructor(host: HTMLElement) {
    this.#host = host;
    const { width, height } = this.#size();
    this.#cam = this.#snapped({ cx: width / 2, cy: height / 2, k: 1 });
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
    this.#bank = new TextureBank();
    this.#host.appendChild(app.canvas);
    app.canvas.style.display = "block";
    app.stage.addChild(this.#dirLayer, this.#fileLayer, this.#labelLayer, this.#fx);
    const { width, height } = this.#size();
    const c = this.#layout.get(this.#zoomPath);
    this.#cam = this.#snapped(c ? fitCamera(c, width, height, this.#free) : { cx: width / 2, cy: height / 2, k: 1 });

    app.canvas.addEventListener("pointermove", this.#onPointerMove);
    app.canvas.addEventListener("pointerleave", this.#onPointerLeave);
    this.#nav = new MapNavigator(app.canvas, {
      camera: () => this.#camera(),
      aimed: () => this.#cam.target,
      size: () => this.#size(),
      root: () => this.#layout.get(""),
      free: () => this.#freeRect(),
      layout: () => this.#layout,
      view: (target, path, snap) => this.#setView(target, path, snap),
      click: (ev) => this.#onClick(ev),
      doubleClick: () => this.#onDblClick(),
    });
    app.ticker.add((t) => this.#frame(t.deltaMS));
    // The ticker stops when idle, so ageing needs its own slow clock.
    this.#ageTimer = setInterval(() => {
      this.#clock = Date.now();
      this.#ageGen++;
      this.#wake();
    }, AGE_TICK_MS);
    this.#stopMotionWatch = watchReducedMotion((reduced) => {
      this.#motion = motionPolicy(reduced);
      this.#wake();
    });
  }

  update(layout: Map<string, Circle>, visuals: Map<string, NodeVisual>, change: Change): void {
    this.#layout = layout;
    this.#labels = labelNames(layout);
    // Scene.update reports whether anything moves; wake regardless, because
    // visuals (colours, rings) can change without any motion.
    this.#scene.update(layout, visuals, change, performance.now());
    this.#clock = Date.now(); // new visuals age from now; cached looks keep theirs until the next tick
    if (!layout.has(this.#zoomPath)) this.#zoomPath = "";
    this.#aimCamera(false);
    this.#wake();
  }

  setTheme(t: Theme): void {
    if (t === this.#theme) return;
    this.#theme = t;
    this.#styleGen++;
    this.#wake();
  }

  isolate(worktree: WorktreeId | null): void {
    this.#isolated = worktree;
    this.#styleGen++;
    this.#wake();
  }

  highlight(path: string | null): void {
    this.#highlighted = path;
    this.#wake();
  }

  zoomTo(path: string): void {
    this.#freeView = null;
    this.#zoomPath = this.#layout.has(path) ? path : "";
    this.#aimCamera(true);
    this.#wake();
  }

  /** The viewport rect (CSS px) the layout was fitted into; zoom targets are centred in it. */
  setFreeArea(rect: Rect): void {
    const f = this.#free;
    // A resize repacks the whole map: refit the focused folder rather than follow it.
    if (!f || f.x0 !== rect.x0 || f.y0 !== rect.y0 || f.x1 !== rect.x1 || f.y1 !== rect.y1) this.#freeView = null;
    this.#free = rect;
  }

  onHover(fn: (path: string | null, screen: { x: number; y: number }) => void): void {
    this.#hoverFns.push(fn);
  }

  onClick(fn: (path: string | null) => void): void {
    this.#clickFns.push(fn);
  }

  /** Fires with the camera's TARGET scale whenever a zoom starts, so the caller can re-cull. */
  onZoom(fn: (scale: number) => void): void {
    this.#zoomFns.push(fn);
  }

  /** Fires when wheel zoom or dragging brings a different folder into focus (see focusFolder). */
  onFocus(fn: (path: string) => void): void {
    this.#focusFns.push(fn);
  }

  /** Fires on a double click with the path under its first click (null: outside the repo). */
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
    this.#nav?.destroy();
    for (const v of this.#views.values()) v.label?.texture.destroy(true);
    this.#views.clear();
    app.destroy(true, { children: true });
    this.#bank?.destroy();
    this.#bank = null;
    this.#app = null;
  }

  // ---- camera -----------------------------------------------------------

  #size(): { width: number; height: number } {
    return { width: this.#host.clientWidth || 1, height: this.#host.clientHeight || 1 };
  }

  #camera(): Camera {
    return { cx: this.#cam.cx.value, cy: this.#cam.cy.value, k: Math.exp(this.#cam.logk.value) };
  }

  #snapped(c: Camera): CameraAnim {
    return { cx: makeSpring(c.cx), cy: makeSpring(c.cy), logk: makeSpring(Math.log(c.k)), target: c, path: null };
  }

  #freeRect(): Rect {
    const { width, height } = this.#size();
    return this.#free ?? { x0: 0, y0: 0, x1: width, y1: height };
  }

  /** Points the camera springs at `target`; while `path` is set the centre follows it as the scale springs. */
  #aim(target: Camera, path: CameraPath | null): void {
    const cam = this.#cam;
    cam.target = target;
    cam.path = path;
    retarget(cam.cx, target.cx);
    retarget(cam.cy, target.cy);
    retarget(cam.logk, Math.log(target.k));
  }

  /** A free camera move (wheel zoom, drag): aims the springs, then re-derives the focused folder. */
  #setView(target: Camera, path: CameraPath | null, snap: boolean): void {
    const cam = this.#cam;
    this.#aim(target, snap ? null : path);
    if (snap) for (const s of [cam.cx, cam.cy, cam.logk]) snapSpring(s);
    const { width, height } = this.#size();
    const focus = focusFolder(this.#layout, target, width, height, this.#freeRect());
    const fc = this.#layout.get(focus);
    // Free before anything relayouts (onZoom below does), or the relayout would refit the old target.
    this.#freeView = fc ? { focus: fc } : null;
    const moved = focus !== this.#zoomPath;
    this.#zoomPath = focus;
    this.#wake();
    if (moved) for (const fn of this.#focusFns) fn(focus);
    // Re-cull as the scale changes, but not on every wheel tick.
    if (Math.abs(Math.log(target.k / this.#reportedK)) > 0.1) this.#reportZoom(target.k);
  }

  #reportZoom(k: number): void {
    this.#reportedK = k;
    for (const fn of this.#zoomFns) fn(k);
  }

  /** Relayout under a free camera: keep showing the same part of the focused folder. */
  #followFocus(): void {
    const was = this.#freeView?.focus;
    const now = this.#layout.get(this.#zoomPath);
    if (!was || !now) return;
    if (was.x === now.x && was.y === now.y && was.r === now.r) return;
    const target = follow(this.#cam.target, was, now);
    this.#freeView = { focus: now };
    this.#aim(target, null);
  }

  #aimCamera(userInitiated: boolean): void {
    if (this.#freeView && !userInitiated) return this.#followFocus();
    const c = this.#layout.get(this.#zoomPath);
    if (!c) return;
    const { width, height } = this.#size();
    const target = fitCamera(c, width, height, this.#free);
    const prev = this.#cam.target;
    const changed = Math.abs(Math.log(target.k / prev.k)) > 1e-3;
    if (target.cx !== prev.cx || target.cy !== prev.cy || target.k !== prev.k) {
      // A zoom scales about a fixed point so the target stays on screen; a
      // pure pan (same scale) springs the centre directly.
      this.#aim(target, zoomPath(this.#camera(), target));
    }
    if (changed || userInitiated) this.#reportZoom(target.k);
  }

  /** Advances the camera; returns true while it is still moving. */
  #stepCamera(dt: number): boolean {
    const cam = this.#cam;
    if (this.#motion.snap) {
      for (const s of [cam.cx, cam.cy, cam.logk]) snapSpring(s);
      cam.path = null;
      return false;
    }
    stepSpring(cam.logk, dt, SPRING_OMEGA, LOGK_EPS);
    if (cam.path) {
      const at = cam.path(Math.exp(cam.logk.value));
      cam.cx.value = at.cx;
      cam.cy.value = at.cy;
      cam.cx.velocity = cam.cy.velocity = 0;
      if (!isSettled(cam.logk, LOGK_EPS)) return true;
      cam.path = null;
      cam.cx.value = cam.cx.target;
      cam.cy.value = cam.cy.target;
      return false;
    }
    const eps = worldEps(Math.exp(cam.logk.value));
    stepSpring(cam.cx, dt, SPRING_OMEGA, eps);
    stepSpring(cam.cy, dt, SPRING_OMEGA, eps);
    return !isSettled(cam.cx, eps) || !isSettled(cam.cy, eps) || !isSettled(cam.logk, LOGK_EPS);
  }

  // ---- input ------------------------------------------------------------

  #pickAt(ev: PointerEvent | MouseEvent): string | null {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const { width, height } = this.#size();
    const w = screenToWorld(this.#camera(), width, height, ev.clientX - rect.left, ev.clientY - rect.top);
    return pick(this.#layout, w.x, w.y);
  }

  #onPointerMove = (ev: PointerEvent): void => {
    if (this.#nav?.dragging) return this.#onPointerLeave(ev); // no tooltip while dragging
    const path = this.#pickAt(ev);
    if (this.#app) this.#app.canvas.style.cursor = path !== null && path !== this.#zoomPath ? "pointer" : "grab";
    this.#lastHover = path;
    for (const fn of this.#hoverFns) fn(path, { x: ev.clientX, y: ev.clientY });
  };

  #onPointerLeave = (ev: PointerEvent): void => {
    if (this.#lastHover === null) return;
    this.#lastHover = null;
    for (const fn of this.#hoverFns) fn(null, { x: ev.clientX, y: ev.clientY });
  };

  /** A click the navigator let through (not a drag's end, nor a double click's second click). */
  #onClick(ev: MouseEvent): void {
    const path = this.#pickAt(ev);
    this.#firstPick = path;
    for (const fn of this.#clickFns) fn(path);
  }

  #onDblClick(): void {
    for (const fn of this.#dblFns) fn(this.#firstPick);
  }

  // ---- frame loop -------------------------------------------------------

  #wake(): void {
    this.#idleFrames = 0;
    if (this.#app && !this.#app.ticker.started) this.#app.ticker.start();
  }

  #frame(dtMs: number): void {
    const app = this.#app;
    const bank = this.#bank;
    if (!app || !bank) return;
    const now = performance.now();
    const camBusy = this.#stepCamera(Math.max(0, Math.min(dtMs || 0, 64)) / 1000);
    const cam = this.#camera();
    const sceneBusy = this.#scene.step(dtMs, now, worldEps(cam.k), this.#motion.snap);

    const { width, height } = this.#size();
    const f: FrameCtx = {
      bank,
      k: cam.k,
      ox: width / 2 - cam.cx * cam.k,
      oy: height / 2 - cam.cy * cam.k,
      rect: { x0: 0, y0: 0, x1: width, y1: height },
      big: Math.max(width, height),
      now,
      camBusy,
      spots: this.#spots,
      counts: this.#counts,
    };
    if (!camBusy) {
      this.#placeLabels(f);
      f.spots = this.#spots;
      f.counts = this.#counts;
    }
    this.#labelsFading = false;
    for (const n of this.#scene.nodes.values()) this.#draw(n, f);
    for (const [path, v] of this.#views) {
      if (!this.#scene.nodes.has(path)) this.#dropView(path, v);
    }
    this.#drawHighlight(f);

    // Stop the ticker once idle so an ambient dashboard costs ~0 GPU.
    if (camBusy || sceneBusy || this.#labelsFading) this.#idleFrames = 0;
    else if (++this.#idleFrames > 2) app.ticker.stop();
  }

  #view(n: SceneNode, bank: TextureBank): View {
    const kind = !n.isDir ? "file" : n.aggregate !== undefined ? "aggregate" : "dir";
    let v = this.#views.get(n.path);
    if (v && v.kind === kind) return v;
    if (v) this.#dropView(n.path, v);
    const root = new Container();
    const g = new Graphics();
    let body: Sprite | null = null;
    let halo: Sprite | null = null;
    if (!n.isDir || n.aggregate !== undefined) {
      halo = new Sprite(bank.halo);
      halo.anchor.set(0.5);
      halo.visible = false;
      root.addChild(halo);
    }
    if (!n.isDir) {
      body = new Sprite(bank.disc);
      body.anchor.set(0.5);
      root.addChild(body);
    }
    root.addChild(g);
    (n.isDir ? this.#dirLayer : this.#fileLayer).addChild(root);
    v = {
      kind,
      root,
      body,
      halo,
      flash: null,
      glyph: null,
      g,
      gKey: "",
      label: null,
      labelKey: "",
      labelR: 0,
      labelShownAt: null,
      count: null,
      countN: -1,
      countFont: 0,
      countGen: -1,
    };
    this.#views.set(n.path, v);
    return v;
  }

  #dropView(path: string, v: View): void {
    v.label?.texture.destroy(true);
    v.label?.destroy();
    v.root.destroy({ children: true });
    this.#views.delete(path);
  }

  #look(vis: NodeVisual, aggregate: boolean): FileLook | AggregateLook {
    const hit = this.#looks.get(vis);
    if (hit && hit.gen === this.#styleGen && hit.ageGen === this.#ageGen) return hit.look;
    const look = aggregate ? aggregateLook(vis, this.#theme, this.#isolated, this.#clock) : fileLook(vis, this.#theme, this.#isolated, this.#clock);
    this.#looks.set(vis, { gen: this.#styleGen, ageGen: this.#ageGen, look });
    return look;
  }

  #draw(n: SceneNode, f: FrameCtx): void {
    const pos = this.#scene.drawPosition(n);
    const R = Math.max(0, n.r.value) * f.k;
    const sx = pos.x * f.k + f.ox;
    const sy = pos.y * f.k + f.oy;
    const plainDir = n.isDir && n.aggregate === undefined;
    // Glow and rings reach past the rim; anything wholly off screen is skipped.
    const reach = plainDir ? R + 1 : (R + HALO_PX) / HALO_RING_FRAC + 2;
    const existing = this.#views.get(n.path);
    if (R < 0.3 || rimView(sx, sy, reach, f.rect).kind === "hidden") {
      if (existing) {
        existing.root.visible = false;
        this.#hideLabel(existing);
      }
      return;
    }

    const v = this.#view(n, f.bank);
    v.root.visible = true;
    v.root.position.set(sx, sy);
    v.root.alpha = n.alpha.value;

    const vis = n.visual;
    const look = n.isDir ? null : (this.#look(vis, false) as FileLook);
    const agg = n.aggregate !== undefined ? (this.#look(vis, true) as AggregateLook) : null;

    // Body (files): one flat disc texture, tinted; none for deletions (hollow).
    if (v.body) {
      const body = look?.body ?? null;
      v.body.visible = body !== null;
      if (body) {
        v.body.tint = body.tint;
        v.body.alpha = body.alpha;
        v.body.width = v.body.height = R * 2;
      }
    }

    // Halo: live uncommitted work glows in its worktree's colour.
    if (v.halo) {
      const glow = look ? look.halo : (agg?.halo ?? null);
      v.halo.visible = glow !== null;
      if (glow) {
        v.halo.width = v.halo.height = ((R + HALO_PX) / HALO_RING_FRAC) * 2;
        v.halo.tint = glow.color;
        v.halo.alpha = glow.alpha;
      }
    }

    // The label first: a name on the rim breaks the folder outline behind it.
    const gap = plainDir ? this.#drawLabel(v, n, R, sx, sy, f) : 0;

    // Vector parts, redrawn only when their inputs change.
    const clip = R > f.big ? clipFor(sx, sy, R, f.rect) : WHOLE;
    // (A file's marks age through the Graphics' alpha; an aggregate's disc through its fill, part of the key.)
    const gKey = `${Math.round(R * 2)}|${clip.key}|${this.#styleGen}|${touchSig(vis)}|${vis.state}|${n.aggregate ?? -1}|${agg?.fill.alpha.toFixed(2) ?? ""}|${gap.toFixed(3)}`;
    if (gKey !== v.gKey) {
      v.gKey = gKey;
      v.g.clear();
      if (n.isDir) this.#drawDir(v.g, n, R, clip, sx, sy, f, gap);
      else if (look) this.#drawFileMarks(v.g, look, R, clip);
    }
    v.g.alpha = look ? look.marks : 1;
    if (look) this.#drawGlyph(v, look, R, f);

    if (n.aggregate !== undefined) this.#drawCount(v, n, n.aggregate, R, f);
    this.#drawShimmer(v, n, R, f);
  }

  /** A collapsed folder's file count, centred in its disc, when placed at rest and it still fits. */
  #drawCount(v: View, n: SceneNode, files: number, R: number, f: FrameCtx): void {
    const font = !n.leaving && f.counts.has(n.path) ? countFontPx(R, digitCount(files)) : null;
    if (font === null) {
      if (v.count) v.count.visible = false;
      return;
    }
    const dpr = this.#app?.renderer.resolution ?? 1;
    if (!v.count) {
      v.count = new Sprite();
      v.count.anchor.set(0.5);
      v.root.addChild(v.count);
    }
    if (v.countN !== files || v.countFont !== font || v.countGen !== this.#styleGen) {
      v.count.texture = f.bank.count(files, font, countColor(this.#theme), dpr);
      v.countN = files;
      v.countFont = font;
      v.countGen = this.#styleGen;
    }
    v.count.visible = true;
    v.count.scale.set(1 / dpr);
  }

  #drawDir(g: Graphics, n: SceneNode, R: number, clip: Clip, sx: number, sy: number, f: FrameCtx, gap: number): void {
    const night = this.#theme === "night";
    if (n.aggregate !== undefined) {
      const look = this.#look(n.visual, true) as AggregateLook;
      disk(g, R, clip, sx, sy, f.rect, look.fill);
      outline(g, R, clip, look.outline.color, look.outline.alpha, 1);
      this.#drawRings(g, R, clip, look.rings);
      return;
    }
    const isRoot = n.depth === 0;
    if (!night) disk(g, R, clip, sx, sy, f.rect, { color: 0xffffff, alpha: isRoot ? 0.02 : 0.03 });
    outline(g, R, clip, 0xffffff, night ? (isRoot ? 0.1 : 0.08) : isRoot ? 0.16 : 0.12, 1, gap);
  }

  /** A file's vector marks: a deletion's rim and the worktree rings. */
  #drawFileMarks(g: Graphics, look: FileLook, R: number, clip: Clip): void {
    const o = look.outline;
    if (o) outline(g, R - DELETED_RIM_W_PX / 2, clip, o.color, o.alpha, DELETED_RIM_W_PX);
    this.#drawRings(g, R, clip, look.rings);
  }

  /** The state glyph, a tinted sprite of a shared texture, sized with the bubble; hidden when it is too small. */
  #drawGlyph(v: View, look: FileLook, R: number, f: FrameCtx): void {
    const size = look.glyph ? glyphSize(R) : null;
    if (!look.glyph || size === null) {
      if (v.glyph) v.glyph.visible = false;
      return;
    }
    if (!v.glyph) {
      v.glyph = new Sprite(f.bank.glyphs[look.glyph.shape]);
      v.glyph.anchor.set(0.5);
      v.root.addChildAt(v.glyph, v.root.getChildIndex(v.g) + 1);
    }
    const tex = f.bank.glyphs[look.glyph.shape];
    if (v.glyph.texture !== tex) v.glyph.texture = tex;
    v.glyph.visible = true;
    v.glyph.tint = look.glyph.color;
    v.glyph.alpha = look.glyph.alpha;
    v.glyph.width = v.glyph.height = size * 2;
  }

  /** One ring (or a split ring with one arc per worktree): dashed = uncommitted, solid = committed. */
  #drawRings(g: Graphics, R: number, clip: Clip, rings: Rings): void {
    const arcs = rings.arcs;
    if (arcs.length === 0) return;
    const RR = R + rings.gap;
    const segs = splitSegments(arcs.length, arcs.length > 1 ? SPLIT_GAP_PX / RR : 0);
    arcs.forEach((a, i) => {
      const [a0, a1] = segs[i]!;
      if (a.dashed) dashed(g, RR, a0, a1, clip, a.color, a.alpha, rings.width, 4, 3);
      else if (arcs.length === 1 && clip.stroke.kind === "full") g.circle(0, 0, RR).stroke({ color: a.color, alpha: a.alpha, width: rings.width });
      else solidArc(g, RR, a0, a1, clip, a.color, a.alpha, rings.width);
    });
  }

  #drawShimmer(v: View, n: SceneNode, R: number, f: FrameCtx): void {
    const p = this.#scene.shimmer(n, f.now);
    if (p === null) {
      if (v.flash) v.flash.visible = false;
      return;
    }
    if (!v.flash) {
      v.flash = new Sprite(f.bank.disc);
      v.flash.anchor.set(0.5);
      v.root.addChild(v.flash);
    }
    const look = this.#motion.shimmer(p);
    v.flash.visible = true;
    v.flash.alpha = look.alpha;
    v.flash.width = v.flash.height = R * 2 * look.scale;
  }

  #labelWidth(name: string): number {
    let w = this.#labelWidths.get(name);
    if (w === undefined) this.#labelWidths.set(name, (w = labelWidth(name)));
    return w;
  }

  /** The next level below the folder in view: the folders a click lands in (see nextLevels). */
  #nextLevels(): Set<string> {
    const c = this.#next;
    if (c && c.labels === this.#labels && c.focus === this.#zoomPath) return c.set;
    const set = nextLevels(this.#labels, this.#zoomPath);
    this.#next = { labels: this.#labels, focus: this.#zoomPath, set };
    return set;
  }

  /**
   * At rest: where each visible folder's name goes, with collisions pushed
   * inward, set straight or hidden; and which collapsed folders show their
   * file count (those clear of every name).
   */
  #placeLabels(f: FrameCtx): void {
    const next = this.#nextLevels();
    const cands: LabelCandidate[] = [];
    const counts: CountCandidate[] = [];
    for (const n of this.#scene.nodes.values()) {
      if (!n.isDir || n.leaving) continue;
      // Wait until the folder stops growing/shrinking so labels never balloon.
      if (Math.abs(n.r.value - n.r.target) > 0.05 * Math.max(n.r.target, 1e-6)) continue;
      const R = n.r.value * f.k;
      if (n.aggregate !== undefined) {
        const digits = digitCount(n.aggregate);
        const font = countFontPx(R, digits);
        if (font === null) continue;
        const pos = this.#scene.drawPosition(n);
        const x = pos.x * f.k + f.ox;
        const y = pos.y * f.k + f.oy;
        if (rimView(x, y, R, f.rect).kind !== "hidden") counts.push({ path: n.path, x, y, digits, font });
        continue;
      }
      const name = this.#labels.get(n.path);
      if (name === undefined) continue;
      const tier = labelTier(n.path, this.#zoomPath, next);
      if (R < labelMinR(tier)) continue;
      const pos = this.#scene.drawPosition(n);
      const x = pos.x * f.k + f.ox;
      const y = pos.y * f.k + f.oy;
      const rim = rimView(x, y, R + LABEL_LINE_PX, f.rect);
      if (rim.kind === "hidden" || rim.kind === "covers") continue;
      cands.push({ path: n.path, x, y, r: R, width: this.#labelWidth(name), tier });
    }
    this.#spots = placeLabels(cands);
    this.#counts = placeCounts(counts, this.#spots);
  }

  #hideLabel(v: View): void {
    if (v.label) v.label.visible = false;
    v.labelShownAt = null;
  }

  /** Draws a folder's name; returns the half-angle to break its outline by (0 if none). */
  #drawLabel(v: View, n: SceneNode, R: number, sx: number, sy: number, f: FrameCtx): number {
    const name = this.#labels.get(n.path);
    const spot = f.spots.get(n.path);
    if (name === undefined || spot === undefined || n.leaving || R < labelMinR(spot.tier)) {
      this.#hideLabel(v);
      return 0;
    }
    const straight = spot.kind === "straight";
    // What the label is laid out for: its text radius on the rim, or the folder's radius across its middle.
    const size = straight ? R : R - spot.inset * LABEL_LINE_PX;
    const dpr = this.#app?.renderer.resolution ?? 1;
    const key = `${name}|${spot.kind}|${Math.round(size / 12)}|${this.#theme}`;
    if (key !== v.labelKey && (!f.camBusy || !v.label)) {
      const color = this.#theme === "night" ? "rgba(235,235,245,0.55)" : "rgba(235,235,245,0.78)";
      const arc = straight ? null : renderArcLabel(name, size, color, dpr);
      const tex = straight ? (renderStraightLabel(name, straightWidth(size), color, dpr)?.texture ?? null) : (arc?.texture ?? null);
      if (v.label) {
        v.label.texture.destroy(true);
        v.label.destroy();
        v.label = null;
      }
      v.labelKey = key;
      if (tex) {
        const s = new Sprite(tex);
        if (arc) s.anchor.set(arc.originX / tex.width, arc.originY / tex.height);
        else s.anchor.set(0.5);
        this.#labelLayer.addChild(s);
        v.label = s;
        v.labelR = size;
      }
    }
    // Mid-zoom a cached label would balloon or shrink; hide it until it is re-rendered at rest.
    const ratio = size / v.labelR;
    if (!v.label || (f.camBusy && (ratio > 1.15 || ratio < 0.87))) {
      this.#hideLabel(v);
      return 0;
    }
    v.labelShownAt ??= f.now;
    const fade = Math.min(1, (f.now - v.labelShownAt) / LABEL_FADE_MS);
    if (fade < 1) this.#labelsFading = true;
    v.label.visible = true;
    v.label.position.set(sx, sy);
    v.label.scale.set(ratio / dpr);
    v.label.alpha = fade * n.alpha.value;
    return !straight && spot.inset === 0 ? labelSpan(this.#labelWidth(name), size) / 2 + LABEL_GAP_PAD_PX / size : 0;
  }

  #drawHighlight(f: FrameCtx): void {
    this.#fx.clear();
    const path = this.#highlighted;
    if (path === null) return;
    const n = this.#scene.get(path);
    if (!n || n.leaving) return;
    const pos = this.#scene.drawPosition(n);
    const R = Math.max(0, n.r.value) * f.k + 5;
    const sx = pos.x * f.k + f.ox;
    const sy = pos.y * f.k + f.oy;
    const rim = rimView(sx, sy, R + 2, f.rect);
    if (R > f.big * 4 || rim.kind === "hidden" || rim.kind === "covers") return;
    this.#fx.circle(sx, sy, R).stroke({ color: 0xffffff, alpha: 0.9, width: 2 });
  }
}
