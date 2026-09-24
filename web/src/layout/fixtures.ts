// Test helper: builds a RepoState by hand. Synthetic paths only.
import type { ChangeEntry, Worktree } from "../protocol";
import type { RepoState } from "../store";

export function wt(id: string, colorIndex: number, label = id): Worktree {
  return { id, path: `/repo/${id}`, label, head: "0000000", isMain: colorIndex === 0, locked: false, colorIndex };
}

export function makeState(
  tree: Record<string, number>,
  overlays: Record<string, ChangeEntry[]> = {},
  worktrees: Worktree[] = [wt("w0", 0, "main"), wt("w1", 1, "feat/a"), wt("w2", 2, "fix/b")],
): RepoState {
  return {
    repo: { name: "sample-app", base: "origin/main", baseSha: "b0" },
    seq: 1,
    worktrees: new Map(worktrees.map((w) => [w.id, w])),
    tree: new Map(Object.entries(tree)),
    overlays: new Map(Object.entries(overlays).map(([id, es]) => [id, new Map(es.map((e) => [e.path, e]))])),
    activity: [],
  };
}
