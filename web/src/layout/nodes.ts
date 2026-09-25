import type { RepoState } from "../store";
import { isExcluded } from "./exclude";

export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  children?: TreeNode[];
  touched?: true; // file with an overlay entry (or a rename `from`) in any worktree; never culled
}

/**
 * The node set is base ∪ every overlay entry's `path` (spec §6).
 *
 * - Deleted entries stay as nodes so they can render as faint outlines until
 *   the deletion reaches base. Their size is the base size (0 if not in base)
 *   so their siblings do not reshuffle.
 * - A renamed entry contributes only its NEW path. Its `from` path is never
 *   added by the overlay: it appears only while base still has it (where
 *   encode() marks it as moved-away, i.e. deleted for that worktree). A `from`
 *   path that is not in base simply vanishes, and the renderer glides the new
 *   node out of the old node's last position.
 * - A file's size is the largest of its base size and any non-deleted overlay
 *   size, so edits grow bubbles live.
 * - If a path is both a file and a directory prefix, the directory wins.
 * - Files that any worktree touches (an overlay entry, or a rename's `from`
 *   still in base) are flagged `touched`, so culling never hides activity.
 *
 * `excluded` drops every path inside a hidden directory (base and overlay
 * alike) before the tree is built, so the map, the pack cache and anything
 * downstream of either stay consistent. Omit it (or pass an empty set) to
 * get the unfiltered tree, e.g. to enumerate every directory for a filter UI.
 */
export function buildTree(state: RepoState, excluded?: ReadonlySet<string>): TreeNode {
  const { sizes, touched } = nodeSizes(state, excluded);
  const root: TreeNode = { path: "", name: state.repo.name, isDir: true, size: 0, children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  const dirFor = (dirPath: string): TreeNode => {
    const hit = dirs.get(dirPath);
    if (hit) return hit;
    const slash = dirPath.lastIndexOf("/");
    const parent = dirFor(slash < 0 ? "" : dirPath.slice(0, slash));
    const node: TreeNode = { path: dirPath, name: dirPath.slice(slash + 1), isDir: true, size: 0, children: [] };
    parent.children!.push(node);
    dirs.set(dirPath, node);
    return node;
  };

  // Directories first, so a file path that is also a directory is skipped.
  for (const path of sizes.keys()) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) dirFor(path.slice(0, slash));
  }
  for (const [path, size] of sizes) {
    if (path === "" || dirs.has(path)) continue;
    const slash = path.lastIndexOf("/");
    const parent = dirs.get(slash < 0 ? "" : path.slice(0, slash))!;
    const node: TreeNode = { path, name: path.slice(slash + 1), isDir: false, size };
    if (touched.has(path)) node.touched = true;
    parent.children!.push(node);
  }

  for (const d of dirs.values()) d.children!.sort(byName);
  return root;
}

/**
 * buildTree's inputs: every node path with its size, and the touched files.
 * A path under an excluded directory is dropped entirely, from both the base
 * tree and every overlay, so an excluded folder (and its subtree) never
 * reaches the pack.
 */
export function nodeSizes(state: RepoState, excluded?: ReadonlySet<string>): { sizes: Map<string, number>; touched: Set<string> } {
  const hidden = excluded && excluded.size > 0 ? excluded : undefined;
  const sizes = new Map<string, number>();
  if (hidden) {
    for (const [path, size] of state.tree) if (!isExcluded(path, hidden)) sizes.set(path, size);
  } else {
    for (const [path, size] of state.tree) sizes.set(path, size);
  }
  const touched = new Set<string>();
  for (const entries of state.overlays.values()) {
    for (const e of entries.values()) {
      if (hidden && isExcluded(e.path, hidden)) continue;
      touched.add(e.path);
      if (e.kind === "renamed" && e.from) touched.add(e.from);
      if (e.kind === "deleted") {
        if (!sizes.has(e.path)) sizes.set(e.path, 0);
      } else {
        sizes.set(e.path, Math.max(sizes.get(e.path) ?? 0, e.size));
      }
    }
  }
  return { sizes, touched };
}

function byName(a: TreeNode, b: TreeNode): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
