import { Application, Container, Graphics, Sprite, type Texture } from "pixi.js";
import { colorForExt, hexToNumber, lighten, worktreeColor } from "../colors";
import type { NodeVisual, Touch } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import type { WorktreeId } from "../protocol";
import type { Change } from "../store";
import { RING_GAP_PX, RING_W_PX, WHOLE, clipFor, dashed, disk, outline, solidArc, type Clip } from "./draw";
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
import { Scene, type SceneNode } from "./scene";
import { labelSpan, placeLabels, type LabelCandidate, type LabelSpot, LABEL_LINE_PX } from "./labels";
import { HALO_RING_FRAC, TextureBank, labelWidth, renderArcLabel } from "./sprites";
import { SETTLE_EPS, SPRING_OMEGA, isSettled, makeSpring, retarget, stepSpring, type Spring } from "./springs";

export type Theme = "vision" | "night";

const NIGHT_IDLE = 0x3a3a44;
const LABEL_MIN_R = 48; // on-screen px before a folder gets its name
const LABEL_FADE_MS = 200; // labels fade in over time once placed at rest
const LABEL_GAP_PAD_PX = 4; // outline clearance either side of a rim label
const ISOLATE_DIM = 0.15;
const HALO_PX = 5; // halo peak this far outside the bubble, on screen
const SPLIT_GAP_PX = 3;
const LOGK_EPS = 1e-4; // camera scale settles within 0.01%

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
  g: Graphics; // dir outline, ghost fill, rings
  gKey: string;
  label: Sprite | null;
  labelKey: string;
  labelR: number; // on-screen text radius the label was rendered for
  labelShownAt: number | null; // when the label last appeared (for its fade-in)
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
  path: ((k: number) => { cx: number; cy: number }) | null;
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
  #labelsFading = false;

  #theme: Theme = "vision";
  #isolated: WorktreeId | null = null;
  #highlighted: string | null = null;
  #styleGen = 0;

  #zoomPath = "";
  #cam: CameraAnim;

  #hoverFns: ((path: string | null, screen: { x: number; y: number }) => void)[] = [];
  #clickFns: ((path: string | null) => void)[] = [];
  #zoomFns: ((scale: number) => void)[] = [];
  #idleFrames = 0;
  #lastHover: string | null = null;

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
    this.#cam = this.#snapped(c ? fitCamera(c, width, height) : { cx: width / 2, cy: height / 2, k: 1 });

    app.canvas.addEventListener("pointermove", this.#onPointerMove);
    app.canvas.addEventListener("pointerleave", this.#onPointerLeave);
    app.canvas.addEventListener("click", this.#onClick);
    app.ticker.add((t) => this.#frame(t.deltaMS));
  }

  update(layout: Map<string, Circle>, visuals: Map<string, NodeVisual>, change: Change): void {
    this.#layout = layout;
    this.#labels = labelNames(layout);
    // Scene.update reports whether anything moves; wake regardless, because
    // visuals (colours, rings) can change without any motion.
    this.#scene.update(layout, visuals, change, performance.now());
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
    this.#zoomPath = this.#layout.has(path) ? path : "";
    this.#aimCamera(true);
    this.#wake();
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

  destroy(): void {
    this.#destroyed = true;
    const app = this.#app;
    if (!app) return;
    app.canvas.removeEventListener("pointermove", this.#onPointerMove);
    app.canvas.removeEventListener("pointerleave", this.#onPointerLeave);
    app.canvas.removeEventListener("click", this.#onClick);
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

  #aimCamera(userInitiated: boolean): void {
    const c = this.#layout.get(this.#zoomPath);
    if (!c) return;
    const { width, height } = this.#size();
    const target = fitCamera(c, width, height);
    const prev = this.#cam.target;
    const changed = Math.abs(Math.log(target.k / prev.k)) > 1e-3;
    if (target.cx !== prev.cx || target.cy !== prev.cy || target.k !== prev.k) {
      // A zoom scales about a fixed point so the target stays on screen; a
      // pure pan (same scale) springs the centre directly.
      this.#cam.path = zoomPath(this.#camera(), target);
      retarget(this.#cam.cx, target.cx);
      retarget(this.#cam.cy, target.cy);
      retarget(this.#cam.logk, Math.log(target.k));
      this.#cam.target = target;
    }
    if (changed || userInitiated) for (const fn of this.#zoomFns) fn(target.k);
  }

  /** Advances the camera; returns true while it is still moving. */
  #stepCamera(dt: number): boolean {
    const cam = this.#cam;
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
    const path = this.#pickAt(ev);
    if (this.#app) this.#app.canvas.style.cursor = path !== null && path !== this.#zoomPath ? "pointer" : "default";
    this.#lastHover = path;
    for (const fn of this.#hoverFns) fn(path, { x: ev.clientX, y: ev.clientY });
  };

  #onPointerLeave = (ev: PointerEvent): void => {
    if (this.#lastHover === null) return;
    this.#lastHover = null;
    for (const fn of this.#hoverFns) fn(null, { x: ev.clientX, y: ev.clientY });
  };

  #onClick = (ev: MouseEvent): void => {
    const path = this.#pickAt(ev);
    for (const fn of this.#clickFns) fn(path);
  };

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
    const sceneBusy = this.#scene.step(dtMs, now, worldEps(cam.k));

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
    };
    if (!camBusy) f.spots = this.#spots = this.#placeLabels(f);
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
    v = { kind, root, body, halo, flash: null, g, gKey: "", label: null, labelKey: "", labelR: 0, labelShownAt: null };
    this.#views.set(n.path, v);
    return v;
  }

  #dropView(path: string, v: View): void {
    v.label?.texture.destroy(true);
    v.label?.destroy();
    v.root.destroy({ children: true });
    this.#views.delete(path);
  }

  /** Alpha for one worktree's marks: full, or dimmed while another worktree is isolated. */
  #touchAlpha(t: Touch): number {
    return this.#isolated === null || t.worktree === this.#isolated ? 1 : ISOLATE_DIM;
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
    const night = this.#theme === "night";
    const hidden = vis.ghost || vis.deleted;
    // The touch that colours the node: the isolated worktree's, else the first.
    const lead = vis.touches.find((t) => this.#touchAlpha(t) === 1);

    // Body (files): texture + tint by theme and lifecycle.
    if (v.body) {
      v.body.visible = !hidden;
      if (!hidden) {
        let tex: Texture;
        let tint = 0xffffff;
        let alpha = 1;
        if (night) {
          tex = f.bank.disc;
          tint = lead ? hexToNumber(worktreeColor(lead.colorIndex)) : NIGHT_IDLE;
          alpha = lead?.stage === "committed" ? 0.85 : 1;
        } else if (vis.tinted && lead) {
          tex = f.bank.worktreeSphere(worktreeColor(lead.colorIndex));
          alpha = 0.9;
        } else {
          tex = f.bank.sphere(colorForExt(vis.ext));
        }
        if (v.body.texture !== tex) v.body.texture = tex;
        v.body.tint = tint;
        v.body.alpha = alpha;
        v.body.width = v.body.height = R * 2;
      }
    }

    // Halo: live uncommitted work glows in its worktree's colour.
    if (v.halo) {
      const live = vis.touches.filter((t) => t.stage === "uncommitted" && t.kind !== "deleted");
      const glow = live.find((t) => this.#touchAlpha(t) === 1) ?? live[0];
      const show = glow !== undefined && !hidden;
      v.halo.visible = show;
      if (show) {
        v.halo.width = v.halo.height = ((R + HALO_PX) / HALO_RING_FRAC) * 2;
        v.halo.tint = hexToNumber(worktreeColor(glow.colorIndex));
        v.halo.alpha = (night ? 0.5 : 0.6) * this.#touchAlpha(glow);
      }
    }

    // The label first: a name on the rim breaks the folder outline behind it.
    const gap = plainDir ? this.#drawLabel(v, n, R, sx, sy, f) : 0;

    // Vector parts, redrawn only when their inputs change.
    const clip = R > f.big ? clipFor(sx, sy, R, f.rect) : WHOLE;
    const sig = vis.touches.map((t) => `${t.worktree}:${t.colorIndex}:${t.stage}:${t.kind}`).join(",");
    const gKey = `${Math.round(R * 2)}|${clip.key}|${this.#styleGen}|${sig}|${vis.ghost}|${vis.deleted}|${n.aggregate ?? -1}|${gap.toFixed(3)}`;
    if (gKey !== v.gKey) {
      v.gKey = gKey;
      v.g.clear();
      if (n.isDir) this.#drawDir(v.g, n, R, clip, sx, sy, f, gap);
      else this.#drawFileRings(v.g, vis, R, clip);
    }

    this.#drawShimmer(v, n, R, f);
  }

  #drawDir(g: Graphics, n: SceneNode, R: number, clip: Clip, sx: number, sy: number, f: FrameCtx, gap: number): void {
    const night = this.#theme === "night";
    if (n.aggregate !== undefined) {
      disk(g, R, clip, sx, sy, f.rect, { color: 0xffffff, alpha: night ? 0.05 : 0.07 });
      outline(g, R, clip, 0xffffff, 0.14, 1);
      this.#drawRings(g, R, clip, n.visual.touches);
      return;
    }
    const isRoot = n.depth === 0;
    if (!night) disk(g, R, clip, sx, sy, f.rect, { color: 0xffffff, alpha: isRoot ? 0.02 : 0.03 });
    outline(g, R, clip, 0xffffff, night ? (isRoot ? 0.1 : 0.08) : isRoot ? 0.16 : 0.12, 1, gap);
  }

  #drawFileRings(g: Graphics, vis: NodeVisual, R: number, clip: Clip): void {
    const lead = vis.touches[0];
    if (vis.deleted && lead) {
      // Faint outline that stays until the deletion reaches base.
      if (clip.fill.kind === "full") g.circle(0, 0, R).fill({ color: 0xffffff, alpha: 0.02 });
      outline(g, R, clip, hexToNumber(worktreeColor(lead.colorIndex)), 0.45 * this.#touchAlpha(lead), 1);
      return;
    }
    if (vis.ghost && lead) {
      // Ghost: ~15% fill in the worktree colour and a dashed outline.
      const ghostTouch = vis.touches.find((t) => t.stage === "uncommitted" && t.kind === "added") ?? lead;
      const color = hexToNumber(worktreeColor(ghostTouch.colorIndex));
      const a = this.#touchAlpha(ghostTouch);
      if (this.#theme === "vision" && clip.fill.kind === "full") g.circle(0, 0, R).fill({ color, alpha: 0.15 * a });
      dashed(g, R, -Math.PI / 2, Math.PI * 1.5, clip, color, a, 1, 2, 2);
      this.#drawRings(
        g,
        R,
        clip,
        vis.touches.filter((t) => t.worktree !== ghostTouch.worktree),
      );
      return;
    }
    this.#drawRings(g, R, clip, vis.touches);
  }

  /** One ring (or a split ring with one arc per worktree): dashed = uncommitted, solid = committed. */
  #drawRings(g: Graphics, R: number, clip: Clip, touches: Touch[]): void {
    if (touches.length === 0) return;
    const RR = R + RING_GAP_PX;
    const segs = splitSegments(touches.length, touches.length > 1 ? SPLIT_GAP_PX / RR : 0);
    touches.forEach((t, i) => {
      const [a0, a1] = segs[i]!;
      const color = hexToNumber(lighten(worktreeColor(t.colorIndex), 0.25));
      const alpha = this.#touchAlpha(t);
      if (t.stage === "uncommitted") dashed(g, RR, a0, a1, clip, color, alpha, RING_W_PX, 4, 3);
      else if (touches.length === 1 && clip.stroke.kind === "full") g.circle(0, 0, RR).stroke({ color, alpha, width: RING_W_PX });
      else solidArc(g, RR, a0, a1, clip, color, alpha, RING_W_PX);
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
    v.flash.visible = true;
    v.flash.alpha = 0.55 * Math.sin(Math.PI * p);
    v.flash.width = v.flash.height = R * 2 * (1 + 0.25 * p);
  }

  #labelWidth(name: string): number {
    let w = this.#labelWidths.get(name);
    if (w === undefined) this.#labelWidths.set(name, (w = labelWidth(name)));
    return w;
  }

  /** At rest: where each visible folder's name goes, with collisions pushed inward or hidden. */
  #placeLabels(f: FrameCtx): Map<string, LabelSpot> {
    const cands: LabelCandidate[] = [];
    for (const n of this.#scene.nodes.values()) {
      if (!n.isDir || n.aggregate !== undefined || n.leaving) continue;
      const name = this.#labels.get(n.path);
      if (name === undefined) continue;
      // Wait until the folder stops growing/shrinking so labels never balloon.
      if (Math.abs(n.r.value - n.r.target) > 0.05 * Math.max(n.r.target, 1e-6)) continue;
      const R = n.r.value * f.k;
      if (R < LABEL_MIN_R) continue;
      const pos = this.#scene.drawPosition(n);
      const x = pos.x * f.k + f.ox;
      const y = pos.y * f.k + f.oy;
      const rim = rimView(x, y, R + LABEL_LINE_PX, f.rect);
      if (rim.kind === "hidden" || rim.kind === "covers") continue;
      cands.push({ path: n.path, x, y, r: R, width: this.#labelWidth(name) });
    }
    return placeLabels(cands);
  }

  #hideLabel(v: View): void {
    if (v.label) v.label.visible = false;
    v.labelShownAt = null;
  }

  /** Draws a folder's name; returns the half-angle to break its outline by (0 if none). */
  #drawLabel(v: View, n: SceneNode, R: number, sx: number, sy: number, f: FrameCtx): number {
    const name = this.#labels.get(n.path);
    const spot = f.spots.get(n.path);
    if (name === undefined || spot === undefined || n.leaving || R < LABEL_MIN_R) {
      this.#hideLabel(v);
      return 0;
    }
    const textR = R - spot.inset * LABEL_LINE_PX;
    const dpr = this.#app?.renderer.resolution ?? 1;
    const key = `${name}|${Math.round(textR / 12)}|${this.#theme}`;
    if (key !== v.labelKey && (!f.camBusy || !v.label)) {
      const color = this.#theme === "night" ? "rgba(235,235,245,0.55)" : "rgba(235,235,245,0.78)";
      const lbl = renderArcLabel(name, textR, color, dpr);
      if (v.label) {
        v.label.texture.destroy(true);
        v.label.destroy();
        v.label = null;
      }
      v.labelKey = key;
      if (lbl) {
        const s = new Sprite(lbl.texture);
        s.anchor.set(lbl.originX / lbl.texture.width, lbl.originY / lbl.texture.height);
        this.#labelLayer.addChild(s);
        v.label = s;
        v.labelR = textR;
      }
    }
    // Mid-zoom a cached label would balloon or shrink; hide it until it is re-rendered at rest.
    const ratio = textR / v.labelR;
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
    return spot.inset === 0 ? labelSpan(this.#labelWidth(name), textR) / 2 + LABEL_GAP_PAD_PX / textR : 0;
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
