import { describe, expect, it } from "vitest";
import { makeState } from "../layout/fixtures";
import { computeFrame } from "../layout/frame";
import { SHIMMER_MS, Scene } from "./scene";

// End to end through layout and scene: a tiny committed file merges into base
// at root zoom. Untouched, it falls below the cull radius, so without the
// linger set it would leave the scene (reading as a deletion) instead of
// shimmering.
describe("merge shimmer at root zoom", () => {
  const tree = { "big.bin": 10_000_000, "tiny.txt": 1 };
  const before = makeState(tree, { w1: [{ path: "tiny.txt", kind: "modified", stage: "committed", size: 1 }] });
  const after = makeState(tree);
  const merged = { kind: "patch" as const, merged: ["tiny.txt"] };

  function sceneAfterMerge(linger?: ReadonlySet<string>): Scene {
    const scene = new Scene();
    const f0 = computeFrame(before, 400, 400, 1);
    scene.update(f0.layout, f0.visuals, { kind: "snapshot", merged: [] }, 0);
    const f1 = computeFrame(after, 400, 400, 1, 0, linger);
    scene.update(f1.layout, f1.visuals, merged, 1000);
    return scene;
  }

  it("leaves the scene without a linger set (the bug this guards)", () => {
    expect(sceneAfterMerge().get("tiny.txt")!.leaving).toBe(true);
  });

  it("stays and shimmers while the path lingers", () => {
    const scene = sceneAfterMerge(new Set(["tiny.txt"]));
    const n = scene.get("tiny.txt")!;
    expect(n.leaving).toBe(false);
    expect(scene.shimmer(n, 1000 + SHIMMER_MS / 2)).toBeCloseTo(0.5);
  });
});
