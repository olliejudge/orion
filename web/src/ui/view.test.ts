import { describe, expect, it } from "vitest";
import { VIEW_KEY, keyColorIndex, loadView, nextView, saveView } from "./view";

function memory(): Storage {
  const m = new Map<string, string>();
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

describe("view choice", () => {
  it("defaults to bubbles, and remembers a valid choice", () => {
    const s = memory();
    expect(loadView(s)).toBe("bubbles");
    saveView("partition", s);
    expect(loadView(s)).toBe("partition");
    s.setItem(VIEW_KEY, "pie");
    expect(loadView(s)).toBe("bubbles");
    expect(loadView(null)).toBe("bubbles");
  });

  it("V cycles bubbles → stars → tree map → partition → bubbles", () => {
    expect(nextView("bubbles")).toBe("stars");
    expect(nextView("stars")).toBe("treemap");
    expect(nextView("treemap")).toBe("partition");
    expect(nextView("partition")).toBe("bubbles");
  });
});

describe("keyColorIndex", () => {
  const wt = (id: string, colorIndex: number) => ({ id, path: "", label: id, head: "", isMain: id === "m", locked: false, colorIndex });
  const state = (overlays: Record<string, number>, activityFrom?: string) =>
    ({
      worktrees: new Map([wt("m", 0), wt("a", 3), wt("b", 1)].map((w) => [w.id, w])),
      overlays: new Map(Object.entries(overlays).map(([id, n]) => [id, new Map(Array.from({ length: n }, (_, i) => [`f${i}`, {}]))])),
      activity: activityFrom ? [{ ts: 0, worktree: activityFrom, kind: "modified" }] : [],
    }) as unknown as Parameters<typeof keyColorIndex>[0];

  it("uses the isolated worktree, else the lowest colour with changes, ignoring the newest activity", () => {
    expect(keyColorIndex(state({ a: 2, b: 1 }, "a"), null)).toBe(1);
    expect(keyColorIndex(state({ a: 2, b: 1 }), "a")).toBe(3);
    expect(keyColorIndex(state({}), null)).toBe(0);
    expect(keyColorIndex(null, null)).toBe(0);
  });
});
