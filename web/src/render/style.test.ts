import { describe, expect, it } from "vitest";
import { EXT_GROUPS, VISION_FILE_ALPHA, hexToNumber, lighten, worktreeColor } from "../colors";
import { encode, encodeAll } from "../layout/encoding";
import { makeState } from "../layout/fixtures";
import type { Circle } from "../layout/pack";
import type { ChangeEntry } from "../protocol";
import { RING_GAP_PX, RING_W_PX } from "./draw";
import { ISOLATE_DIM, NIGHT_IDLE, TINT_RING_GAP_PX, TINT_RING_W_PX, aggregateLook, fileLook } from "./style";

// One test per row of the spec §6 worktree-encoding table, built from real
// overlay entries through encode(), so the whole chain stage × kind → pixels
// is pinned (the Pixi drawing itself only mirrors these values).

const e = (path: string, kind: ChangeEntry["kind"], stage: ChangeEntry["stage"], from?: string): ChangeEntry => ({
  path,
  kind,
  stage,
  size: 10,
  ...(from ? { from } : {}),
});

const W1 = hexToNumber(worktreeColor(1)); // w1 is colour index 1 (orange)
const W1_RING = hexToNumber(lighten(worktreeColor(1), 0.25));
const W2_RING = hexToNumber(lighten(worktreeColor(2), 0.25));

function look(entries: Record<string, ChangeEntry[]>, path: string, theme: "vision" | "night" = "vision", isolated: string | null = null) {
  const s = makeState({ "src/a.ts": 5, "src/old.ts": 5 }, entries);
  return fileLook(encode(s, path), theme, isolated);
}

describe("fileLook (spec §6 rows, Vision)", () => {
  it("untouched file: a translucent file-type sphere, nothing else", () => {
    expect(look({}, "src/a.ts")).toEqual({
      body: { kind: "ext", color: EXT_GROUPS.web, alpha: VISION_FILE_ALPHA },
      halo: null,
      outline: null,
      rings: { gap: RING_GAP_PX, width: RING_W_PX, arcs: [] },
    });
  });

  it("uncommitted modified: normal fill, a glowing halo and a dashed ring", () => {
    const l = look({ w1: [e("src/a.ts", "modified", "uncommitted")] }, "src/a.ts");
    expect(l.body).toEqual({ kind: "ext", color: EXT_GROUPS.web, alpha: VISION_FILE_ALPHA });
    expect(l.halo).toEqual({ color: W1, alpha: 0.6 });
    expect(l.outline).toBeNull();
    expect(l.rings).toEqual({ gap: RING_GAP_PX, width: RING_W_PX, arcs: [{ worktree: "w1", color: W1_RING, alpha: 1, dashed: true }] });
  });

  it("uncommitted added: a ghost (15% worktree fill, dashed outline), no solid body", () => {
    const l = look({ w1: [e("src/new.ts", "added", "uncommitted")] }, "src/new.ts");
    expect(l.body).toBeNull();
    expect(l.halo).toBeNull();
    expect(l.outline).toEqual({ color: W1, alpha: 1, dashed: true, fill: W1, fillAlpha: 0.15 });
    expect(l.rings.arcs).toEqual([]);
  });

  it.each([["modified"], ["added"]] as const)("committed %s: a solid sphere tinted in the worktree colour with a thin solid ring that hugs it", (kind) => {
    const path = kind === "added" ? "src/new.ts" : "src/a.ts";
    const l = look({ w1: [e(path, kind, "committed")] }, path);
    expect(l.body).toEqual({ kind: "worktree", color: worktreeColor(1), alpha: 1 });
    expect(l.halo).toBeNull();
    expect(l.outline).toBeNull();
    expect(l.rings).toEqual({
      gap: TINT_RING_GAP_PX,
      width: TINT_RING_W_PX,
      arcs: [{ worktree: "w1", color: W1_RING, alpha: 1, dashed: false }],
    });
    expect(TINT_RING_GAP_PX + TINT_RING_W_PX).toBeLessThan(RING_GAP_PX);
  });

  it.each([["uncommitted"], ["committed"]] as const)("deleted (%s): a faint outline and no body, halo or ring", (stage) => {
    const l = look({ w1: [e("src/a.ts", "deleted", stage)] }, "src/a.ts");
    expect(l.body).toBeNull();
    expect(l.halo).toBeNull();
    expect(l.outline).toEqual({ color: W1, alpha: 0.45, dashed: false, fill: 0xffffff, fillAlpha: 0.02 });
    expect(l.rings.arcs).toEqual([]);
  });

  it("renamed, uncommitted: the new path is live work (fill, halo, dashed ring); the old path is a faint outline", () => {
    const entries = { w1: [e("src/moved.ts", "renamed", "uncommitted", "src/old.ts")] };
    const to = look(entries, "src/moved.ts");
    expect(to.body?.kind).toBe("ext");
    expect(to.halo).not.toBeNull();
    expect(to.rings.arcs[0]!.dashed).toBe(true);
    expect(look(entries, "src/old.ts").outline).toMatchObject({ dashed: false, alpha: 0.45 });
  });

  it("renamed, committed: the new path is a solid tinted sphere; the old path is a faint outline", () => {
    const entries = { w1: [e("src/moved.ts", "renamed", "committed", "src/old.ts")] };
    expect(look(entries, "src/moved.ts").body).toEqual({ kind: "worktree", color: worktreeColor(1), alpha: 1 });
    expect(look(entries, "src/old.ts").body).toBeNull();
  });

  it("touched by 2+ worktrees: a split ring, one arc per worktree in colour order, dashed or solid by stage", () => {
    const l = look({ w2: [e("src/a.ts", "modified", "uncommitted")], w1: [e("src/a.ts", "modified", "committed")] }, "src/a.ts");
    expect(l.rings.arcs).toEqual([
      { worktree: "w1", color: W1_RING, alpha: 1, dashed: false },
      { worktree: "w2", color: W2_RING, alpha: 1, dashed: true },
    ]);
    // Live work elsewhere wins: normal fill with the live worktree's halo.
    expect(l.body?.kind).toBe("ext");
    expect(l.rings.gap).toBe(RING_GAP_PX);
  });

  it("merged into base (left the overlay): back to the plain file-type sphere", () => {
    expect(look({}, "src/a.ts").body).toEqual({ kind: "ext", color: EXT_GROUPS.web, alpha: VISION_FILE_ALPHA });
  });

  it("isolation dims other worktrees' marks and shows the file-type fill when only they touch it", () => {
    const l = look({ w1: [e("src/a.ts", "modified", "committed")] }, "src/a.ts", "vision", "w2");
    expect(l.body?.kind).toBe("ext");
    expect(l.rings.arcs[0]!.alpha).toBe(ISOLATE_DIM);
  });
});

