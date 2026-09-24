import { describe, expect, it } from "vitest";
import { makeState, wt } from "../layout/fixtures";
import type { Circle } from "../layout/pack";
import type { Activity } from "../protocol";
import { ACTIVE_WINDOW_MS, activityRows, legendModel, rowFade, shownFolder, tooltipInfo } from "./models";

const NOW = 10_000_000;

describe("legendModel", () => {
  it("splits active worktrees (changes or recent activity) from idle ones", () => {
    const s = makeState(
      { "a.ts": 1 },
      { w0: [{ path: "a.ts", kind: "modified", stage: "uncommitted", size: 1 }] },
      [wt("w0", 0, "main"), wt("w1", 1, "feat/a"), wt("w2", 2, "fix/b"), wt("w3", -1, "chore/c")],
    );
    s.activity = [
      { ts: NOW - 60_000, worktree: "w1", kind: "commit", sha: "abc", subject: "Add a", files: 2 },
      { ts: NOW - ACTIVE_WINDOW_MS - 1, worktree: "w2", kind: "modified", path: "x.ts" },
    ];
    const m = legendModel(s, NOW);
    expect(m.active.map((w) => [w.id, w.changed])).toEqual([["w0", 1], ["w1", 0]]);
    expect(m.active[0]).toMatchObject({ label: "main", color: "#0a84ff" });
    expect(m.idle.map((w) => w.id)).toEqual(["w3", "w2"]);
  });

  it("keeps main first even when an active worktree has no colour yet", () => {
    const s = makeState(
      {},
      {
        w0: [{ path: "a.ts", kind: "modified", stage: "uncommitted", size: 1 }],
        w9: [{ path: "b.ts", kind: "added", stage: "uncommitted", size: 1 }],
      },
      [wt("w0", 0, "main"), wt("w9", -1, "new/x")],
    );
    expect(legendModel(s, NOW).active.map((w) => w.id)).toEqual(["w0", "w9"]);
  });
});

describe("activityRows", () => {
  const a = (ts: number, over: Partial<Activity> = {}): Activity => ({ ts, worktree: "w1", kind: "modified", path: "src/a.ts", ...over });

  it("lists newest first", () => {
    const rows = activityRows([a(1000, { path: "old.ts" }), a(90_000, { path: "new.ts" })]);
    expect(rows.map((r) => r.path)).toEqual(["new.ts", "old.ts"]);
  });

  it("coalesces bursts of the same edit (≤5s apart) into one row with a count", () => {
    const rows = activityRows([a(1000), a(4000), a(8000), a(20_000)]);
    expect(rows.map((r) => [r.ts, r.count])).toEqual([[20_000, 1], [8000, 3]]);
  });

  it("does not coalesce across paths, worktrees or kinds", () => {
    const rows = activityRows([a(1000), a(1500, { worktree: "w2" }), a(2000, { kind: "added" }), a(2500, { path: "b.ts" })]);
    expect(rows).toHaveLength(4);
  });

  it("marks commit and merge rows as emphasised", () => {
    const rows = activityRows([a(1000), a(2000, { kind: "commit", path: undefined, files: 3, subject: "Fix" }), a(3000, { kind: "merge", path: undefined, files: 2 })]);
    expect(rows.map((r) => r.emphasis)).toEqual([true, true, false]);
  });

  it("fades rows with age (Night mode), never below 0.15", () => {
    expect(rowFade(NOW, NOW)).toBe(1);
    expect(rowFade(NOW - ACTIVE_WINDOW_MS / 2, NOW)).toBeCloseTo(0.575);
    expect(rowFade(NOW - 10 * ACTIVE_WINDOW_MS, NOW)).toBe(0.15);
  });
});

describe("tooltipInfo", () => {
  const circle = (path: string, isDir: boolean, aggregate?: number): Circle => ({ path, x: 0, y: 0, r: 5, depth: 1, isDir, ...(aggregate ? { aggregate } : {}) });

  it("describes a file: path, largest size, and who touches it at what stage", () => {
    const s = makeState(
      { "src/a.ts": 1200 },
      {
        w1: [{ path: "src/a.ts", kind: "modified", stage: "committed", size: 1500 }],
        w2: [{ path: "src/a.ts", kind: "modified", stage: "uncommitted", size: 900 }],
      },
    );
    expect(tooltipInfo(s, circle("src/a.ts", false))).toEqual({
      dir: "src/",
      name: "a.ts",
      detail: "1.5 KB",
      touches: [
        { color: "#ff9f0a", label: "feat/a", text: "Edited, committed on branch" },
        { color: "#30d158", label: "fix/b", text: "Edited, uncommitted" },
      ],
    });
  });

  it("describes new, deleted and moved files", () => {
    const s = makeState(
      { "old.ts": 5, "gone.ts": 5 },
      {
        w1: [
          { path: "n.ts", kind: "added", stage: "uncommitted", size: 5 },
          { path: "gone.ts", kind: "deleted", stage: "committed", size: 0 },
          { path: "moved.ts", kind: "renamed", from: "old.ts", stage: "uncommitted", size: 5 },
        ],
      },
    );
    expect(tooltipInfo(s, circle("n.ts", false))!.touches[0]!.text).toBe("New, uncommitted");
    expect(tooltipInfo(s, circle("gone.ts", false))!.touches[0]!.text).toBe("Deleted, committed on branch");
    expect(tooltipInfo(s, circle("moved.ts", false))!.touches[0]!.text).toBe("Moved from old.ts, uncommitted");
  });

  it("describes a collapsed folder by its file count, and ignores plain folders", () => {
    const s = makeState({ "vendor/a.js": 1, "vendor/b.js": 1 });
    expect(tooltipInfo(s, circle("vendor", true, 2))).toEqual({ dir: "", name: "vendor/", detail: "2 files", touches: [] });
    expect(tooltipInfo(s, circle("vendor", true))).toBeNull();
  });
});

describe("shownFolder", () => {
  const dir = (path: string): [string, Circle] => [path, { path, x: 0, y: 0, r: 5, depth: path.split("/").length, isDir: true }];
  const layout = new Map([dir(""), dir("src"), dir("src/lib")]);

  it("is the file's folder when it is on the map", () => {
    expect(shownFolder("src/lib/a.ts", layout)).toBe("src/lib");
  });

  it("falls back to the nearest ancestor on the map, then the root", () => {
    expect(shownFolder("src/lib/deep/er/a.ts", layout)).toBe("src/lib");
    expect(shownFolder("docs/guide.md", layout)).toBe("");
    expect(shownFolder("README.md", layout)).toBe("");
  });
});
