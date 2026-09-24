import { CanvasSource, Texture } from "pixi.js";
import { lighten, type ExtColor } from "../colors";
import { arcLetterAngles, fitLabel } from "./geometry";

const TEX_PX = 256; // crisp up to ~256px-wide bubbles when zoomed in

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
 * sphere loses its anti-aliased edge and sparkles while it moves.
 */
function bankTexture(canvas: HTMLCanvasElement): Texture {
  return new Texture({ source: new CanvasSource({ resource: canvas, autoGenerateMipmaps: true }) });
}

/**
 * Pre-rendered textures. Every bubble is a Sprite of one of these, scaled to
 * its radius, so a frame is only transform updates (no per-node gradients).
 */
export class TextureBank {
  #spheres = new Map<string, Texture>();
  readonly disc: Texture;
  readonly halo: Texture;

  constructor() {
    this.disc = this.#discTexture();
    this.halo = this.#haloTexture();
  }

  /** Gradient-shaded sphere, same geometry as the mockup's radialGradient cx=35% cy=30% r=50%. */
  sphere(c: ExtColor): Texture {
    const key = `${c.light}|${c.base}`;
    let t = this.#spheres.get(key);
    if (!t) {
      const { canvas, ctx } = makeCanvas(TEX_PX, TEX_PX);
      const R = TEX_PX / 2;
      const g = ctx.createRadialGradient(R * 0.7, R * 0.6, 0, R * 0.7, R * 0.6, R);
      g.addColorStop(0, c.light);
      g.addColorStop(1, c.base);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(R, R, R - 1, 0, Math.PI * 2);
      ctx.fill();
      t = bankTexture(canvas);
      this.#spheres.set(key, t);
    }
    return t;
  }

  /** Sphere shaded in a worktree colour (committed-on-branch tint). */
  worktreeSphere(hex: string): Texture {
    return this.sphere({ light: lighten(hex, 0.45), base: hex });
  }

  destroy(): void {
    for (const t of this.#spheres.values()) t.destroy(true);
    this.#spheres.clear();
    this.disc.destroy(true);
    this.halo.destroy(true);
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

const LABEL_FONT_PX = 11;
const LABEL_MAX_SPAN = Math.PI * 0.8;

/**
 * A folder name set along the top arc of a circle of `screenR` CSS px.
 *
 * Pixi has no text-on-path, so each glyph is measured and drawn individually
 * into a 2D canvas, rotated to its angle from arcLetterAngles(); the canvas is
 * cropped to the glyphs' bounding box and uploaded once as a texture. The
 * renderer caches one texture per folder and re-renders only when the folder's
 * on-screen radius changes bucket while the camera is at rest.
 */
export function renderArcLabel(text: string, screenR: number, color: string, dpr: number): ArcLabel | null {
  const font = `500 ${LABEL_FONT_PX}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`;
  const radius = screenR - LABEL_FONT_PX;
  if (radius <= LABEL_FONT_PX) return null;
  const probe = makeCanvas(1, 1).ctx;
  probe.font = font;
  const chars = [...text];
  const widths = chars.map((ch) => probe.measureText(ch).width + 0.4);
  const ellipsis = probe.measureText("…").width;
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
  ctx.font = font;
  ctx.fillStyle = color;
  // A soft dark shadow keeps names legible where they cross bright bubbles.
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 3 * dpr;
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
