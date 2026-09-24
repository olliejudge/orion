import { describe, expect, it } from "vitest";
import { EXT_GROUPS, WORKTREE_COLORS, colorForExt, extOf, lighten, worktreeColor } from "./colors";

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

describe("lighten", () => {
  it("mixes towards white", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080");
    expect(lighten("#ff9f0a", 0)).toBe("#ff9f0a");
    expect(lighten("#0a84ff", 1)).toBe("#ffffff");
  });
});
