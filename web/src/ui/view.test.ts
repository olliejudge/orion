import { describe, expect, it } from "vitest";
import { VIEW_KEY, loadView, nextView, saveView } from "./view";

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
