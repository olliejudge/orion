import { describe, expect, it } from "vitest";
import {
  ancestorExcluded,
  directoryEntries,
  excludeStorageKey,
  isExcluded,
  loadDirFilterOpen,
  loadExcluded,
  nearestVisibleAncestor,
  saveDirFilterOpen,
  saveExcluded,
} from "./exclude";
import { makeState } from "./fixtures";
import { buildTree } from "./nodes";

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

describe("isExcluded", () => {
  it("is false with nothing excluded", () => {
    expect(isExcluded("src/a.ts", new Set())).toBe(false);
  });

  it("matches the directory itself and anything under it", () => {
    const ex = new Set(["src"]);
    expect(isExcluded("src", ex)).toBe(true);
    expect(isExcluded("src/a.ts", ex)).toBe(true);
    expect(isExcluded("src/lib/b.ts", ex)).toBe(true);
  });

  it("never false-matches a sibling with the same prefix", () => {
    const ex = new Set(["src"]);
    expect(isExcluded("srcfoo", ex)).toBe(false);
    expect(isExcluded("srcfoo/a.ts", ex)).toBe(false);
  });

  it("matches against any entry in the set", () => {
    const ex = new Set(["docs", "vendor"]);
    expect(isExcluded("vendor/lib.js", ex)).toBe(true);
    expect(isExcluded("README.md", ex)).toBe(false);
  });
});

describe("ancestorExcluded", () => {
  it("is false for the excluded directory itself (it stays editable)", () => {
    expect(ancestorExcluded("src", new Set(["src"]))).toBe(false);
  });

  it("is true for a descendant of an excluded directory", () => {
    expect(ancestorExcluded("src/lib/b.ts", new Set(["src"]))).toBe(true);
    expect(ancestorExcluded("src/lib", new Set(["src"]))).toBe(true);
  });

  it("is false when nothing is excluded, or the path is unrelated", () => {
    expect(ancestorExcluded("src/a.ts", new Set())).toBe(false);
    expect(ancestorExcluded("docs/a.md", new Set(["src"]))).toBe(false);
  });
});

describe("nearestVisibleAncestor", () => {
  it("returns the path unchanged when it is not excluded", () => {
    expect(nearestVisibleAncestor("src/lib", new Set())).toBe("src/lib");
  });

  it("walks up to the nearest ancestor that is not itself excluded", () => {
    expect(nearestVisibleAncestor("src/lib/deep", new Set(["src/lib"]))).toBe("src");
  });

  it("falls back to the root when every ancestor is excluded", () => {
    expect(nearestVisibleAncestor("src/lib/deep", new Set(["src"]))).toBe("");
  });
});

describe("directoryEntries", () => {
  it("lists nested directories from base and overlay paths, sorted, files omitted", () => {
    const root = buildTree(makeState({ "src/a.ts": 1, "src/lib/b.ts": 2, "README.md": 3 }, { w1: [{ path: "new/x.ts", kind: "added", stage: "uncommitted", size: 1 }] }));
    const dirs = directoryEntries(root);
    expect(dirs.map((d) => d.path)).toEqual(["new", "src"]);
    const src = dirs.find((d) => d.path === "src")!;
    expect(src.children.map((c) => c.path)).toEqual(["src/lib"]);
    expect(src.children[0]!.children).toEqual([]);
  });

  it("is empty for a repo with no directories", () => {
    expect(directoryEntries(buildTree(makeState({ "a.ts": 1 })))).toEqual([]);
  });
});

describe("loadExcluded / saveExcluded", () => {
  it("round-trips through storage, scoped by repo name", () => {
    const s = storage();
    saveExcluded("repo-a", new Set(["src", "docs"]), s);
    saveExcluded("repo-b", new Set(["vendor"]), s);
    expect(loadExcluded("repo-a", s)).toEqual(new Set(["src", "docs"]));
    expect(loadExcluded("repo-b", s)).toEqual(new Set(["vendor"]));
    expect(excludeStorageKey("repo-a")).not.toBe(excludeStorageKey("repo-b"));
  });

  it("is empty when unset", () => {
    expect(loadExcluded("repo-a", storage())).toEqual(new Set());
  });

  it("keeps stale or malformed entries harmless rather than failing", () => {
    const s = storage({ [excludeStorageKey("repo-a")]: JSON.stringify(["gone-dir", 42, null]) });
    expect(loadExcluded("repo-a", s)).toEqual(new Set(["gone-dir"]));
  });

  it("recovers from invalid JSON", () => {
    const s = storage({ [excludeStorageKey("repo-a")]: "{not json" });
    expect(loadExcluded("repo-a", s)).toEqual(new Set());
  });

  it("recovers from a JSON value that is not an array", () => {
    const s = storage({ [excludeStorageKey("repo-a")]: JSON.stringify({ src: true }) });
    expect(loadExcluded("repo-a", s)).toEqual(new Set());
  });

  it("still works when storage is unavailable", () => {
    expect(loadExcluded("repo-a", null)).toEqual(new Set());
    expect(() => saveExcluded("repo-a", new Set(["src"]), null)).not.toThrow();
  });
});

describe("loadDirFilterOpen / saveDirFilterOpen", () => {
  it("round-trips and defaults to closed on a first visit", () => {
    const s = storage();
    expect(loadDirFilterOpen(s)).toBe(false);
    saveDirFilterOpen(true, s);
    expect(loadDirFilterOpen(s)).toBe(true);
    saveDirFilterOpen(false, s);
    expect(loadDirFilterOpen(s)).toBe(false);
  });

  it("still works when storage is unavailable", () => {
    expect(loadDirFilterOpen(null)).toBe(false);
    expect(() => saveDirFilterOpen(true, null)).not.toThrow();
  });
});
