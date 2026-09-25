import { describe, expect, it } from "vitest";
import { hexToNumber, worktreeColor } from "../colors";
import { NIGHT_IDLE } from "../render/style";
import { KEY_OPEN_KEY, hexOf, keyEntries, loadKeyOpen, saveKeyOpen, type KeyEntry, type KeyEntryId } from "./encodingKey";

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
  it("lists the same six states in both themes", () => {
    const ids = ["unchanged", "edited", "added", "committed", "deleted", "merged"];
    expect(keyEntries("vision").map((e) => e.id)).toEqual(ids);
    expect(keyEntries("night").map((e) => e.id)).toEqual(ids);
  });

  it("draws unchanged files as file-type spheres of two sizes in Vision, idle grey discs in Night", () => {
    const [small, big] = entry("vision", "unchanged").marks;
    expect(small!.r).toBeLessThan(big!.r);
    expect(small!.look.body?.kind).toBe("ext");
    expect(big!.look.body?.kind).toBe("ext");
    expect(small!.look.body).not.toEqual(big!.look.body); // two file types, two tints
    for (const m of entry("night", "unchanged").marks) expect(m.look.body).toEqual({ kind: "flat", tint: NIGHT_IDLE, alpha: 1 });
  });

  it("gives uncommitted edits a halo and a dashed ring in the worktree colour", () => {
    for (const theme of ["vision", "night"] as const) {
      const look = entry(theme, "edited").marks[0]!.look;
      expect(look.halo?.color).toBe(hexToNumber(MAIN));
      expect(look.rings.arcs).toHaveLength(1);
      expect(look.rings.arcs[0]!.dashed).toBe(true);
    }
  });

  it("draws uncommitted adds as ghosts: no body, a dashed outline, a faint fill in Vision only", () => {
    const vision = entry("vision", "added").marks[0]!.look;
    expect(vision.body).toBeNull();
    expect(vision.outline).toMatchObject({ dashed: true, color: hexToNumber(MAIN) });
    expect(vision.outline!.fillAlpha).toBeGreaterThan(0);
    expect(entry("night", "added").marks[0]!.look.outline!.fillAlpha).toBe(0);
  });

  it("fills committed-on-branch files in the worktree colour with a solid ring", () => {
    const vision = entry("vision", "committed").marks[0]!.look;
    expect(vision.body).toEqual({ kind: "worktree", color: MAIN, alpha: 1 });
    expect(vision.rings.arcs[0]!.dashed).toBe(false);
    expect(vision.halo).toBeNull();
    expect(entry("night", "committed").marks[0]!.look.body).toMatchObject({ kind: "flat", tint: hexToNumber(MAIN) });
  });

  it("shrinks deletions to a faint solid outline", () => {
    const d = entry("vision", "deleted").marks[0]!;
    expect(d.r).toBeLessThan(entry("vision", "edited").marks[0]!.r);
    expect(d.look.body).toBeNull();
    expect(d.look.outline).toMatchObject({ dashed: false });
    expect(d.look.outline!.alpha).toBeLessThan(1);
  });

  it("marks a merge as an unchanged file with the shimmer", () => {
    const m = entry("vision", "merged").marks;
    expect(m.map((x) => x.shimmer)).toEqual([true]);
    expect(m[0]!.look.body?.kind).toBe("ext");
    expect(keyEntries("vision").flatMap((e) => e.marks).filter((x) => x.shimmer)).toHaveLength(1);
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
