import { describe, expect, it } from "vitest";
import { makeState } from "./fixtures";
import { buildTree, type TreeNode } from "./nodes";

function find(root: TreeNode, path: string): TreeNode | undefined {
  if (root.path === path) return root;
  for (const c of root.children ?? []) {
    const hit = find(c, path);
    if (hit) return hit;
  }
  return undefined;
}

function paths(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode): void => {
    out.push(n.path);
    n.children?.forEach(walk);
  };
  walk(root);
  return out;
}

describe("buildTree", () => {
  it("nests base files under directory nodes, children sorted by name", () => {
    const root = buildTree(makeState({ "src/z.ts": 5, "src/a.ts": 7, "README.md": 3, "src/lib/b.ts": 1 }));
    expect(root).toMatchObject({ path: "", name: "sample-app", isDir: true });
    expect(paths(root)).toEqual(["", "README.md", "src", "src/a.ts", "src/lib", "src/lib/b.ts", "src/z.ts"]);
    expect(find(root, "src")).toMatchObject({ name: "src", isDir: true, size: 0 });
    expect(find(root, "src/a.ts")).toMatchObject({ name: "a.ts", isDir: false, size: 7 });
    expect(find(root, "src/a.ts")!.children).toBeUndefined();
  });

  it("sorts by code point, not locale or size", () => {
    const root = buildTree(makeState({ "b.ts": 1, "B.ts": 999, "a.ts": 50 }));
    expect(root.children!.map((c) => c.name)).toEqual(["B.ts", "a.ts", "b.ts"]);
  });

  it("adds overlay-only paths and sizes a file by the largest live version", () => {
    const root = buildTree(
      makeState({ "src/a.ts": 10 }, {
        w1: [
          { path: "src/a.ts", kind: "modified", stage: "committed", size: 30 },
          { path: "src/new/x.ts", kind: "added", stage: "uncommitted", size: 4 },
        ],
        w2: [{ path: "src/a.ts", kind: "modified", stage: "uncommitted", size: 20 }],
      }),
    );
    expect(find(root, "src/a.ts")!.size).toBe(30);
    expect(find(root, "src/new")).toMatchObject({ isDir: true });
    expect(find(root, "src/new/x.ts")).toMatchObject({ size: 4 });
  });

  it("keeps deleted paths as nodes: base size when in base, else 0", () => {
    const root = buildTree(
      makeState({ "gone.ts": 12 }, {
        w1: [
          { path: "gone.ts", kind: "deleted", stage: "uncommitted", size: 0 },
          { path: "tmp/ghost.ts", kind: "deleted", stage: "uncommitted", size: 0 },
        ],
      }),
    );
    expect(find(root, "gone.ts")!.size).toBe(12);
    expect(find(root, "tmp/ghost.ts")!.size).toBe(0);
  });

  it("never adds a rename's `from` path; it shows only while base still has it", () => {
    const root = buildTree(
      makeState({ "old/name.ts": 8 }, {
        w1: [
          { path: "new/name.ts", kind: "renamed", from: "old/name.ts", stage: "uncommitted", size: 8 },
          { path: "b.ts", kind: "renamed", from: "a-not-in-base.ts", stage: "committed", size: 3 },
        ],
      }),
    );
    expect(find(root, "old/name.ts")).toBeDefined();
    expect(find(root, "new/name.ts")).toBeDefined();
    expect(find(root, "a-not-in-base.ts")).toBeUndefined();
  });

  it("lets a directory win when a path is both a file and a directory", () => {
    const root = buildTree(makeState({ docs: 5 }, { w1: [{ path: "docs/intro.md", kind: "added", stage: "uncommitted", size: 2 }] }));
    expect(find(root, "docs")).toMatchObject({ isDir: true });
    expect(find(root, "docs/intro.md")).toBeDefined();
  });

  it("flags files any worktree touches, including a base rename source", () => {
    const root = buildTree(
      makeState({ "a.ts": 1, "old.ts": 1, "quiet.ts": 1 }, {
        w1: [{ path: "a.ts", kind: "modified", stage: "committed", size: 1 }],
        w2: [{ path: "new.ts", kind: "renamed", from: "old.ts", stage: "uncommitted", size: 1 }],
      }),
    );
    expect(find(root, "a.ts")!.touched).toBe(true);
    expect(find(root, "old.ts")!.touched).toBe(true);
    expect(find(root, "new.ts")!.touched).toBe(true);
    expect(find(root, "quiet.ts")!.touched).toBeUndefined();
  });

  it("returns an empty root for an empty repo", () => {
    expect(buildTree(makeState({}))).toEqual({ path: "", name: "sample-app", isDir: true, size: 0, children: [] });
  });
});
