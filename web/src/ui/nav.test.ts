import { describe, expect, it } from "vitest";
import type { Circle } from "../layout/pack";
import { labelNames } from "../render/geometry";
import { childLevels, clickTarget, crumbs, doubleClickTarget, stepIn, upOne } from "./nav";

const c = (path: string, r: number, depth: number, isDir = true): Circle => ({ path, x: 0, y: 0, r, depth, isDir });

// web holds only src (a compressed chain labelled "web/src"); src has components and a file.
const layout = new Map<string, Circle>([
  ["", c("", 400, 0)],
  ["web", c("web", 200, 1)],
  ["web/src", c("web/src", 190, 2)],
  ["web/src/components", c("web/src/components", 80, 3)],
  ["web/src/components/Button.svelte", c("web/src/components/Button.svelte", 10, 4, false)],
  ["web/src/main.ts", c("web/src/main.ts", 10, 3, false)],
  ["docs", c("docs", 100, 1)],
  ["docs/guide.md", c("docs/guide.md", 10, 2, false)],
  ["vendor", { ...c("vendor", 20, 1), aggregate: 40 }],
]);
const labels = labelNames(layout);

describe("crumbs", () => {
  it("is just the repo at the root", () => {
    expect(crumbs("", layout, labels, "demo")).toEqual([{ path: "", label: "demo" }]);
  });

  it("names each level, one segment per compressed chain", () => {
    expect(crumbs("web/src/components", layout, labels, "demo")).toEqual([
      { path: "", label: "demo" },
      { path: "web/src", label: "web/src" },
      { path: "web/src/components", label: "components" },
    ]);
  });

  it("ends at the target even when it is inside a compressed chain or collapsed", () => {
    expect(crumbs("web", layout, labels, "demo").map((s) => s.label)).toEqual(["demo", "web"]);
    expect(crumbs("vendor", layout, labels, "demo").map((s) => s.label)).toEqual(["demo", "vendor"]);
  });

  it("falls back to the root for a target no longer in the layout", () => {
    expect(crumbs("gone/away", layout, labels, "demo")).toEqual([{ path: "", label: "demo" }]);
  });
});

describe("upOne", () => {
  it("steps to the previous breadcrumb, skipping compressed folders", () => {
    expect(upOne("web/src/components", layout, labels)).toBe("web/src");
    expect(upOne("web/src", layout, labels)).toBe("");
    expect(upOne("", layout, labels)).toBe("");
  });
});

describe("clickTarget", () => {
  it("zooms one level toward what was clicked, never skipping levels", () => {
    expect(clickTarget("web/src/components/Button.svelte", layout, labels, "")).toBe("web/src");
    expect(clickTarget("web/src/components/Button.svelte", layout, labels, "web/src")).toBe("web/src/components");
    expect(clickTarget("web/src/components", layout, labels, "")).toBe("web/src");
    expect(clickTarget("docs", layout, labels, "")).toBe("docs");
  });

  it("zooms a file's own folder when it is already in view", () => {
    expect(clickTarget("docs/guide.md", layout, labels, "docs")).toBe("docs");
  });

  it("steps sideways through the common ancestor for something outside the view", () => {
    expect(clickTarget("docs/guide.md", layout, labels, "web/src/components")).toBe("docs");
  });

  it("steps out one level when the folder in view is clicked", () => {
    expect(clickTarget("web/src/components", layout, labels, "web/src/components")).toBe("web/src");
    expect(clickTarget("", layout, labels, "")).toBe("");
  });

  it("returns to the root for clicks outside the repo and unknown paths", () => {
    expect(clickTarget(null, layout, labels, "docs")).toBe("");
    expect(clickTarget("gone", layout, labels, "docs")).toBe("");
  });

  it("treats every folder as a level without labels", () => {
    expect(clickTarget("web/src/main.ts", layout, undefined, "")).toBe("web");
  });
});

describe("childLevels", () => {
  it("lists the direct child levels of the root, largest first, chains and aggregates included", () => {
    expect(childLevels("", layout, labels).map((c) => c.path)).toEqual(["web/src", "docs", "vendor"]);
  });

  it("lists a level's own children, skipping deeper ones", () => {
    expect(childLevels("web/src", layout, labels).map((c) => c.path)).toEqual(["web/src/components"]);
  });

  it("is empty for a level with no child levels", () => {
    expect(childLevels("docs", layout, labels)).toEqual([]);
  });
});

describe("stepIn", () => {
  it("steps one level toward a hovered path within the current folder", () => {
    expect(stepIn("web/src/components/Button.svelte", layout, labels, "")).toBe("web/src");
    expect(stepIn("web/src/components", layout, labels, "web/src")).toBe("web/src/components");
  });

  it("falls back to the largest child level with no hover, or a hover outside the current folder", () => {
    expect(stepIn(null, layout, labels, "")).toBe("web/src");
    expect(stepIn("web/src/components", layout, labels, "docs")).toBe("docs");
  });

  it("falls back rather than stepping out when the pointer is over the current folder's own background", () => {
    expect(stepIn("web/src", layout, labels, "web/src")).toBe("web/src/components");
  });

  it("stays put with no child level to step into", () => {
    expect(stepIn(null, layout, labels, "docs")).toBe("docs");
  });
});

describe("doubleClickTarget", () => {
  it("jumps straight to a folder, or to a file's folder", () => {
    expect(doubleClickTarget("web/src/components", layout, labels, "")).toBe("web/src/components");
    expect(doubleClickTarget("web/src/components/Button.svelte", layout, labels, "")).toBe("web/src/components");
  });

  it("zooms out one level on the background of the folder in view", () => {
    expect(doubleClickTarget("web/src/components", layout, labels, "web/src/components")).toBe("web/src");
  });

  it("returns to the root outside the repo", () => {
    expect(doubleClickTarget(null, layout, labels, "web/src/components")).toBe("");
  });
});
