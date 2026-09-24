import type { RepoState } from "../store";

export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  children?: TreeNode[];
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
 */
export function buildTree(state: RepoState): TreeNode {
  const sizes = new Map<string, number>(state.tree);
  for (const entries of state.overlays.values()) {
    for (const e of entries.values()) {
      if (e.kind === "deleted") {
        if (!sizes.has(e.path)) sizes.set(e.path, 0);
      } else {
        sizes.set(e.path, Math.max(sizes.get(e.path) ?? 0, e.size));
      }
    }
  }

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
    parent.children!.push({ path, name: path.slice(slash + 1), isDir: false, size });
  }

  for (const d of dirs.values()) d.children!.sort(byName);
  return root;
}

function byName(a: TreeNode, b: TreeNode): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
