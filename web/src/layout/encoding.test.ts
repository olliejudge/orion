import { describe, expect, it } from "vitest";
import type { ChangeEntry } from "../protocol";
import { encode, encodeAll } from "./encoding";
import { makeState } from "./fixtures";
import type { Circle } from "./pack";

const e = (path: string, kind: ChangeEntry["kind"], stage: ChangeEntry["stage"], from?: string): ChangeEntry => ({
  path,
  kind,
  stage,
  size: 10,
  ...(from ? { from } : {}),
});

describe("encode", () => {
  it("leaves an untouched base file plain", () => {
    expect(encode(makeState({ "src/a.ts": 5 }), "src/a.ts")).toEqual({
      path: "src/a.ts",
      ext: "ts",
      touches: [],
      ghost: false,
      deleted: false,
      tinted: false,
    });
  });

  it("uncommitted modified: one touch, normal fill (not ghost, not tinted)", () => {
    const v = encode(makeState({ "a.ts": 5 }, { w1: [e("a.ts", "modified", "uncommitted")] }), "a.ts");
    expect(v.touches).toEqual([{ worktree: "w1", colorIndex: 1, stage: "uncommitted", kind: "modified" }]);
    expect(v).toMatchObject({ ghost: false, tinted: false, deleted: false });
  });

  it("uncommitted added: ghost", () => {
    expect(encode(makeState({}, { w1: [e("n.ts", "added", "uncommitted")] }), "n.ts")).toMatchObject({ ghost: true, tinted: false });
  });

  it("committed added: tinted, not ghost", () => {
    expect(encode(makeState({}, { w1: [e("n.ts", "added", "committed")] }), "n.ts")).toMatchObject({ ghost: false, tinted: true });
  });

  it("committed touch plus someone's uncommitted touch is not tinted", () => {
    const s = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "modified", "committed")], w2: [e("a.ts", "modified", "uncommitted")] });
    expect(encode(s, "a.ts").tinted).toBe(false);
  });

  it("ghost wins even when another worktree has committed the file", () => {
    const s = makeState({}, { w1: [e("n.ts", "added", "committed")], w2: [e("n.ts", "added", "uncommitted")] });
    expect(encode(s, "n.ts")).toMatchObject({ ghost: true, tinted: false });
  });

  it("a committed deletion is deleted, not tinted (it has no body to tint)", () => {
    const v = encode(makeState({ "a.ts": 5 }, { w1: [e("a.ts", "deleted", "committed")] }), "a.ts");
    expect(v).toMatchObject({ deleted: true, tinted: false, ghost: false });
  });

  it("committed rename: the new path is tinted, the base `from` path is a committed deletion", () => {
    const s = makeState({ "old/a.ts": 5 }, { w1: [e("new/a.ts", "renamed", "committed", "old/a.ts")] });
    expect(encode(s, "new/a.ts")).toMatchObject({ tinted: true, deleted: false, renamedFrom: "old/a.ts" });
    expect(encode(s, "old/a.ts")).toMatchObject({ tinted: false, deleted: true });
  });

  it("deleted only when every touch is a deletion", () => {
    const gone = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "deleted", "uncommitted")] });
    expect(encode(gone, "a.ts").deleted).toBe(true);
    const mixed = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "deleted", "committed")], w2: [e("a.ts", "modified", "uncommitted")] });
    expect(encode(mixed, "a.ts").deleted).toBe(false);
  });

  it("orders touches by colour index (split ring order)", () => {
    const s = makeState({ "a.ts": 5 }, { w2: [e("a.ts", "modified", "uncommitted")], w0: [e("a.ts", "modified", "committed")] });
    expect(encode(s, "a.ts").touches.map((t) => t.worktree)).toEqual(["w0", "w2"]);
  });

  it("reports renamedFrom on the new path and marks a base `from` path as moved away (deleted)", () => {
    const s = makeState({ "old/a.ts": 5 }, { w1: [e("new/a.ts", "renamed", "uncommitted", "old/a.ts")] });
    expect(encode(s, "new/a.ts")).toMatchObject({ renamedFrom: "old/a.ts", ghost: false, deleted: false });
    const from = encode(s, "old/a.ts");
    expect(from.touches).toEqual([{ worktree: "w1", colorIndex: 1, stage: "uncommitted", kind: "deleted" }]);
    expect(from.deleted).toBe(true);
  });

  it("uses colorIndex -1 for a worktree missing from the list", () => {
    const s = makeState({}, { ghost: [e("x.ts", "added", "uncommitted")] });
    expect(encode(s, "x.ts").touches[0]!.colorIndex).toBe(-1);
  });
});

describe("encodeAll", () => {
  const circle = (path: string, isDir: boolean, aggregate?: number): Circle => ({
    path, x: 0, y: 0, r: 10, depth: 1, isDir, ...(aggregate ? { aggregate } : {}),
  });

  it("encodes files, leaves plain dirs untouched, and rolls touches up into aggregates", () => {
    const s = makeState(
      { "src/a.ts": 1, "vendor/x/y.js": 1, "vendor/z.js": 1 },
      {
        w1: [e("vendor/x/y.js", "modified", "committed"), e("src/a.ts", "added", "uncommitted")],
        w2: [e("vendor/z.js", "modified", "uncommitted"), e("vendor/new.js", "added", "committed")],
      },
    );
    const layout = new Map<string, Circle>([
      ["", circle("", true)],
      ["src", circle("src", true)],
      ["src/a.ts", circle("src/a.ts", false)],
      ["vendor", circle("vendor", true, 3)],
    ]);
    const v = encodeAll(s, layout);
    expect([...v.keys()]).toEqual(["", "src", "src/a.ts", "vendor"]);
    expect(v.get("src")!.touches).toEqual([]);
    expect(v.get("src/a.ts")!.ghost).toBe(true);
    expect(v.get("vendor")!.touches).toEqual([
      { worktree: "w1", colorIndex: 1, stage: "committed", kind: "modified" },
      { worktree: "w2", colorIndex: 2, stage: "uncommitted", kind: "modified" },
    ]);
    expect(v.get("vendor")).toMatchObject({ ghost: false, deleted: false, tinted: false });
  });

  it("rolls a base file renamed out of a collapsed folder into that folder's touches", () => {
    const s = makeState({ "vendor/a.js": 1 }, { w1: [e("lib/a.js", "renamed", "committed", "vendor/a.js")] });
    const v = encodeAll(s, new Map([["vendor", circle("vendor", true, 1)]]));
    expect(v.get("vendor")!.touches).toEqual([{ worktree: "w1", colorIndex: 1, stage: "committed", kind: "modified" }]);
  });
});
