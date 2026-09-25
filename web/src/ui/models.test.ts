import { describe, expect, it } from "vitest";
import { makeState, wt } from "../layout/fixtures";
import type { Circle } from "../layout/pack";
import type { Activity } from "../protocol";
import {
  ACTIVE_WINDOW_MS,
  activityRows,
  crumbsSize,
  crumbsSlot,
  crumbsStart,
  dirFilterTreeMaxHeight,
  hoverTip,
  legendModel,
  mapInsets,
  rowFade,
  shownFolder,
  stackFootprint,
  tooltipInfo,
  tooltipPosition,
} from "./models";

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

  it("ignores changes and recent activity under an excluded directory", () => {
    const s = makeState(
      {},
      {
        w0: [
          { path: "src/a.ts", kind: "modified", stage: "uncommitted", size: 1 },
          { path: "docs/b.md", kind: "modified", stage: "uncommitted", size: 1 },
        ],
        w1: [{ path: "docs/c.md", kind: "added", stage: "uncommitted", size: 1 }],
      },
      [wt("w0", 0, "main"), wt("w1", 1, "feat/a")],
    );
    s.activity = [{ ts: NOW, worktree: "w1", kind: "added", path: "docs/c.md" }];
    const excluded = new Set(["docs"]);
    const m = legendModel(s, NOW, excluded);
    expect(m.active.map((w) => [w.id, w.changed])).toEqual([["w0", 1]]);
    expect(m.idle.map((w) => w.id)).toEqual(["w1"]);
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

  it("drops rows whose path is under an excluded directory", () => {
    const rows = activityRows([a(1000, { path: "docs/a.md" }), a(2000, { path: "src/b.ts" })], 80, new Set(["docs"]));
    expect(rows.map((r) => r.path)).toEqual(["src/b.ts"]);
  });

  it("keeps path-less rows (commit, merge) even with an exclusion set", () => {
    const rows = activityRows([a(1000, { kind: "commit", path: undefined, sha: "abc", files: 1 })], 80, new Set(["docs"]));
    expect(rows).toHaveLength(1);
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

  it("says when each change was touched, and when an unchanged file was last committed", () => {
    const HOUR = 3_600_000;
    const s = makeState(
      { "src/a.ts": 1200, "src/b.ts": 2000, "src/c.ts": 10 },
      {
        w1: [{ path: "src/a.ts", kind: "modified", stage: "committed", size: 1500, touched: NOW - 2 * 24 * HOUR }],
        w2: [
          { path: "src/a.ts", kind: "modified", stage: "uncommitted", size: 900, touched: NOW - 4 * 60_000 },
          { path: "src/n.ts", kind: "added", stage: "uncommitted", size: 9 }, // no time yet
        ],
      },
      undefined,
      { "src/a.ts": NOW - 90 * 24 * HOUR, "src/b.ts": NOW - 90 * 24 * HOUR },
    );
    const a = tooltipInfo(s, circle("src/a.ts", false), undefined, NOW)!;
    expect(a.detail).toBe("1.5 KB · last commit 3 months ago");
    expect(a.touches.map((t) => t.text)).toEqual(["Edited, committed on branch · 2 days ago", "Edited, uncommitted · 4 min ago"]);
    expect(tooltipInfo(s, circle("src/b.ts", false), undefined, NOW)!.detail).toBe("2.0 KB · last commit 3 months ago");
    expect(tooltipInfo(s, circle("src/c.ts", false), undefined, NOW)!.detail).toBe("10 bytes"); // unknown: nothing said
    expect(tooltipInfo(s, circle("src/n.ts", false), undefined, NOW)!.touches[0]!.text).toBe("New, uncommitted");
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

  it("describes a collapsed folder by its file count", () => {
    const s = makeState({ "vendor/a.js": 1, "vendor/b.js": 1 });
    expect(tooltipInfo(s, circle("vendor", true, 2))).toEqual({ dir: "", name: "vendor/", detail: "2 files", touches: [] });
  });

  it("describes a plain folder: its path, files at any depth, and changed files per worktree", () => {
    const s = makeState(
      { "src/ui/a.ts": 1, "src/ui/b.ts": 1, "src/ui/deep/c.ts": 1, "src/d.ts": 1, "docs/x.md": 1 },
      {
        w2: [{ path: "src/ui/deep/c.ts", kind: "modified", stage: "committed", size: 1 }],
        w1: [
          { path: "src/ui/a.ts", kind: "modified", stage: "committed", size: 1 },
          { path: "src/ui/new.ts", kind: "added", stage: "uncommitted", size: 1 },
          { path: "src/d.ts", kind: "modified", stage: "uncommitted", size: 1 },
        ],
      },
    );
    expect(tooltipInfo(s, { ...circle("src/ui", true), depth: 2 })).toEqual({
      dir: "src/",
      name: "ui/",
      detail: "4 files",
      touches: [
        { color: "#ff9f0a", label: "feat/a", text: "2 changed, uncommitted" },
        { color: "#30d158", label: "fix/b", text: "1 changed, committed on branch" },
      ],
    });
    expect(tooltipInfo(s, circle("src/ui/deep", true))!.detail).toBe("1 file");
    expect(tooltipInfo(s, circle("docs", true))!.touches).toEqual([]);
  });

  it("counts a file moved out of a folder as a change to it, and a move within it once", () => {
    const s = makeState(
      { "a/old.ts": 1, "a/keep.ts": 1 },
      {
        w1: [
          { path: "b/new.ts", kind: "renamed", from: "a/old.ts", stage: "uncommitted", size: 1 },
          { path: "a/sub/keep.ts", kind: "renamed", from: "a/keep.ts", stage: "uncommitted", size: 1 },
        ],
      },
    );
    expect(tooltipInfo(s, circle("a", true))!.touches.map((t) => t.text)).toEqual(["2 changed, uncommitted"]);
    expect(tooltipInfo(s, circle("b", true))!.touches.map((t) => t.text)).toEqual(["1 changed, uncommitted"]);
  });

  it("leaves hidden folders out of the counts, as the map does", () => {
    const s = makeState(
      { "src/a.ts": 1, "src/gen/b.ts": 1, "src/gen/c.ts": 1 },
      {
        w1: [
          { path: "src/gen/b.ts", kind: "modified", stage: "uncommitted", size: 1 },
          { path: "src/a.ts", kind: "modified", stage: "committed", size: 1 },
        ],
        w2: [{ path: "src/new.ts", kind: "renamed", from: "src/gen/c.ts", stage: "uncommitted", size: 1 }],
      },
    );
    const excluded = new Set(["src/gen"]);
    const all = tooltipInfo(s, circle("src", true))!;
    expect(all.detail).toBe("4 files");
    const shown = tooltipInfo(s, circle("src", true), excluded)!;
    expect(shown.detail).toBe("2 files");
    expect(shown.touches.map((t) => t.text)).toEqual(["1 changed, committed on branch", "1 changed, uncommitted"]);
  });

  it("has no card for the repo root", () => {
    const s = makeState({ "a.ts": 1 });
    expect(tooltipInfo(s, { ...circle("", true), depth: 0 })).toBeNull();
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

  it("hides over the folder in view (its background), but not over its subfolders", () => {
    const s = makeState({ "src/ui/a.ts": 1 });
    const dir = (path: string): [string, Circle] => [path, { path, x: 0, y: 0, r: 50, depth: path.split("/").length, isDir: true }];
    const layout = new Map([dir("src"), dir("src/ui")]);
    expect(hoverTip(s, layout, { path: "src", at }, "src")).toBeNull();
    expect(hoverTip(s, layout, { path: "src/ui", at }, "src")!.info.name).toBe("ui/");
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

describe("stackFootprint", () => {
  it("sums the heights and takes the wider width, plus the gap, when both are measured", () => {
    expect(stackFootprint({ width: 196, height: 100 }, { width: 240, height: 50 }, 8)).toEqual({ width: 240, height: 158 });
  });

  it("returns the one measured panel when the other is not", () => {
    const a = { width: 196, height: 100 };
    expect(stackFootprint(a, { width: 0, height: 0 })).toEqual(a);
    expect(stackFootprint({ width: 0, height: 0 }, a)).toEqual(a);
  });

  it("is empty when neither is measured", () => {
    expect(stackFootprint({ width: 0, height: 0 }, { width: 0, height: 0 })).toEqual({ width: 0, height: 0 });
  });
});

describe("dirFilterTreeMaxHeight", () => {
  const legend = { width: 340, height: 186 };

  it("leaves the tree room down to just above the legend's bottom edge", () => {
    // panelBottom = 900 - 16 = 884; legendBottom = 16 + 186 + 8 = 210; minus the panel's own ~84px chrome.
    expect(dirFilterTreeMaxHeight(900, legend, 0)).toBe(590);
  });

  it("shrinks when the map key stacked below lifts the panel higher", () => {
    expect(dirFilterTreeMaxHeight(900, legend, 190)).toBe(400);
  });

  it("grows when the legend is taller (more worktrees) and shrinks back when it isn't", () => {
    const taller = dirFilterTreeMaxHeight(900, { width: 340, height: 300 }, 0);
    const shorter = dirFilterTreeMaxHeight(900, { width: 340, height: 100 }, 0);
    expect(taller).toBeLessThan(dirFilterTreeMaxHeight(900, legend, 0));
    expect(shorter).toBeGreaterThan(dirFilterTreeMaxHeight(900, legend, 0));
  });

  it("grows and shrinks with the viewport (a window resize)", () => {
    expect(dirFilterTreeMaxHeight(1300, legend, 0)).toBeGreaterThan(dirFilterTreeMaxHeight(900, legend, 0));
    expect(dirFilterTreeMaxHeight(700, legend, 0)).toBeLessThan(dirFilterTreeMaxHeight(900, legend, 0));
  });

  it("falls back to a plain gutter margin when the legend hasn't been measured yet", () => {
    expect(dirFilterTreeMaxHeight(900, { width: 0, height: 0 }, 0)).toBe(784);
  });

  it("never goes negative on a short window", () => {
    expect(dirFilterTreeMaxHeight(300, legend, 190)).toBe(0);
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

  describe("with the map key's footprint (bottom-left, wide Vision)", () => {
    const key = { width: 196, height: 190 };

    it("leaves the insets alone when the circle clears the key", () => {
      expect(mapInsets("vision", 1440, 900, undefined, key)).toEqual(mapInsets("vision", 1440, 900));
    });

    it("moves the map right of the open key on a small window", () => {
      expect(mapInsets("vision", 1024, 700, undefined, key)).toEqual({ top: 48, right: 320, bottom: 48, left: 16 + 196 + 16 });
    });

    it("moves the map above the key instead when that keeps it larger (tall windows)", () => {
      const wideKey = { width: 340, height: 186 };
      expect(mapInsets("vision", 1440, 1300, undefined, wideKey)).toEqual({ top: 48, right: 320, bottom: 16 + 186 + 16, left: 48 });
    });

    it("needs no room for the collapsed key", () => {
      expect(mapInsets("vision", 1024, 700, undefined, { width: 64, height: 28 })).toEqual(mapInsets("vision", 1024, 700));
    });

    it("keeps clear of the legend and the key at once", () => {
      const legend = { width: 340, height: 186 };
      const ins = mapInsets("vision", 1440, 900, legend, key);
      expect(ins).toEqual({ top: 48, right: 320, bottom: 48, left: 16 + 340 + 16 });
      // Stacked above the key and below the legend there'd be no room: it goes beside both.
      const tall = mapInsets("vision", 1024, 700, { width: 240, height: 120 }, key);
      expect(tall.left).toBeGreaterThanOrEqual(16 + 196 + 16);
      expect(tall.top).toBe(48);
      expect(tall.bottom).toBe(48);
    });

    it("ignores the key in Night and on narrow screens", () => {
      expect(mapInsets("night", 1024, 700, undefined, key)).toEqual(mapInsets("night", 1024, 700));
      expect(mapInsets("vision", 700, 820, undefined, key)).toEqual(mapInsets("vision", 700, 820));
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

describe("crumbsSlot", () => {
  const legend = { width: 340, height: 300 };
  const short = { full: 170, min: 170 };
  const long = { full: 420, min: 200 };
  // The band's left edge: right of the legend (gutter + width + gap).
  const lo = 16 + 340 + 8;

  it("centres over the map's free area when that clears the legend", () => {
    expect(crumbsSlot("vision", 1500, legend, 750, short)).toEqual({ x: 750, top: 16, maxWidth: 560 });
  });

  it("centres on the viewport before the map has a free area", () => {
    expect(crumbsSlot("night", 1500, legend, null, short).x).toBe(750);
  });

  it("slides right, clear of the legend, when centring would overlap it", () => {
    const s = crumbsSlot("vision", 1024, legend, 400, short);
    expect(s.top).toBe(16);
    expect(s.x - short.full / 2).toBe(lo);
    expect(s.maxWidth).toBe(1024 - 16 - 288 - 8 - lo);
  });

  it("slides left, clear of Vision's activity panel", () => {
    const s = crumbsSlot("vision", 1280, undefined, 1000, short);
    expect(s.x + short.full / 2).toBe(1280 - 16 - 288 - 8);
  });

  it("uses the full width in Night and on narrow screens, where the activity is at the bottom", () => {
    expect(crumbsSlot("night", 1024, legend, 980, short).x + short.full / 2).toBe(1024 - 16);
    expect(crumbsSlot("vision", 700, legend, 350, short)).toEqual({ x: lo + short.full / 2, top: 16, maxWidth: 700 - 16 - lo });
  });

  it("gives a trail too long for the band the whole band, centred, to collapse into", () => {
    const band = 1024 - 16 - 288 - 8 - lo;
    expect(crumbsSlot("vision", 1024, legend, 460, long)).toEqual({ x: lo + band / 2, top: 16, maxWidth: band });
  });

  it("keeps a label too long to collapse in the band (it ellipsizes there) rather than over the map", () => {
    const band = 1024 - 16 - 288 - 8 - lo;
    expect(crumbsSlot("vision", 1024, legend, 460, { full: 420, min: 420 })).toEqual({ x: lo + band / 2, top: 16, maxWidth: band });
  });

  it("drops below the legend when the band is narrower than the collapsed trail and a phone-width pill", () => {
    expect(crumbsSlot("vision", 560, legend, 280, long)).toEqual({ x: 280, top: 16 + 300 + 8, maxWidth: 560 - 32 });
    expect(crumbsSlot("vision", 360, { width: 328, height: 300 }, 180, short).top).toBe(16 + 300 + 8);
  });

  it("ignores a legend that has not been measured", () => {
    expect(crumbsSlot("vision", 1024, { width: 0, height: 0 }, 300, short)).toEqual(crumbsSlot("vision", 1024, undefined, 300, short));
  });
});

describe("crumbsStart / crumbsSize", () => {
  // The repo name, then four levels; each width includes its separator.
  const widths = [60, 50, 70, 80, 90];
  const ellipsis = 25;
  const chrome = 14;

  it("shows the whole trail when it fits", () => {
    expect(crumbsStart(widths, ellipsis, chrome, 364)).toBe(1);
    expect(crumbsStart(widths, ellipsis, chrome, 1000)).toBe(1);
  });

  it("collapses the fewest middle crumbs, from the repo name down, into one ellipsis", () => {
    expect(crumbsStart(widths, ellipsis, chrome, 363)).toBe(2); // 14 + 60 + 25 + 70 + 80 + 90 = 339
    expect(crumbsStart(widths, ellipsis, chrome, 338)).toBe(3); // 14 + 60 + 25 + 80 + 90 = 269
    expect(crumbsStart(widths, ellipsis, chrome, 268)).toBe(4);
  });

  it("always keeps the repo name and the current folder", () => {
    expect(crumbsStart(widths, ellipsis, chrome, 10)).toBe(4);
    expect(crumbsStart([60, 90], ellipsis, chrome, 10)).toBe(1);
    expect(crumbsStart([60], ellipsis, chrome, 10)).toBe(1);
  });

  it("measures the pill whole and fully collapsed", () => {
    expect(crumbsSize(widths, ellipsis, chrome)).toEqual({ full: 14 + 350, min: 14 + 60 + 25 + 90 });
    expect(crumbsSize([60, 90], ellipsis, chrome)).toEqual({ full: 164, min: 164 });
  });
});
