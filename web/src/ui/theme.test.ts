import { afterEach, describe, expect, it } from "vitest";
import { THEME_KEY, applyTheme, loadTheme, saveTheme } from "./theme";

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

const broken: Storage = {
  length: 0,
  clear: () => {},
  key: () => null,
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {},
};

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("theme persistence", () => {
  it("defaults to vision", () => {
    expect(loadTheme(storage())).toBe("vision");
  });

  it("round-trips through storage", () => {
    const s = storage();
    saveTheme("night", s);
    expect(s.getItem(THEME_KEY)).toBe("night");
    expect(loadTheme(s)).toBe("night");
  });

  it("ignores junk values", () => {
    expect(loadTheme(storage({ [THEME_KEY]: "sepia" }))).toBe("vision");
  });

  it("survives storage that throws or is missing", () => {
    expect(loadTheme(broken)).toBe("vision");
    expect(() => saveTheme("night", broken)).not.toThrow();
    expect(loadTheme(null)).toBe("vision");
    expect(() => saveTheme("night", null)).not.toThrow();
  });

  it("applies the theme to <html data-theme>", () => {
    applyTheme("night");
    expect(document.documentElement.dataset.theme).toBe("night");
  });
});
