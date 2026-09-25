import { describe, expect, it } from "vitest";
import { WORKTREE_COLORS, lighten, worktreeColor } from "./colors";

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

describe("lighten", () => {
  it("mixes towards white", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080");
    expect(lighten("#ff9f0a", 0)).toBe("#ff9f0a");
    expect(lighten("#0a84ff", 1)).toBe("#ffffff");
  });
});
