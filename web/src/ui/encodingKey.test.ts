import { describe, expect, it } from "vitest";
import { hexToNumber, worktreeColor } from "../colors";
import { TONES, glyphSize } from "../render/style";
import { AGE_SAMPLES_MS, KEY_OPEN_KEY, SWATCH_W, hexOf, keyEntries, loadKeyOpen, saveKeyOpen, type KeyEntry, type KeyEntryId } from "./encodingKey";

const MAIN = worktreeColor(0);

function entry(theme: "vision" | "night", id: KeyEntryId): KeyEntry {
  const e = keyEntries(theme).find((x) => x.id === id);
  if (!e) throw new Error(`no ${id} entry`);
  return e;
}

function storage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("keyEntries", () => {
  it("lists the same states, then the age strip, in both themes", () => {
    const ids = ["unchanged", "edited", "added", "committed", "deleted", "merged", "age"];
    expect(keyEntries("vision").map((e) => e.id)).toEqual(ids);
    expect(keyEntries("night").map((e) => e.id)).toEqual(ids);
  });

  it("draws unchanged files as quiet neutral discs of two sizes", () => {
    for (const theme of ["vision", "night"] as const) {
      const [small, big] = entry(theme, "unchanged").marks;
      expect(small!.r).toBeLessThan(big!.r);
      for (const m of [small!, big!]) {
        expect(m.look.body!.tint).toBe(TONES[theme].idle);
        expect(m.look).toMatchObject({ halo: null, glyph: null, rings: { arcs: [] } });
      }
    }
  });

  it("fills uncommitted edits in the worktree colour with a glow, and no glyph or ring", () => {
    for (const theme of ["vision", "night"] as const) {
      const look = entry(theme, "edited").marks[0]!.look;
      expect(look.body).toEqual({ tint: hexToNumber(MAIN), alpha: 1 });
      expect(look.halo?.color).toBe(hexToNumber(MAIN));
      expect(look.glyph).toBeNull();
      expect(look.rings.arcs).toHaveLength(0);
    }
  });

  it("marks uncommitted adds with a + big enough to show", () => {
    const m = entry("vision", "added").marks[0]!;
    expect(m.look.body?.tint).toBe(hexToNumber(MAIN));
    expect(m.look.glyph?.shape).toBe("plus");
    expect(m.glyph).toBe(glyphSize(m.r));
    expect(m.glyph).not.toBeNull();
  });

  it("fills committed-on-branch files in the worktree colour with a solid ring and no glow", () => {
    const look = entry("vision", "committed").marks[0]!.look;
    expect(look.body?.tint).toBe(hexToNumber(MAIN));
    expect(look.rings.arcs).toHaveLength(1);
    expect(look.rings.arcs[0]!.dashed).toBe(false);
    expect(look.halo).toBeNull();
  });

  it("shrinks deletions to a hollow rim with a ×, still big enough for the glyph", () => {
    const d = entry("vision", "deleted").marks[0]!;
    expect(d.look.body).toBeNull();
    expect(d.look.outline).not.toBeNull();
    expect(d.look.glyph?.shape).toBe("cross");
    expect(d.glyph).not.toBeNull();
  });

  it("marks a merge as a freshly committed unchanged file with the shimmer", () => {
    const m = entry("vision", "merged").marks;
    expect(m.map((x) => x.shimmer)).toEqual([true]);
    expect(m[0]!.look.body).toEqual({ tint: TONES.vision.idle, alpha: TONES.vision.idleAlpha[1] });
    expect(keyEntries("vision").flatMap((e) => e.marks).filter((x) => x.shimmer)).toHaveLength(1);
  });

  it("draws the age strip as the map's own tones, fading left to right from now to months ago", () => {
    for (const theme of ["vision", "night"] as const) {
      const marks = entry(theme, "age").marks;
      expect(marks).toHaveLength(AGE_SAMPLES_MS.length);
      const alphas = marks.map((m) => m.look.body!.alpha);
      expect(alphas[0]).toBe(TONES[theme].idleAlpha[1]);
      expect(alphas.at(-1)).toBe(TONES[theme].idleAlpha[0]);
      for (let i = 1; i < alphas.length; i++) expect(alphas[i]!).toBeLessThan(alphas[i - 1]!);
      const xs = marks.map((m) => m.cx);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
      expect(Math.min(...xs) - marks[0]!.r).toBeGreaterThanOrEqual(0);
      expect(Math.max(...xs) + marks[0]!.r).toBeLessThanOrEqual(SWATCH_W);
    }
  });
});

describe("hexOf", () => {
  it("formats a Pixi colour as #rrggbb", () => {
    expect(hexOf(0x0a84ff)).toBe("#0a84ff");
    expect(hexOf(0x000001)).toBe("#000001");
  });
});

describe("key open/closed persistence", () => {
  it("is open on a first visit and remembers the viewer's choice", () => {
    const s = storage();
    expect(loadKeyOpen(s)).toBe(true);
    saveKeyOpen(false, s);
    expect(s.getItem(KEY_OPEN_KEY)).toBe("closed");
    expect(loadKeyOpen(s)).toBe(false);
    saveKeyOpen(true, s);
    expect(loadKeyOpen(s)).toBe(true);
  });

  it("uses the fallback only while nothing is remembered", () => {
    expect(loadKeyOpen(storage(), false)).toBe(false);
    expect(loadKeyOpen(storage({ [KEY_OPEN_KEY]: "open" }), false)).toBe(true);
    expect(loadKeyOpen(storage({ [KEY_OPEN_KEY]: "closed" }), true)).toBe(false);
    expect(loadKeyOpen(storage({ [KEY_OPEN_KEY]: "junk" }), false)).toBe(false);
  });

  it("stays open when storage throws or is missing", () => {
    const broken = {
      ...storage(),
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as Storage;
    expect(loadKeyOpen(broken)).toBe(true);
    expect(() => saveKeyOpen(false, broken)).not.toThrow();
    expect(loadKeyOpen(null)).toBe(true);
    expect(() => saveKeyOpen(false, null)).not.toThrow();
  });
});
