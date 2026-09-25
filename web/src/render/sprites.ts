import { CanvasSource, Texture } from "pixi.js";
import { arcLetterAngles, fitLabel } from "./geometry";
import { LABEL_FONT_PX, LABEL_MAX_SPAN } from "./labels";
import { GLYPH_ARM, GLYPH_STROKE, type GlyphShape } from "./style";

const TEX_PX = 256; // crisp up to ~256px-wide bubbles when zoomed in
const GLYPH_TEX_PX = 128; // glyphs stop growing at GLYPH_MAX_R_PX (48 px wide), so this stays crisp at 2x

/** Radius of the bright band in the halo texture, as a fraction of the texture's half-size. */
export const HALO_RING_FRAC = 0.7;

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return { canvas, ctx };
}

/**
 * A texture the bank owns (not in Pixi's cache). Mipmapped, because these are
 * drawn anywhere from 256 px down to 3 px wide: without mips a shrunken
 * disc loses its anti-aliased edge and sparkles while it moves.
 */
function bankTexture(canvas: HTMLCanvasElement): Texture {
  return new Texture({ source: new CanvasSource({ resource: canvas, autoGenerateMipmaps: true }) });
}

/**
 * Pre-rendered textures. Every bubble is a Sprite of one of these, scaled to
 * its radius and tinted, so a frame is only transform updates (no per-node
 * vector redraws).
 */
export class TextureBank {
  #counts = new Map<string, Texture>();
  readonly disc: Texture;
  readonly halo: Texture;
  readonly glyphs: Readonly<Record<GlyphShape, Texture>>;

  constructor() {
    this.disc = this.#discTexture();
    this.halo = this.#haloTexture();
    this.glyphs = { plus: this.#glyphTexture("plus"), cross: this.#glyphTexture("cross") };
  }

  /**
   * A collapsed folder's file count, centred in the texture and rendered at
   * `dpr` (draw it at scale 1/dpr). Shared by every disc showing the same
   * number at the same size, so a frame only swaps textures when a disc's
   * font size changes.
   */
  count(n: number, fontPx: number, color: string, dpr: number): Texture {
    const key = `${n}|${fontPx}|${color}|${dpr}`;
    let t = this.#counts.get(key);
    if (!t) {
      const text = String(n);
      const font = labelFont(fontPx);
      probe ??= makeCanvas(1, 1).ctx;
      probe.font = font;
      const pad = 2;
      const { canvas, ctx } = makeCanvas((probe.measureText(text).width + 2 * pad) * dpr, (fontPx + 2 * pad) * dpr);
      ctx.scale(dpr, dpr);
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, canvas.width / dpr / 2, canvas.height / dpr / 2);
      t = Texture.from(canvas, true);
      this.#counts.set(key, t);
    }
    return t;
  }

  destroy(): void {
    for (const t of this.#counts.values()) t.destroy(true);
    this.#counts.clear();
    this.disc.destroy(true);
    this.halo.destroy(true);
    this.glyphs.plus.destroy(true);
    this.glyphs.cross.destroy(true);
  }

  /** A white "+" or "×" filling the texture's half-size box as style.ts's glyph geometry says; tinted per node. */
  #glyphTexture(shape: GlyphShape): Texture {
    const { canvas, ctx } = makeCanvas(GLYPH_TEX_PX, GLYPH_TEX_PX);
    const h = GLYPH_TEX_PX / 2;
    const arm = GLYPH_ARM * h;
    ctx.translate(h, h);
    if (shape === "cross") ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = GLYPH_STROKE * h;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-arm, 0);
    ctx.lineTo(arm, 0);
    ctx.moveTo(0, -arm);
    ctx.lineTo(0, arm);
    ctx.stroke();
    return bankTexture(canvas);
  }

  #discTexture(): Texture {
    const { canvas, ctx } = makeCanvas(TEX_PX, TEX_PX);
    const R = TEX_PX / 2;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.fill();
    return bankTexture(canvas);
  }

  /** Soft white ring (a blurred stroke) peaking at HALO_RING_FRAC; tinted per worktree. */
  #haloTexture(): Texture {
    const { canvas, ctx } = makeCanvas(TEX_PX, TEX_PX);
    const R = TEX_PX / 2;
    const inner = R * 0.4;
    const g = ctx.createRadialGradient(R, R, inner, R, R, R);
    const peak = (HALO_RING_FRAC * R - inner) / (R - inner);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(peak, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, TEX_PX, TEX_PX);
    return bankTexture(canvas);
  }
}

export interface ArcLabel {
  texture: Texture;
  /** Circle centre inside the texture, in texture pixels. */
  originX: number;
  originY: number;
}

const labelFont = (px: number): string => `500 ${px}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`;
const LABEL_FONT = labelFont(LABEL_FONT_PX);
let probe: CanvasRenderingContext2D | null = null;

