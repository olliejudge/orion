import { describe, expect, it } from "vitest";
import { makeState } from "./fixtures";
import { buildTree } from "./nodes";
import { computeLayout, type Circle } from "./pack";

function repo(overrides: Record<string, number> = {}): Record<string, number> {
  const files: Record<string, number> = {};
  for (let d = 0; d < 6; d++) {
    for (let f = 0; f < 8; f++) files[`pkg${d}/file${f}.ts`] = 400 + ((d * 37 + f * 91) % 900);
  }
  files["README.md"] = 800;
  return { ...files, ...overrides };
}

function layoutOf(files: Record<string, number>, w = 1000, h = 800, opts?: { minFileR?: number; minDirR?: number }) {
  return computeLayout(buildTree(makeState(files)), w, h, opts);
}

function inside(child: Circle, parent: Circle): boolean {
  return Math.hypot(child.x - parent.x, child.y - parent.y) + child.r <= parent.r + 1e-6;
}

describe("computeLayout", () => {
  it("centres the root and fits it in the viewport", () => {
    const l = layoutOf(repo());
    const root = l.get("")!;
    expect(root).toMatchObject({ depth: 0, isDir: true });
    expect(root.x).toBeCloseTo(500);
    expect(root.y).toBeCloseTo(400);
    expect(root.r).toBeLessThanOrEqual(400);
    expect(root.r).toBeGreaterThan(390);
  });

  it("nests every child inside its parent, parents listed before children", () => {
    const l = layoutOf(repo());
    const keys = [...l.keys()];
    for (const [path, c] of l) {
      if (path === "") continue;
      const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      expect(inside(c, l.get(parentPath)!)).toBe(true);
      expect(keys.indexOf(parentPath)).toBeLessThan(keys.indexOf(path));
    }
  });

  it("is deterministic", () => {
    expect([...layoutOf(repo())]).toEqual([...layoutOf(repo())]);
  });

  it("keeps sibling order when a file grows a lot", () => {
    const before = layoutOf(repo());
    const after = layoutOf(repo({ "pkg2/file3.ts": 5000 }));
    expect([...after.keys()]).toEqual([...before.keys()]);
  });

  it("does not move anything when an edit stays inside the file's size bucket", () => {
    // pkg2/file3.ts starts at 747 bytes; 747 and 760 share a quarter-octave bucket.
    const before = layoutOf(repo());
    const after = layoutOf(repo({ "pkg2/file3.ts": 760 }));
    expect([...after]).toEqual([...before]);
  });

  it("gives empty files a visible minimum size", () => {
    const l = layoutOf({ "a.txt": 0, "b.txt": 0 }, 200, 200);
    expect(l.get("a.txt")!.r).toBeGreaterThan(10);
    expect(l.get("b.txt")!.r).toBeGreaterThan(10);
  });

  it("culls files whose radius is under minFileR", () => {
    const l = layoutOf({ "big.bin": 10_000_000, "tiny.txt": 1 }, 400, 400);
    expect(l.has("big.bin")).toBe(true);
    expect(l.has("tiny.txt")).toBe(false);
    const finer = layoutOf({ "big.bin": 10_000_000, "tiny.txt": 1 }, 400, 400, { minFileR: 0.01 });
    expect(finer.has("tiny.txt")).toBe(true);
  });

  it("collapses directories under minDirR into one aggregate circle with their file count", () => {
    const files: Record<string, number> = { "big.bin": 50_000_000 };
    for (let i = 0; i < 2; i++) files[`vendor/f${i}.js`] = 10;
    const l = layoutOf(files, 400, 400);
    const vendor = l.get("vendor")!;
    expect(vendor).toMatchObject({ isDir: true, aggregate: 2 });
    expect(vendor.r).toBeLessThan(6);
    expect([...l.keys()].filter((k) => k.startsWith("vendor/"))).toEqual([]);
  });

  it("also collapses a larger directory when every file in it would be culled", () => {
    const files: Record<string, number> = { "big.bin": 50_000_000 };
    for (let i = 0; i < 3; i++) files[`vendor/sub/f${i}.js`] = 10;
    files["vendor/g.js"] = 10;
    const l = layoutOf(files, 400, 400);
    const vendor = l.get("vendor")!;
    expect(vendor.r).toBeGreaterThanOrEqual(6);
    expect(vendor.aggregate).toBeUndefined();
    expect(l.get("vendor/sub")).toMatchObject({ aggregate: 3 });
    expect(l.has("vendor/g.js")).toBe(false);
  });

  it("never aggregates the root and does not set aggregate on normal dirs", () => {
    const l = layoutOf(repo(), 10, 10);
    expect(l.get("")!.aggregate).toBeUndefined();
    expect(layoutOf(repo()).get("pkg0")!.aggregate).toBeUndefined();
  });

  it("lays out an empty repo as just the root", () => {
    const l = computeLayout(buildTree(makeState({})), 300, 200);
    expect([...l.keys()]).toEqual([""]);
    expect(l.get("")).toMatchObject({ x: 150, y: 100, depth: 0, isDir: true });
    expect(l.get("")!.r).toBeGreaterThan(90);
  });
});
