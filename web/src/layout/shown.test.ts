import { describe, expect, it } from "vitest";
import { computeFrame } from "./frame";
import { makeState } from "./fixtures";
import type { Circle } from "./pack";
import { nearestShown } from "./shown";

const circle = (path: string, over: Partial<Circle> = {}): Circle => ({ path, x: 0, y: 0, r: 10, depth: path === "" ? 0 : path.split("/").length, isDir: true, ...over });
const layoutOf = (...cs: Circle[]): Map<string, Circle> => new Map(cs.map((c) => [c.path, c]));

describe("nearestShown", () => {
  it("returns the path itself when it is on the map", () => {
    const layout = layoutOf(circle(""), circle("src"), circle("src/a.ts", { isDir: false }));
    expect(nearestShown("src/a.ts", layout)).toBe("src/a.ts");
  });

  it("returns the nearest ancestor on the map, e.g. a collapsed (aggregate) folder", () => {
    const layout = layoutOf(circle(""), circle("vendor"), circle("vendor/sub", { aggregate: 3 }));
    expect(nearestShown("vendor/sub/deep/f.js", layout)).toBe("vendor/sub");
  });

  it("never falls back to the root", () => {
    const layout = layoutOf(circle(""), circle("src"));
    expect(nearestShown("top.txt", layout)).toBeNull();
    expect(nearestShown("docs/a.md", layout)).toBeNull();
    expect(nearestShown("src/a.ts", new Map())).toBeNull();
  });

  it("finds the aggregate for a touched file collapsed at fit zoom", () => {
    const s = makeState(
      { "big.bin": 50_000_000, "vendor/sub/f0.js": 10, "vendor/sub/f1.js": 10 },
      { w1: [{ path: "vendor/sub/f1.js", kind: "modified", stage: "uncommitted", size: 10 }] },
    );
    const { layout } = computeFrame(s, 400, 400, 1);
    expect(layout.has("vendor/sub/f1.js")).toBe(false);
    expect(nearestShown("vendor/sub/f1.js", layout)).toBe(layout.has("vendor/sub") ? "vendor/sub" : "vendor");
    expect(layout.get(nearestShown("vendor/sub/f1.js", layout)!)!.aggregate).toBeGreaterThan(0);
  });
});
