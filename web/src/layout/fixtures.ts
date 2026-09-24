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

/**
 * A large synthetic repo: `files` base files spread over ~2000 folders three
 * levels deep (every seventh file sits beside the subfolders), with sizes
 * spread log-uniformly from 16 B to 256 KiB, and every (files/touched)-th
 * file changed by one of three worktrees. Every fourth change is an
 * uncommitted add of a new path next to it, so ghosts are part of the load.
 */
export function bigState(files = 20_000, touched = 2_000): RepoState {
  const tree: Record<string, number> = {};
  const overlays: Record<string, ChangeEntry[]> = { w0: [], w1: [], w2: [] };
  const every = Math.max(1, Math.floor(files / touched));
  for (let i = 0; i < files; i++) {
    const dir = `pkg${i % 20}/mod${Math.floor(i / 20) % 10}`;
    const path = i % 7 === 0 ? `${dir}/file${i}.ts` : `${dir}/sub${Math.floor(i / 200) % 10}/file${i}.ts`;
    tree[path] = Math.round(2 ** (4 + (((i * 7919) % 1000) / 1000) * 14));
    if (i % every !== 0) continue;
    const n = i / every;
    const w = overlays[`w${n % 3}`]!;
    if (n % 4 === 3) w.push({ path: path.replace("/file", "/new"), kind: "added", stage: "uncommitted", size: 120 });
    else w.push({ path, kind: "modified", stage: n % 2 === 0 ? "uncommitted" : "committed", size: tree[path]! + 10 });
  }
  return makeState(tree, overlays);
}
