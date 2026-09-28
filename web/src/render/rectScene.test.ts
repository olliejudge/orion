import { describe, expect, it } from "vitest";
import type { NodeVisual } from "../layout/encoding";
import type { Box, Circle } from "../layout/pack";
import type { Change } from "../store";
import { RectScene } from "./rectScene";
import { PING_MS, PING_RECENT_MS, SHIMMER_MS } from "./scene";

const rect = (path: string, box: Box, over: Partial<Circle> = {}): Circle => ({
  path,
  x: (box.x0 + box.x1) / 2,
  y: (box.y0 + box.y1) / 2,
  r: Math.min(box.x1 - box.x0, box.y1 - box.y0) / 2,
  depth: path === "" ? 0 : path.split("/").length,
  isDir: false,
  box,
  ...over,
});
const B = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });
const visual = (path: string, over: Partial<NodeVisual> = {}): NodeVisual => ({ path, touches: [], state: "unchanged", ...over });
const patch: Change = { kind: "patch", merged: [] };

function frame(rects: Circle[], visuals: NodeVisual[] = []): [Map<string, Circle>, Map<string, NodeVisual>] {
  return [new Map(rects.map((c) => [c.path, c])), new Map(visuals.map((v) => [v.path, v]))];
}

function settle(s: RectScene, ms: number, start = 0): number {
  let now = start;
  for (let t = 0; t < ms; t += 16) s.step(16, (now += 16));
  return now;
}

describe("RectScene", () => {
  it("fades a node in at its own box when nothing above it is on screen, and skips hidden entries", () => {
    const s = new RectScene();
    s.update(...frame([rect("", B(0, 0, 100, 100), { isDir: true, hidden: true }), rect("a.ts", B(10, 10, 50, 50))]), patch, 0);
    expect(s.get("")).toBeUndefined();
    const n = s.get("a.ts")!;
    expect(s.box(n)).toEqual(B(10, 10, 50, 50));
    expect(n.alpha.value).toBe(0);
    settle(s, 700);
    expect(n.alpha.value).toBe(1);
  });

  it("grows a new node out of its nearest ancestor's current box", () => {
    const s = new RectScene();
    s.update(...frame([rect("src", B(0, 0, 100, 100), { isDir: true, aggregate: 2 })]), patch, 0);
    settle(s, 700);
    s.update(...frame([rect("src", B(0, 0, 100, 100), { isDir: true }), rect("src/lib/a.ts", B(60, 60, 90, 90))]), patch, 700);
    const n = s.get("src/lib/a.ts")!;
    expect(s.box(n)).toEqual(B(0, 0, 100, 100));
    expect(n.alpha.value).toBe(1);
    s.step(16, 716);
    expect(n.x0.value).toBeGreaterThan(0);
    settle(s, 700, 716);
    expect(s.box(n)).toEqual(B(60, 60, 90, 90));
  });

  it("springs an existing box to its new place (a zoom)", () => {
    const s = new RectScene();
    s.update(...frame([rect("a/b.ts", B(0, 0, 10, 10))]), patch, 0);
    settle(s, 700);
    s.update(...frame([rect("a/b.ts", B(0, 0, 200, 100))]), patch, 700);
    expect(s.step(16, 716)).toBe(true);
    expect(s.moving).toBe(true);
    const n = s.get("a/b.ts")!;
    expect(n.x1.value).toBeGreaterThan(10);
    expect(n.x1.value).toBeLessThan(200);
    settle(s, 700, 716);
    expect(s.moving).toBe(false);
    expect(s.box(n)).toEqual(B(0, 0, 200, 100));
  });

  it("shrinks a removed node to its centre, fades it and forgets it", () => {
    const s = new RectScene();
    s.update(...frame([rect("a.ts", B(0, 0, 40, 20))]), patch, 0);
    settle(s, 700);
    s.update(...frame([]), patch, 700);
    const n = s.get("a.ts")!;
    expect(n.leaving).toBe(true);
    expect([n.x0.target, n.x1.target, n.y0.target, n.y1.target]).toEqual([20, 20, 10, 10]);
    expect(n.alpha.target).toBe(0);
    settle(s, 1000, 700);
    expect(s.get("a.ts")).toBeUndefined();
  });

  it("snaps every spring to its target in one step (reduced motion)", () => {
    const s = new RectScene();
    s.update(...frame([rect("a.ts", B(0, 0, 10, 10))]), patch, 0);
    s.step(16, 16, true);
    s.update(...frame([rect("a.ts", B(50, 50, 80, 90))]), patch, 16);
    expect(s.step(16, 32, true)).toBe(false);
    expect(s.box(s.get("a.ts")!)).toEqual(B(50, 50, 80, 90));
  });

  it("pings fresher work, and a node first seen freshly touched, for PING_MS", () => {
    const s = new RectScene();
    const WALL = 1e12;
    const edit = (path: string, touched: number): NodeVisual =>
      visual(path, { state: "edited", touches: [{ worktree: "w1", colorIndex: 1, stage: "uncommitted", kind: "modified", touched }] });
    s.update(...frame([rect("new.ts", B(0, 0, 10, 10)), rect("old.ts", B(10, 0, 20, 10))], [edit("new.ts", WALL - 1000), edit("old.ts", WALL - PING_RECENT_MS - 1)]), patch, 0, WALL);
    expect(s.get("new.ts")!.pingAt).toBe(0);
    expect(s.get("old.ts")!.pingAt).toBeNull();
    settle(s, 1500);
    s.update(...frame([rect("new.ts", B(0, 0, 10, 10)), rect("old.ts", B(10, 0, 20, 10))], [edit("new.ts", WALL - 1000), edit("old.ts", WALL)]), patch, 2000, WALL);
    const old = s.get("old.ts")!;
    expect(s.ping(old, 2000 + PING_MS / 2)).toBeCloseTo(0.5);
    expect(s.step(16, 2000 + PING_MS + 1)).toBe(false);
    expect(s.ping(old, 2000 + PING_MS + 1)).toBeNull();
  });

  it("shimmers merged paths, or the collapsed folder standing in for them", () => {
    const s = new RectScene();
    const layout = [rect("", B(0, 0, 100, 100), { isDir: true }), rect("lib", B(0, 0, 50, 50), { isDir: true, aggregate: 3 })];
    s.update(...frame(layout), patch, 0);
    s.update(...frame(layout), { kind: "patch", merged: ["lib/x.ts"] }, 100);
    const lib = s.get("lib")!;
    expect(s.shimmer(lib, 100)).toBe(0);
    expect(s.shimmer(lib, 100 + SHIMMER_MS / 2)).toBeCloseTo(0.5);
    expect(s.get("")!.shimmerAt).toBeNull();
    s.step(16, 100 + SHIMMER_MS + 1);
    expect(s.shimmer(lib, 100 + SHIMMER_MS + 1)).toBeNull();
  });
});
