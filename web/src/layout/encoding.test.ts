import { describe, expect, it } from "vitest";
import type { ChangeEntry } from "../protocol";
import { encode, encodeAll } from "./encoding";
import { makeState } from "./fixtures";
import type { Circle } from "./pack";

const e = (path: string, kind: ChangeEntry["kind"], stage: ChangeEntry["stage"], from?: string, touched?: number): ChangeEntry => ({
  path,
  kind,
  stage,
  size: 10,
  ...(from ? { from } : {}),
  ...(touched ? { touched } : {}),
});

describe("encode", () => {
  it("leaves an untouched base file plain", () => {
    expect(encode(makeState({ "src/a.ts": 5 }), "src/a.ts")).toEqual({ path: "src/a.ts", touches: [], state: "unchanged" });
  });

  it("carries the base file's last commit time, and each change's own time", () => {
    const s = makeState({ "a.ts": 5, "b.ts": 5 }, { w1: [e("a.ts", "modified", "uncommitted", undefined, 9_000)] }, undefined, { "a.ts": 1_000, "b.ts": 2_000 });
    expect(encode(s, "b.ts")).toEqual({ path: "b.ts", touches: [], state: "unchanged", touched: 2_000 });
    expect(encode(s, "a.ts")).toMatchObject({ touched: 1_000, touches: [{ worktree: "w1", touched: 9_000 }] });
  });

  it("leaves unknown times out rather than guessing (style decides what unknown means)", () => {
    const v = encode(makeState({ "a.ts": 5 }, { w1: [e("a.ts", "modified", "uncommitted")] }), "a.ts");
    expect(v).not.toHaveProperty("touched");
    expect(v.touches[0]).not.toHaveProperty("touched");
  });

  it("uncommitted modified: one touch, edited", () => {
    const v = encode(makeState({ "a.ts": 5 }, { w1: [e("a.ts", "modified", "uncommitted")] }), "a.ts");
    expect(v.touches).toEqual([{ worktree: "w1", colorIndex: 1, stage: "uncommitted", kind: "modified" }]);
    expect(v.state).toBe("edited");
  });

  it("uncommitted added: added", () => {
    expect(encode(makeState({}, { w1: [e("n.ts", "added", "uncommitted")] }), "n.ts").state).toBe("added");
  });

  it("committed added: committed, not added", () => {
    expect(encode(makeState({}, { w1: [e("n.ts", "added", "committed")] }), "n.ts").state).toBe("committed");
  });

  it("committed touch plus someone's uncommitted touch is edited (live work wins)", () => {
    const s = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "modified", "committed")], w2: [e("a.ts", "modified", "uncommitted")] });
    expect(encode(s, "a.ts").state).toBe("edited");
  });

  it("added wins even when another worktree has committed the file", () => {
    const s = makeState({}, { w1: [e("n.ts", "added", "committed")], w2: [e("n.ts", "added", "uncommitted")] });
    expect(encode(s, "n.ts").state).toBe("added");
  });

  it("a committed deletion is deleted, not committed (it has no body to fill)", () => {
    expect(encode(makeState({ "a.ts": 5 }, { w1: [e("a.ts", "deleted", "committed")] }), "a.ts").state).toBe("deleted");
  });

  it("an uncommitted deletion beside another worktree's commit is committed (the file still stands there)", () => {
    const s = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "deleted", "uncommitted")], w2: [e("a.ts", "modified", "committed")] });
    expect(encode(s, "a.ts").state).toBe("committed");
  });

  it("committed rename: the new path is committed, the base `from` path is a committed deletion", () => {
    const s = makeState({ "old/a.ts": 5 }, { w1: [e("new/a.ts", "renamed", "committed", "old/a.ts")] });
    expect(encode(s, "new/a.ts")).toMatchObject({ state: "committed", renamedFrom: "old/a.ts" });
    expect(encode(s, "old/a.ts").state).toBe("deleted");
  });

  it("deleted only when every touch is a deletion", () => {
    const gone = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "deleted", "uncommitted")] });
    expect(encode(gone, "a.ts").state).toBe("deleted");
    const mixed = makeState({ "a.ts": 5 }, { w1: [e("a.ts", "deleted", "committed")], w2: [e("a.ts", "modified", "uncommitted")] });
    expect(encode(mixed, "a.ts").state).toBe("edited");
  });

  it("orders touches by colour index (split ring order)", () => {
    const s = makeState({ "a.ts": 5 }, { w2: [e("a.ts", "modified", "uncommitted")], w0: [e("a.ts", "modified", "committed")] });
    expect(encode(s, "a.ts").touches.map((t) => t.worktree)).toEqual(["w0", "w2"]);
  });

  it("reports renamedFrom on the new path (new: added) and marks a base `from` path as moved away (deleted)", () => {
    const s = makeState({ "old/a.ts": 5 }, { w1: [e("new/a.ts", "renamed", "uncommitted", "old/a.ts", 7_000)] });
    expect(encode(s, "new/a.ts")).toMatchObject({ renamedFrom: "old/a.ts", state: "added" });
    const from = encode(s, "old/a.ts");
    expect(from.touches).toEqual([{ worktree: "w1", colorIndex: 1, stage: "uncommitted", kind: "deleted", touched: 7_000 }]);
    expect(from.state).toBe("deleted");
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
    expect(v.get("src/a.ts")!.state).toBe("added");
    expect(v.get("vendor")!.touches).toEqual([
      { worktree: "w1", colorIndex: 1, stage: "committed", kind: "modified" },
      { worktree: "w2", colorIndex: 2, stage: "uncommitted", kind: "modified" },
    ]);
    expect(v.get("vendor")!.state).toBe("edited");
  });

  it("gives an aggregate the latest time below it: base commits, and per worktree its latest change (unknown: left out, i.e. now)", () => {
    const s = makeState(
      { "vendor/a.js": 1, "vendor/deep/b.js": 1, "other/c.js": 1 },
      {
        w1: [e("vendor/deep/b.js", "modified", "committed", undefined, 8_000), e("vendor/a.js", "modified", "committed", undefined, 6_000)],
        w2: [e("vendor/a.js", "modified", "uncommitted", undefined, 4_000), e("vendor/n.js", "added", "uncommitted")],
      },
      undefined,
      { "vendor/a.js": 1_000, "vendor/deep/b.js": 3_000, "other/c.js": 9_000 },
    );
    const v = encodeAll(s, new Map([["vendor", circle("vendor", true, 3)]])).get("vendor")!;
    expect(v.touched).toBe(3_000);
    expect(v.touches).toEqual([
      { worktree: "w1", colorIndex: 1, stage: "committed", kind: "modified", touched: 8_000 },
      { worktree: "w2", colorIndex: 2, stage: "uncommitted", kind: "modified" },
    ]);
    expect(v.state).toBe("edited");
  });

  it("leaves an aggregate with no known base times untimed", () => {
    const v = encodeAll(makeState({ "vendor/a.js": 1 }), new Map([["vendor", circle("vendor", true, 1)]])).get("vendor")!;
    expect(v).toEqual({ path: "vendor", touches: [], state: "unchanged" });
  });

  it("rolls a base file renamed out of a collapsed folder into that folder's touches", () => {
    const s = makeState({ "vendor/a.js": 1 }, { w1: [e("lib/a.js", "renamed", "committed", "vendor/a.js")] });
    const v = encodeAll(s, new Map([["vendor", circle("vendor", true, 1)]]));
    expect(v.get("vendor")!.touches).toEqual([{ worktree: "w1", colorIndex: 1, stage: "committed", kind: "modified" }]);
  });
});