function glyphWidths(chars: string[]): { widths: number[]; ellipsis: number } {
  probe ??= makeCanvas(1, 1).ctx;
  probe.font = LABEL_FONT;
  const p = probe;
  return { widths: chars.map((ch) => p.measureText(ch).width + 0.4), ellipsis: p.measureText("…").width };
}

/** Width in CSS px of a label's text as renderArcLabel sets it (before any truncation). */
export function labelWidth(text: string): number {
  return glyphWidths([...text]).widths.reduce((a, b) => a + b, 0);
}

/**
 * A folder name set along the top of a circle, with the text's centre line at
 * `textR` CSS px from the circle centre (the renderer puts it on the rim, and
 * breaks the folder outline behind it).
 *
 * Pixi has no text-on-path, so each glyph is measured and drawn individually
 * into a 2D canvas, rotated to its angle from arcLetterAngles(); the canvas is
 * cropped to the glyphs' bounding box and uploaded once as a texture. The
 * renderer caches one texture per folder and re-renders only when the text
 * radius changes bucket while the camera is at rest.
 */
export function renderArcLabel(text: string, textR: number, color: string, dpr: number): ArcLabel | null {
  const radius = textR;
  if (radius <= LABEL_FONT_PX) return null;
  const chars = [...text];
  const { widths, ellipsis } = glyphWidths(chars);
  const keep = fitLabel(widths, radius, LABEL_MAX_SPAN, ellipsis);
  if (keep === 0) return null;
  const glyphs = keep < chars.length ? [...chars.slice(0, keep), "…"] : chars;
  const gw = keep < chars.length ? [...widths.slice(0, keep), ellipsis] : widths;
  const angles = arcLetterAngles(gw, radius);

  const pad = LABEL_FONT_PX;
  const pts = angles.map((a) => ({ x: Math.cos(a) * radius, y: Math.sin(a) * radius }));
  const minX = Math.min(...pts.map((p) => p.x)) - pad;
  const maxX = Math.max(...pts.map((p) => p.x)) + pad;
  const minY = Math.min(...pts.map((p) => p.y)) - pad;
  const maxY = Math.max(...pts.map((p) => p.y)) + pad;

  const { canvas, ctx } = makeCanvas((maxX - minX) * dpr, (maxY - minY) * dpr);
  ctx.scale(dpr, dpr);
  ctx.font = LABEL_FONT;
  ctx.fillStyle = color;
  // A faint, wide shadow: invisible on the dark background, it only lifts a
  // name off a bright bubble where a pushed-in label crosses one.
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 4 * dpr;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  glyphs.forEach((ch, i) => {
    const p = pts[i]!;
    ctx.save();
    ctx.translate(p.x - minX, p.y - minY);
    ctx.rotate(angles[i]! + Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  });
  return { texture: Texture.from(canvas, true), originX: -minX * dpr, originY: -minY * dpr };
}

export interface StraightLabel {
  /** Rendered at dpr; its centre is the text's centre. */
  texture: Texture;
  /** Width of the text as drawn (after any truncation), CSS px. */
  width: number;
}

/**
 * A folder name set straight across the middle of a folder too small for it
 * on the rim, truncated with an ellipsis to `maxWidth` CSS px. Glyphs are
 * spaced as on the arc (renderArcLabel), and a tight dark shadow keeps the
 * name legible over the files it crosses.
 */
export function renderStraightLabel(text: string, maxWidth: number, color: string, dpr: number): StraightLabel | null {
  const chars = [...text];
  const { widths, ellipsis } = glyphWidths(chars);
  let keep = chars.length;
  let used = widths.reduce((a, b) => a + b, 0);
  if (used > maxWidth) {
    keep = 0;
    used = ellipsis;
    while (keep < chars.length && used + widths[keep]! <= maxWidth) used += widths[keep++]!;
    if (keep === 0) return null;
  }
  const glyphs = keep < chars.length ? [...chars.slice(0, keep), "…"] : chars;
  const gw = keep < chars.length ? [...widths.slice(0, keep), ellipsis] : widths;

  const pad = LABEL_FONT_PX / 2 + 2;
  const { canvas, ctx } = makeCanvas((used + 2 * pad) * dpr, (LABEL_FONT_PX + 2 * pad) * dpr);
  ctx.scale(dpr, dpr);
  ctx.font = LABEL_FONT;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const y = LABEL_FONT_PX / 2 + pad;
  // Two passes: a wide soft shadow, then a tight dark one, so the name reads over bright file bubbles.
  for (const [shadow, blur] of [
    ["rgba(0,0,0,0.5)", 4],
    ["rgba(0,0,0,0.8)", 1.5],
  ] as const) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = blur * dpr;
    let x = pad;
    glyphs.forEach((ch, i) => {
      ctx.fillText(ch, x + gw[i]! / 2, y);
      x += gw[i]!;
    });
  }
  return { texture: Texture.from(canvas, true), width: used };
}