describe("fileLook (Night)", () => {
  it("draws idle files as flat #3a3a44 discs and touched ones flat in the worktree colour", () => {
    expect(look({}, "src/a.ts", "night").body).toEqual({ kind: "flat", tint: NIGHT_IDLE, alpha: 1 });
    expect(look({ w1: [e("src/a.ts", "modified", "uncommitted")] }, "src/a.ts", "night").body).toEqual({ kind: "flat", tint: W1, alpha: 1 });
    expect(look({ w1: [e("src/a.ts", "modified", "committed")] }, "src/a.ts", "night").body).toEqual({ kind: "flat", tint: W1, alpha: 0.85 });
  });

  it("gives a ghost no fill in Night, only its dashed outline", () => {
    expect(look({ w1: [e("src/new.ts", "added", "uncommitted")] }, "src/new.ts", "night").outline).toMatchObject({ dashed: true, fillAlpha: 0 });
  });
});

describe("aggregateLook", () => {
  const circle: Circle = { path: "vendor", x: 0, y: 0, r: 4, depth: 1, isDir: true, aggregate: 2 };
  const agg = (entries: Record<string, ChangeEntry[]>, theme: "vision" | "night" = "vision") => {
    const s = makeState({ "vendor/x.js": 1, "vendor/y.js": 1 }, entries);
    return aggregateLook(encodeAll(s, new Map([["vendor", circle]])).get("vendor")!, theme, null);
  };

  it("fills a folder whose changes are all committed solidly in the worktree colour, with a hugging ring", () => {
    const l = agg({ w1: [e("vendor/x.js", "modified", "committed")] });
    expect(l.fill).toEqual({ color: W1, alpha: 0.55 });
    expect(l.halo).toBeNull();
    expect(l.rings).toMatchObject({ gap: TINT_RING_GAP_PX, arcs: [{ worktree: "w1", dashed: false }] });
  });

  it("keeps live work as a faint disc with the worktree's halo and a dashed ring", () => {
    const l = agg({ w1: [e("vendor/x.js", "modified", "uncommitted")] });
    expect(l.fill).toEqual({ color: 0xffffff, alpha: 0.07 });
    expect(l.halo).toEqual({ color: W1, alpha: 0.6 });
    expect(l.rings).toMatchObject({ gap: RING_GAP_PX, arcs: [{ worktree: "w1", dashed: true }] });
  });

  it("is a faint neutral disc when nothing below it is touched", () => {
    expect(agg({}, "night")).toMatchObject({ fill: { color: 0xffffff, alpha: 0.05 }, halo: null, rings: { arcs: [] } });
  });
});
