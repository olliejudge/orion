import { describe, expect, it } from "vitest";
import { makeState, wt } from "../layout/fixtures";
import type { Circle } from "../layout/pack";
import type { Activity } from "../protocol";
import { ACTIVE_WINDOW_MS, activityRows, hoverTip, legendModel, mapInsets, rowFade, shownFolder, tooltipInfo, tooltipPosition } from "./models";

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

  it("keeps row keys stable when the full buffer shifts by one item", () => {
    const buf = Array.from({ length: 200 }, (_, i) => a(i * 60_000, { path: `f${i % 7}.ts` }));
    const before = activityRows(buf);
    const after = activityRows([...buf.slice(1), a(200 * 60_000, { path: "new.ts" })]);
    expect(after[0]!.path).toBe("new.ts");
    expect(after.slice(1).map((r) => r.key)).toEqual(before.slice(0, 79).map((r) => r.key));
  });

  it("keys a coalescing row by its oldest item, so it survives new items joining it", () => {
    const before = activityRows([a(1000), a(3000)]);
    const after = activityRows([a(1000), a(3000), a(5000)]);
    expect(after).toHaveLength(1);
    expect(after[0]!.key).toBe(before[0]!.key);
  });

  it("gives identical items distinct keys", () => {
    const rows = activityRows([a(1000, { kind: "commit", path: undefined, sha: "abc" }), a(1000, { kind: "commit", path: undefined, sha: "abc" })]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("shows at most 80 rows", () => {
    const rows = activityRows(Array.from({ length: 200 }, (_, i) => a(i * 60_000, { path: `f${i}.ts` })));
    expect(rows).toHaveLength(80);
    expect(rows[0]!.path).toBe("f199.ts");
    expect(rows[79]!.path).toBe("f120.ts");
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

describe("hoverTip", () => {
  const circle = (path: string): Circle => ({ path, x: 0, y: 0, r: 5, depth: 1, isDir: false });
  const at = { x: 40, y: 60 };

  it("recomputes the hovered file's info from the latest state (a still pointer never goes stale)", () => {
    const layout = new Map([["a.ts", circle("a.ts")]]);
    const before = makeState({ "a.ts": 100 });
    const after = makeState({ "a.ts": 100 }, { w1: [{ path: "a.ts", kind: "modified", stage: "uncommitted", size: 2500 }] });
    expect(hoverTip(before, layout, { path: "a.ts", at })!.info.detail).toBe("100 bytes");
    const tip = hoverTip(after, layout, { path: "a.ts", at })!;
    expect(tip.info.detail).toBe("2.5 KB");
    expect(tip.info.touches[0]!.text).toBe("Edited, uncommitted");
    expect([tip.x, tip.y]).toEqual([40, 60]);
  });

  it("hides when nothing is hovered or the hovered path left the map", () => {
    const s = makeState({ "a.ts": 100 });
    expect(hoverTip(s, new Map([["a.ts", circle("a.ts")]]), null)).toBeNull();
    expect(hoverTip(s, new Map(), { path: "a.ts", at })).toBeNull();
    expect(hoverTip(null, new Map([["a.ts", circle("a.ts")]]), { path: "a.ts", at })).toBeNull();
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

describe("mapInsets", () => {
  it("keeps the Vision map clear of the activity column on wide screens", () => {
    expect(mapInsets("vision", 1440, 900)).toEqual({ top: 48, right: 320, bottom: 48, left: 48 });
  });

  it("keeps the Vision map above the activity sheet on narrow screens", () => {
    expect(mapInsets("vision", 720, 1000)).toEqual({ top: 48, right: 48, bottom: 64 + 320 + 16, left: 48 });
  });

  it("is full-bleed in Night (the stream floats over the map)", () => {
    expect(mapInsets("night", 1440, 900)).toEqual({ top: 48, right: 48, bottom: 48, left: 48 });
  });

  describe("with the legend's footprint (wide Vision)", () => {
    const legend = { width: 340, height: 186 };

    it("moves the map right of the legend when the root circle would pass under it", () => {
      expect(mapInsets("vision", 1440, 900, legend)).toEqual({ top: 48, right: 320, bottom: 48, left: 16 + 340 + 16 });
    });

    it("moves the map below the legend instead when that keeps it larger (tall windows)", () => {
      expect(mapInsets("vision", 1440, 1300, legend)).toEqual({ top: 16 + 186 + 16, right: 320, bottom: 48, left: 48 });
    });

    it("leaves the insets alone when the circle already clears the legend", () => {
      expect(mapInsets("vision", 2600, 900, legend)).toEqual({ top: 48, right: 320, bottom: 48, left: 48 });
    });

    it("ignores the legend in Night, on narrow screens and before it has been measured", () => {
      expect(mapInsets("night", 1440, 900, legend)).toEqual(mapInsets("night", 1440, 900));
      expect(mapInsets("vision", 700, 820, legend)).toEqual(mapInsets("vision", 700, 820));
      expect(mapInsets("vision", 1440, 900, { width: 0, height: 0 })).toEqual(mapInsets("vision", 1440, 900));
    });
  });
});

describe("tooltipPosition", () => {
  const vw = 1000;
  const vh = 800;
  it("sits below-right of the pointer when it fits", () => {
    expect(tooltipPosition(100, 100, 200, 80, vw, vh)).toEqual({ left: 114, top: 114 });
  });

  it("flips left of and above the pointer near the right and bottom edges", () => {
    expect(tooltipPosition(950, 780, 200, 80, vw, vh)).toEqual({ left: 736, top: 686 });
  });

  it("stays inside the viewport on both axes even when it cannot flip", () => {
    expect(tooltipPosition(150, 60, 280, 300, 300, 320)).toEqual({ left: 8, top: 8 });
  });
});
