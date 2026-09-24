import { describe, expect, it } from "vitest";
import type { NodeVisual } from "../layout/encoding";
import type { Circle } from "../layout/pack";
import type { Change } from "../store";
import { DELETED_SCALE, SHIMMER_MS, Scene } from "./scene";

const circle = (path: string, x: number, y: number, r: number, isDir = false): Circle => ({ path, x, y, r, depth: path.split("/").length, isDir });
const visual = (path: string, over: Partial<NodeVisual> = {}): NodeVisual => ({
  path, ext: "ts", touches: [], ghost: false, deleted: false, tinted: false, ...over,
});
const patch: Change = { kind: "patch", merged: [] };

function frame(circles: Circle[], visuals: NodeVisual[] = []): [Map<string, Circle>, Map<string, NodeVisual>] {
  const v = new Map(visuals.map((x) => [x.path, x]));
  for (const c of circles) if (!v.has(c.path)) v.set(c.path, visual(c.path));
  return [new Map(circles.map((c) => [c.path, c])), v];
}

function settle(scene: Scene, ms: number, start = 0): number {
  let now = start;
  for (let t = 0; t < ms; t += 16) {
    now += 16;
    scene.step(16, now);
  }
  return now;
}

describe("Scene", () => {
  it("grows new nodes from r=0 at their target position", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 10, 20, 8)]), patch, 0);
    const n = s.get("a.ts")!;
    expect(n.x.value).toBe(10);
    expect(n.y.value).toBe(20);
    expect(n.r.value).toBe(0);
    expect(n.r.target).toBe(8);
    settle(s, 700);
    expect(n.r.value).toBe(8);
  });

  it("springs existing nodes to their new layout position", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([circle("a.ts", 100, 0, 8)]), patch, 700);
    s.step(16, 716);
    const n = s.get("a.ts")!;
    expect(n.x.value).toBeGreaterThan(0);
    expect(n.x.value).toBeLessThan(100);
    settle(s, 700, 716);
    expect(n.x.value).toBe(100);
  });

  it("shrinks removed nodes out and then forgets them", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([]), patch, 700);
    expect(s.get("a.ts")!.leaving).toBe(true);
    expect(s.get("a.ts")!.r.target).toBe(0);
    settle(s, 1000, 700);
    expect(s.get("a.ts")).toBeUndefined();
  });

  it("revives a leaving node that comes back", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([]), patch, 700);
    s.step(16, 716);
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 716);
    expect(s.get("a.ts")!.leaving).toBe(false);
    expect(s.get("a.ts")!.r.target).toBe(8);
  });

  it("shrinks deleted files to a smaller outline radius", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 10)], [visual("a.ts", { deleted: true })]), patch, 0);
    expect(s.get("a.ts")!.r.target).toBeCloseTo(10 * DELETED_SCALE);
  });

  it("starts a renamed node at the old node's position and glides along an arc", () => {
    const s = new Scene();
    s.update(...frame([circle("old.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([circle("new.ts", 100, 0, 8)], [visual("new.ts", { renamedFrom: "old.ts" })]), patch, 700);
    const n = s.get("new.ts")!;
    expect(n.x.value).toBe(0);
    expect(n.r.value).toBe(8);
    expect(n.glide).toEqual({ fromX: 0, fromY: 0, toX: 100, toY: 0 });
    let now = 700;
    for (let i = 0; n.x.value < 45; i++) {
      if (i > 100) throw new Error("rename glide never reached the midpoint");
      now += 16;
      s.step(16, now);
    }
    expect(Math.abs(s.drawPosition(n).y)).toBeGreaterThan(5);
    settle(s, 800, now);
    expect(s.drawPosition(n)).toEqual({ x: 100, y: 0 });
    expect(n.glide).toBeNull();
  });

  it("falls back to growing when the rename source was never on screen", () => {
    const s = new Scene();
    s.update(...frame([circle("new.ts", 100, 0, 8)], [visual("new.ts", { renamedFrom: "culled.ts" })]), patch, 0);
    expect(s.get("new.ts")!.r.value).toBe(0);
    expect(s.get("new.ts")!.glide).toBeNull();
  });

  it("shimmers merged paths for SHIMMER_MS", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([circle("a.ts", 0, 0, 8)]), { kind: "patch", merged: ["a.ts", "not-drawn.ts"] }, 1000);
    expect(s.shimmer(s.get("a.ts")!, 1000)).toBe(0);
    expect(s.shimmer(s.get("a.ts")!, 1000 + SHIMMER_MS / 2)).toBeCloseTo(0.5);
    expect(s.step(16, 1000 + SHIMMER_MS / 2)).toBe(true);
    expect(s.step(16, 1000 + SHIMMER_MS + 1)).toBe(false);
    expect(s.shimmer(s.get("a.ts")!, 1000 + SHIMMER_MS + 1)).toBeNull();
  });

  it("snaps every node to its target in one step when asked to (reduced motion)", () => {
    const s = new Scene();
    s.update(...frame([circle("old.ts", 0, 0, 8)]), patch, 0);
    settle(s, 700);
    s.update(...frame([circle("a.ts", 10, 20, 8), circle("new.ts", 100, 0, 6)], [visual("new.ts", { renamedFrom: "old.ts" })]), patch, 1000);
    expect(s.step(16, 1016, undefined, true)).toBe(false);
    const a = s.get("a.ts")!;
    expect([a.x.value, a.y.value, a.r.value, a.alpha.value]).toEqual([10, 20, 8, 1]);
    const moved = s.get("new.ts")!;
    expect([moved.x.value, moved.y.value, moved.r.value]).toEqual([100, 0, 6]);
    expect(moved.glide).toBeNull();
    expect(s.get("old.ts")).toBeUndefined(); // leaving nodes are gone at once
  });

  it("reports idle once everything has settled", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    expect(s.step(16, 16)).toBe(true);
    settle(s, 700, 16);
    expect(s.step(16, 800)).toBe(false);
  });

  it("keeps layout order for iteration (parents before children)", () => {
    const s = new Scene();
    s.update(...frame([circle("", 0, 0, 100, true), circle("src", 0, 0, 50, true), circle("src/a.ts", 0, 0, 5)]), patch, 0);
    expect([...s.nodes.keys()]).toEqual(["", "src", "src/a.ts"]);
  });

  it("grows sub-epsilon radii when stepped with a scale-aware epsilon", () => {
    const s = new Scene();
    const eps = 0.5 / 1000; // renderer passes ~0.5 screen px / k, here k = 1000
    s.update(...frame([circle("a.ts", 0, 0, 0.0015)]), patch, 0);
    const n = s.get("a.ts")!;
    expect(s.step(16, 16, eps)).toBe(true);
    expect(n.r.value).toBeGreaterThan(0);
    expect(n.r.value).toBeLessThan(0.0015);
    const second = n.r.value;
    expect(s.step(16, 32, eps)).toBe(true);
    expect(n.r.value).toBeGreaterThan(second);
    let now = 32;
    for (let i = 0; s.step(16, (now += 16), eps); i++) {
      if (i > 100) throw new Error("scene never settled");
    }
    expect(n.r.value).toBe(0.0015);
  });

  it("keeps the alpha fade on its own epsilon when a large world epsilon is passed", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 100)]), patch, 0);
    settle(s, 700);
    s.update(...frame([]), patch, 700);
    s.step(16, 716, 5);
    expect(s.get("a.ts")!.alpha.value).toBeGreaterThan(0);
    expect(s.get("a.ts")!.alpha.value).toBeLessThan(1);
  });

  it("ignores NaN and negative dt, and clamps huge dt", () => {
    const s = new Scene();
    s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    const n = s.get("a.ts")!;
    expect(s.step(NaN, 16)).toBe(true);
    expect(s.step(-50, 32)).toBe(true);
    expect(n.r.value).toBe(0);
    expect(n.r.velocity).toBe(0);
    s.step(1e9, 48);
    expect(Number.isFinite(n.r.value)).toBe(true);
    const clamped = new Scene();
    clamped.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0);
    clamped.step(64, 64);
    expect(n.r.value).toBe(clamped.get("a.ts")!.r.value);
    expect(n.r.value).toBeLessThan(8);
  });

  it("reports from update() whether the ticker needs to run", () => {
    const s = new Scene();
    expect(s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 0)).toBe(true);
    settle(s, 700);
    expect(s.update(...frame([circle("a.ts", 0, 0, 8)]), patch, 700)).toBe(false);
    expect(s.update(...frame([circle("a.ts", 0, 0, 8)]), { kind: "patch", merged: ["a.ts"] }, 800)).toBe(true);
    settle(s, 700, 800);
    expect(s.update(...frame([circle("a.ts", 0, 0, 0.0015)]), patch, 1600)).toBe(true);
    settle(s, 700, 1600);
    expect(s.update(...frame([]), patch, 2400)).toBe(true);
  });
});
