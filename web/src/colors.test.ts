import { describe, expect, it } from "vitest";
import {
  EXT_GROUPS,
  FILE_CHROMA_RATIO,
  MIN_FILE_WORKTREE_DELTA_E,
  WORKTREE_COLORS,
  colorForExt,
  extOf,
  lighten,
  worktreeColor,
} from "./colors";
import { chroma, deltaE } from "./perceptual";

describe("WORKTREE_COLORS", () => {
  it("is exactly the 10 Apple system colours, main (index 0) blue", () => {
    expect(WORKTREE_COLORS).toEqual([
      "#0a84ff", "#ff9f0a", "#30d158", "#ff375f", "#bf5af2",
      "#40c8e0", "#ffd60a", "#5e5ce6", "#ff453a", "#63e6e2",
    ]);
  });
});

describe("worktreeColor", () => {
  it("wraps past 10 and greys out unassigned (-1)", () => {
    expect(worktreeColor(0)).toBe("#0a84ff");
    expect(worktreeColor(11)).toBe("#ff9f0a");
    expect(worktreeColor(-1)).toBe("#8e8e93");
  });
});

describe("extOf", () => {
  it("lower-cases the last extension of the base name", () => {
    expect(extOf("src/App.Svelte")).toBe("svelte");
    expect(extOf("a.b/c.tar.GZ")).toBe("gz");
  });
  it("uses the whole base name when there is no extension or it is a dotfile", () => {
    expect(extOf("Makefile")).toBe("makefile");
    expect(extOf("dir.d/Dockerfile")).toBe("dockerfile");
    expect(extOf(".gitignore")).toBe(".gitignore");
  });
});

describe("colorForExt", () => {
  it("groups related extensions", () => {
    expect(colorForExt("ts")).toEqual(colorForExt("tsx"));
    expect(colorForExt("go")).toEqual(colorForExt("rs"));
    expect(colorForExt("md")).toEqual(EXT_GROUPS.docs);
    expect(colorForExt("makefile")).toEqual(EXT_GROUPS.config);
  });
  it("falls back to the neutral group", () => {
    expect(colorForExt("zzz")).toEqual(EXT_GROUPS.other);
  });
  it("returns hex stops", () => {
    const { base, light } = colorForExt("ts");
    expect(base).toMatch(/^#[0-9a-f]{6}$/);
    expect(light).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("EXT_GROUPS (Vision file-type palette)", () => {
  const stops = Object.entries(EXT_GROUPS).flatMap(([group, c]): [string, string][] => [
    [`${group}.light`, c.light],
    [`${group}.base`, c.base],
  ]);
  const minWorktreeChroma = Math.min(...WORKTREE_COLORS.map(chroma));

  it("stays well below the chroma of every worktree colour", () => {
    for (const [name, hex] of stops) {
      expect(chroma(hex), name).toBeLessThanOrEqual(FILE_CHROMA_RATIO * minWorktreeChroma);
    }
  });

  it("keeps every file-type colour perceptually far from every worktree colour", () => {
    for (const [name, hex] of stops) {
      for (const w of WORKTREE_COLORS) expect(deltaE(hex, w), `${name} vs ${w}`).toBeGreaterThanOrEqual(MIN_FILE_WORKTREE_DELTA_E);
    }
  });

  it("is bright enough to read on the Vision background (some channel above 120 in every highlight)", () => {
    for (const c of Object.values(EXT_GROUPS)) {
      const n = parseInt(c.light.slice(1), 16);
      expect(Math.max((n >> 16) & 255, (n >> 8) & 255, n & 255)).toBeGreaterThan(120);
    }
  });

  it("keeps the groups distinguishable from each other", () => {
    const lights = Object.values(EXT_GROUPS).map((c) => c.light);
    for (let i = 0; i < lights.length; i++) {
      for (let j = i + 1; j < lights.length; j++) expect(deltaE(lights[i]!, lights[j]!)).toBeGreaterThan(8);
    }
  });
});

describe("lighten", () => {
  it("mixes towards white", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080");
    expect(lighten("#ff9f0a", 0)).toBe("#ff9f0a");
    expect(lighten("#0a84ff", 1)).toBe("#ffffff");
  });
});
