import { describe, expect, it } from "vitest";
import { WORKTREE_COLORS, hexToNumber, lighten, worktreeColor } from "../colors";
import { encode, encodeAll, type NodeVisual } from "../layout/encoding";
import { makeState } from "../layout/fixtures";
import type { Circle } from "../layout/pack";
import { chroma, contrast, over } from "../perceptual";
import type { ChangeEntry } from "../protocol";
import { RING_GAP_PX, RING_W_PX } from "./draw";
import {
  AGE_STOPS,
  GLYPH_MAX_R_PX,
  GLYPH_MIN_R_PX,
  ISOLATE_DIM,
  TINT_RING_GAP_PX,
  TINT_RING_W_PX,
  TONES,
  ageOf,
  aggregateLook,
  fileLook,
  glyphInk,
  idleTint,
  glyphSize,
  recency,
  touchSig,
  type Theme,
} from "./style";

// One test per row of the spec §6 encoding table, built from real overlay
// entries through encode(), so the whole chain stage × kind × time → pixels
// is pinned (the Pixi drawing itself only mirrors these values).

const NOW = Date.UTC(2026, 8, 25, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const THEMES: Theme[] = ["vision", "night"];

const e = (path: string, kind: ChangeEntry["kind"], stage: ChangeEntry["stage"], from?: string, touched?: number): ChangeEntry => ({
  path,
  kind,
  stage,
  size: 10,
  ...(from ? { from } : {}),
  ...(touched ? { touched } : {}),
});

const W1 = hexToNumber(worktreeColor(1)); // w1 is colour index 1 (orange)
const W1_RING = hexToNumber(lighten(worktreeColor(1), 0.25));
const W2_RING = hexToNumber(lighten(worktreeColor(2), 0.25));

function vis(entries: Record<string, ChangeEntry[]>, path: string, base: Record<string, number> = {}): NodeVisual {
  return encode(makeState({ "src/a.ts": 5, "src/old.ts": 5 }, entries, undefined, base), path);
}

function look(entries: Record<string, ChangeEntry[]>, path: string, theme: Theme = "vision", isolated: string | null = null, base: Record<string, number> = {}) {
  return fileLook(vis(entries, path, base), theme, isolated, NOW);
}

describe("recency (age → brightness)", () => {
  it("hits each stop: an hour, a day, a week, a month, half a year, a year", () => {
    expect(AGE_STOPS.map(([age]) => recency(age))).toEqual([1, 0.8, 0.6, 0.4, 0.2, 0]);
    expect(AGE_STOPS.map(([age]) => age)).toEqual([HOUR, DAY, 7 * DAY, 30 * DAY, 180 * DAY, 365 * DAY]);
    expect(recency(0)).toBe(1);
    expect(recency(59 * MIN)).toBe(1);
  });

  it("separates the hours-to-weeks band where agent work lives", () => {
    // Each step (a day, three days, a week, two weeks, a month) is clearly apart.
    const r = [DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY].map(recency);
    for (let i = 1; i < r.length; i++) expect(r[i - 1]! - r[i]!).toBeGreaterThan(0.05);
  });

  it("falls monotonically on a log scale between the stops", () => {
    let prev = 1;
    for (let age = MIN; age < 400 * DAY; age *= 1.3) {
      const r = recency(age);
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
    }
    // Log-interpolated: the geometric midpoint of a span sits halfway between its stops.
    expect(recency(Math.sqrt(HOUR * DAY))).toBeCloseTo(0.9, 6);
  });

  it("floors at 0 for anything older, unknown (Infinity) or NaN; clock skew (the future) counts as now", () => {
    expect(recency(365 * DAY)).toBe(0);
    expect(recency(3 * 365 * DAY)).toBe(0);
    expect(recency(Infinity)).toBe(0);
    expect(recency(NaN)).toBe(0);
    expect(recency(-5 * MIN)).toBe(1);
  });
});

describe("ageOf", () => {
  it("is the time since the newest touch or base commit", () => {
    expect(ageOf(vis({}, "src/a.ts", { "src/a.ts": NOW - DAY }), NOW)).toBe(DAY);
    expect(ageOf(vis({ w1: [e("src/a.ts", "modified", "committed", undefined, NOW - HOUR)] }, "src/a.ts", { "src/a.ts": NOW - DAY }), NOW)).toBe(HOUR);
  });

  it("treats a change with an unknown time as just now, and an unchanged file with none as oldest", () => {
    expect(ageOf(vis({ w1: [e("src/a.ts", "modified", "uncommitted")] }, "src/a.ts", { "src/a.ts": NOW - DAY }), NOW)).toBe(0);
    expect(ageOf(vis({}, "src/a.ts"), NOW)).toBe(Infinity);
  });
});

describe("tones", () => {
  it.each(THEMES)("%s: changed files are clearly brighter than unchanged ones of the same age", (theme) => {
    for (const age of [0, HOUR, DAY, 7 * DAY, 30 * DAY, 180 * DAY, Infinity]) {
      const base = { "src/a.ts": NOW - age };
      const changed = look({ w1: [e("src/a.ts", "modified", "committed", undefined, NOW - age)] }, "src/a.ts", theme, null, base);
      const idle = look({}, "src/a.ts", theme, null, base);
      expect(changed.body!.alpha - idle.body!.alpha, `age ${age}`).toBeGreaterThan(0.2);
    }
  });

  it.each(THEMES)("%s: unchanged files stay neutral (cool when old, slightly warm when fresh)", (theme) => {
    for (const r of [0, 0.5, 1]) expect(chroma(`#${idleTint(theme, r).toString(16)}`)).toBeLessThan(15); // Apple colours are 70–90
  });

  it.each(THEMES)("%s: unchanged files span a wide brightness range, readable step to step", (theme) => {
    const alpha = (age: number) => look({}, "src/a.ts", theme, null, { "src/a.ts": NOW - age }).body!.alpha;
    expect(alpha(5 * MIN)).toBeGreaterThan(alpha(2 * 365 * DAY) * 5);
    // A day, a week, a month and half a year each read as their own tone.
    const steps = [DAY, 7 * DAY, 30 * DAY, 180 * DAY, 365 * DAY].map(alpha);
    for (let i = 1; i < steps.length; i++) expect(steps[i - 1]! - steps[i]!).toBeGreaterThan(0.1);
  });
});

describe("fileLook (spec §6 rows)", () => {
  it("unchanged: a flat neutral disc, as bright as its last commit is recent; nothing else", () => {
    const t = TONES.vision;
    expect(look({}, "src/a.ts", "vision", null, { "src/a.ts": NOW })).toEqual({
      body: { tint: idleTint("vision", 1), alpha: t.idleAlpha[1] },
      halo: null,
      outline: null,
      glyph: null,
      rings: { gap: RING_GAP_PX, width: RING_W_PX, arcs: [] },
      marks: 1,
    });
    // No known time: the oldest tone.
    expect(look({}, "src/a.ts").body).toEqual({ tint: idleTint("vision", 0), alpha: t.idleAlpha[0] });
  });

  it("edited, uncommitted: a flat fill in the worktree colour with a live glow, no glyph or ring", () => {
    const l = look({ w1: [e("src/a.ts", "modified", "uncommitted", undefined, NOW)] }, "src/a.ts");
    expect(l.body).toEqual({ tint: W1, alpha: 1 });
    expect(l.halo).toEqual({ color: W1, alpha: TONES.vision.halo });
    expect(l.outline).toBeNull();
    expect(l.glyph).toBeNull();
    expect(l.rings.arcs).toEqual([]);
  });

  it("added, uncommitted: the same fill and glow with a + glyph in a contrasting ink", () => {
    const l = look({ w1: [e("src/new.ts", "added", "uncommitted")] }, "src/new.ts");
    expect(l.body).toEqual({ tint: W1, alpha: 1 }); // unknown time: just now
    expect(l.halo).not.toBeNull();
    expect(l.glyph).toEqual({ shape: "plus", color: glyphInk(worktreeColor(1), "vision"), alpha: 1 });
    expect(l.rings.arcs).toEqual([]);
  });

  it.each([["modified"], ["added"]] as const)("committed %s: the fill with a thin solid ring that hugs it, no glow", (kind) => {
    const path = kind === "added" ? "src/new.ts" : "src/a.ts";
    const l = look({ w1: [e(path, kind, "committed")] }, path);
    expect(l.body).toEqual({ tint: W1, alpha: 1 });
    expect(l.halo).toBeNull();
    expect(l.glyph).toBeNull();
    expect(l.rings).toEqual({ gap: TINT_RING_GAP_PX, width: TINT_RING_W_PX, arcs: [{ worktree: "w1", color: W1_RING, alpha: 1, dashed: false }] });
    expect(TINT_RING_GAP_PX + TINT_RING_W_PX).toBeLessThan(RING_GAP_PX + RING_W_PX);
  });

  it.each([["uncommitted"], ["committed"]] as const)("deleted (%s): hollow, a rim and a × in the worktree colour", (stage) => {
    const l = look({ w1: [e("src/a.ts", "deleted", stage)] }, "src/a.ts");
    expect(l.body).toBeNull();
    expect(l.halo).toBeNull();
    expect(l.outline).toEqual({ color: W1_RING, alpha: 1 });
    expect(l.glyph).toEqual({ shape: "cross", color: W1_RING, alpha: 1 });
    expect(l.rings.arcs).toEqual([]);
  });

  it("renamed, uncommitted: the new path is added (+); the old path is deleted (×)", () => {
    const entries = { w1: [e("src/moved.ts", "renamed", "uncommitted", "src/old.ts")] };
    expect(look(entries, "src/moved.ts").glyph?.shape).toBe("plus");
    expect(look(entries, "src/old.ts")).toMatchObject({ body: null, glyph: { shape: "cross" } });
  });

  it("renamed, committed: the new path is committed (ringed); the old path is hollow", () => {
    const entries = { w1: [e("src/moved.ts", "renamed", "committed", "src/old.ts")] };
    expect(look(entries, "src/moved.ts")).toMatchObject({ body: { tint: W1 }, glyph: null, rings: { gap: TINT_RING_GAP_PX } });
    expect(look(entries, "src/old.ts").body).toBeNull();
  });

  it("touched by 2+ worktrees: a split ring, one arc per worktree in colour order, dashed or solid by stage", () => {
    const l = look({ w2: [e("src/a.ts", "modified", "uncommitted")], w1: [e("src/a.ts", "modified", "committed")] }, "src/a.ts");
    expect(l.rings).toEqual({
      gap: RING_GAP_PX,
      width: RING_W_PX,
      arcs: [
        { worktree: "w1", color: W1_RING, alpha: 1, dashed: false },
        { worktree: "w2", color: W2_RING, alpha: 1, dashed: true },
      ],
    });
    // Live work wins the fill and the glow.
    expect(l.body!.tint).toBe(hexToNumber(worktreeColor(2)));
    expect(l.halo!.color).toBe(hexToNumber(worktreeColor(2)));
  });

  it("merged into base (left the overlay): back to the unchanged disc, now freshly committed", () => {
    expect(look({}, "src/a.ts", "vision", null, { "src/a.ts": NOW }).body).toEqual({ tint: idleTint("vision", 1), alpha: TONES.vision.idleAlpha[1] });
  });

  it("fades a change's fill, glow and marks with age, but never its glyph", () => {
    const old = look({ w1: [e("src/new.ts", "added", "uncommitted", undefined, NOW - 400 * DAY)] }, "src/new.ts");
    const floor = TONES.vision.changedAlpha[0];
    expect(old.body!.alpha).toBe(floor);
    expect(old.marks).toBe(floor);
    expect(old.halo!.alpha).toBeCloseTo(TONES.vision.halo * floor, 9);
    expect(old.glyph!.alpha).toBe(1);
    const dayOld = look({ w1: [e("src/a.ts", "modified", "committed", undefined, NOW - DAY)] }, "src/a.ts");
    expect(dayOld.body!.alpha).toBeCloseTo(floor + (1 - floor) * 0.8, 9);
  });

  it("isolation dims other worktrees' fill, glyph and rings", () => {
    const l = look({ w1: [e("src/a.ts", "added", "uncommitted")] }, "src/a.ts", "vision", "w2");
    expect(l.body!.alpha).toBe(ISOLATE_DIM);
    expect(l.glyph!.alpha).toBe(ISOLATE_DIM);
    const c = look({ w1: [e("src/a.ts", "modified", "committed")] }, "src/a.ts", "vision", "w2");
    expect(c.rings.arcs[0]!.alpha).toBe(ISOLATE_DIM);
  });

  it("colours a file touched by several worktrees after the isolated one", () => {
    const l = look({ w1: [e("src/a.ts", "modified", "committed")], w2: [e("src/a.ts", "modified", "committed")] }, "src/a.ts", "vision", "w2");
    expect(l.body).toEqual({ tint: hexToNumber(worktreeColor(2)), alpha: 1 });
  });

  it("draws Night with the same system, tuned darker", () => {
    const l = look({ w1: [e("src/new.ts", "added", "uncommitted")] }, "src/new.ts", "night");
    expect(l).toMatchObject({ body: { tint: W1, alpha: 1 }, glyph: { shape: "plus" } });
    expect(look({}, "src/a.ts", "night").body).toEqual({ tint: idleTint("night", 0), alpha: TONES.night.idleAlpha[0] });
  });
});

describe("glyphs", () => {
  it("show only from GLYPH_MIN_R_PX of screen radius, and stop growing at GLYPH_MAX_R_PX", () => {
    expect(glyphSize(GLYPH_MIN_R_PX - 0.01)).toBeNull();
    expect(glyphSize(1)).toBeNull();
    expect(glyphSize(GLYPH_MIN_R_PX)).toBe(GLYPH_MIN_R_PX);
    expect(glyphSize(12)).toBe(12);
    expect(glyphSize(500)).toBe(GLYPH_MAX_R_PX);
  });

  it.each(THEMES)("%s: the ink contrasts with every worktree colour at every age (WCAG ≥ 3:1)", (theme) => {
    const tone = TONES[theme];
    for (const hex of [...WORKTREE_COLORS, worktreeColor(-1)]) {
      const ink = `#${glyphInk(hex, theme).toString(16).padStart(6, "0")}`;
      for (const a of tone.changedAlpha) {
        expect(contrast(ink, over(hex, a, tone.bg)), `${hex} at ${a}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("uses dark ink on light colours and white on dark ones", () => {
    expect(glyphInk("#ffd60a", "vision")).not.toBe(0xffffff); // yellow
    expect(glyphInk("#5e5ce6", "vision")).toBe(0xffffff); // indigo
  });
});

describe("aggregateLook", () => {
  const circle: Circle = { path: "vendor", x: 0, y: 0, r: 4, depth: 1, isDir: true, aggregate: 2 };
  const agg = (entries: Record<string, ChangeEntry[]>, theme: Theme = "vision", base: Record<string, number> = {}) => {
    const s = makeState({ "vendor/x.js": 1, "vendor/y.js": 1 }, entries, undefined, base);
    return aggregateLook(encodeAll(s, new Map([["vendor", circle]])).get("vendor")!, theme, null, NOW);
  };

  it("fills a folder whose changes are all committed in the worktree colour, with a hugging ring", () => {
    const l = agg({ w1: [e("vendor/x.js", "modified", "committed")] });
    expect(l.fill).toEqual({ color: W1, alpha: TONES.vision.aggChangedAlpha[1] });
    expect(l.halo).toBeNull();
    expect(l.rings).toMatchObject({ gap: TINT_RING_GAP_PX, arcs: [{ worktree: "w1", dashed: false }] });
  });

  it("fills live work in the worktree colour too, with its glow and a dashed ring", () => {
    const l = agg({ w1: [e("vendor/x.js", "modified", "uncommitted")] });
    expect(l.fill.color).toBe(W1);
    expect(l.halo).toEqual({ color: W1, alpha: TONES.vision.halo });
    expect(l.rings).toMatchObject({ gap: RING_GAP_PX, arcs: [{ worktree: "w1", dashed: true }] });
  });

  it("is a faint neutral disc when nothing below it is touched, brighter the more recent its newest commit", () => {
    expect(agg({}, "night")).toMatchObject({ fill: { color: 0xffffff, alpha: TONES.night.aggIdleAlpha[0] }, halo: null, rings: { arcs: [] } });
    const hot = agg({}, "vision", { "vendor/x.js": NOW - 400 * DAY, "vendor/y.js": NOW - MIN });
    const week = agg({}, "vision", { "vendor/x.js": NOW - 400 * DAY, "vendor/y.js": NOW - 7 * DAY });
    const cold = agg({}, "vision", { "vendor/x.js": NOW - 400 * DAY, "vendor/y.js": NOW - 200 * DAY });
    expect(hot.fill.alpha).toBe(TONES.vision.aggIdleAlpha[1]);
    // On the same stretched curve as files, so a week-old folder sits clearly between a hot and a cold one.
    expect(hot.fill.alpha - week.fill.alpha).toBeGreaterThan(0.08);
    expect(week.fill.alpha - cold.fill.alpha).toBeGreaterThan(0.08);
  });

  it("dims a changed folder's fill as its newest change ages", () => {
    const fresh = agg({ w1: [e("vendor/x.js", "modified", "committed", undefined, NOW - MIN)] });
    const old = agg({ w1: [e("vendor/x.js", "modified", "committed", undefined, NOW - 30 * DAY)] });
    expect(old.fill.alpha).toBeLessThan(fresh.fill.alpha);
    expect(old.fill.alpha).toBeGreaterThanOrEqual(TONES.vision.aggChangedAlpha[0]);
  });
});

describe("touchSig", () => {
  const v = (entries: Record<string, ChangeEntry[]>) => encode(makeState({ "src/a.ts": 5 }, entries), "src/a.ts");

  it("is equal for equal touches and differs when any touch field changes", () => {
    const a = v({ w1: [e("src/a.ts", "modified", "uncommitted")] });
    expect(touchSig(a)).toBe(touchSig(v({ w1: [e("src/a.ts", "modified", "uncommitted")] })));
    expect(touchSig(a)).not.toBe(touchSig(v({ w1: [e("src/a.ts", "modified", "committed")] })));
    expect(touchSig(a)).not.toBe(touchSig(v({ w1: [e("src/a.ts", "deleted", "uncommitted")] })));
    expect(touchSig(a)).not.toBe(touchSig(v({ w2: [e("src/a.ts", "modified", "uncommitted")] })));
    expect(touchSig(v({}))).toBe("");
  });

  it("is computed once per visual (visuals are immutable, so the per-frame key allocates nothing new)", () => {
    const a = v({ w1: [e("src/a.ts", "modified", "uncommitted")] });
    const first = touchSig(a);
    a.touches.length = 0; // never happens in practice; shows the cached value is reused
    expect(touchSig(a)).toBe(first);
  });
});
