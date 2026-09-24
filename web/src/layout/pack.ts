import { hierarchy, pack, type HierarchyCircularNode } from "d3-hierarchy";
import type { TreeNode } from "./nodes";

export interface Circle {
  path: string;
  x: number;
  y: number;
  r: number;
  depth: number;
  isDir: boolean;
  aggregate?: number; // collapsed dir: number of descendant files
}

export const MIN_FILE_R = 1.5;
export const MIN_DIR_R = 6;
const PADDING = 3;

/**
 * Sizes are snapped to quarter-octave buckets (×1.19 in area, ≈9% in radius)
 * before packing. d3's front-chain packer is order-stable but a single size
 * change can nudge every later sibling; snapping means ordinary small edits
 * leave the layout pixel-identical, and only real growth moves anything.
 */
export function packValue(size: number): number {
  const v = Math.max(1, size);
  return 2 ** (Math.round(Math.log2(v) * 4) / 4);
}

export interface CullOptions {
  minFileR?: number;
  minDirR?: number;
  /** Extra file paths kept (at r ≥ minFileR) like touched files, e.g. ones still shimmering after a merge. */
  keep?: ReadonlySet<string>;
  /** The touched files, overriding the packed tree's own flags (for a pack reused by a later state). */
  touched?: ReadonlySet<string>;
}

/** The scale-independent half of a layout: the packed tree for one viewport size. */
export interface PackedTree {
  width: number;
  height: number;
  node: HierarchyCircularNode<TreeNode> | null; // null for an empty repo
  rootPath: string;
}

/**
 * Stable circle packing. Children are ordered by name (never by size).
 * Radii are in layout pixels. This is the expensive step and does not depend
 * on the zoom scale, so callers can pack once and re-cull per scale.
 */
export function packTree(root: TreeNode, width: number, height: number): PackedTree {
  if (!root.children || root.children.length === 0) return { width, height, node: null, rootPath: root.path };
  const h = hierarchy<TreeNode>(root, (d) => d.children)
    .sum((d) => (d.isDir ? 0 : packValue(d.size)))
    .sort((a, b) => (a.data.name < b.data.name ? -1 : a.data.name > b.data.name ? 1 : 0));
  return { width, height, node: pack<TreeNode>().size([width, height]).padding(PADDING)(h), rootPath: root.path };
}

/**
 * Turns a packed tree into the circles to draw. To cull at a zoom scale k,
 * pass minFileR/minDirR divided by k. (dx, dy) offsets every circle.
 *
 * Culling: files with r < minFileR are omitted, except touched files (and
 * opts.keep paths), which
 * are kept with r raised to minFileR so no worktree activity disappears.
 * d3 leaves PADDING (3 px) between circles, so at scale ≥ 1 (minFileR ≤ 1.5)
 * raised circles never overlap each other or their parent's edge. A
 * directory (other than the root)
 * collapses to one aggregate circle, and none of its descendants are
 * emitted, when r < minDirR or when every child is a file under minFileR.
 * That rule is purely geometric (touches do not affect it) so touching a
 * file never flips a folder between collapsed and expanded; the aggregate
 * carries its touches instead. `aggregate` is its descendant file count.
 *
 * The returned map is in pre-order (parents before children), which the
 * renderer relies on for draw order.
 */
export function cullLayout(packed: PackedTree, opts?: CullOptions, dx = 0, dy = 0): Map<string, Circle> {
  const minFileR = opts?.minFileR ?? MIN_FILE_R;
  const minDirR = opts?.minDirR ?? MIN_DIR_R;
  const keep = opts?.keep;
  const touched = opts?.touched;
  const out = new Map<string, Circle>();

  if (packed.node === null) {
    const r = Math.max(0, Math.min(packed.width, packed.height) / 2 - PADDING);
    out.set(packed.rootPath, { path: packed.rootPath, x: packed.width / 2 + dx, y: packed.height / 2 + dy, r, depth: 0, isDir: true });
    return out;
  }

  const visit = (n: HierarchyCircularNode<TreeNode>): void => {
    const c: Circle = { path: n.data.path, x: n.x + dx, y: n.y + dy, r: n.r, depth: n.depth, isDir: n.data.isDir };
    if (!n.data.isDir) {
      if (n.r >= minFileR) out.set(c.path, c);
      else if ((touched ? touched.has(c.path) : n.data.touched) || keep?.has(c.path)) out.set(c.path, { ...c, r: minFileR });
      return;
    }
    const kids = n.children ?? [];
    const allCulled = kids.every((k) => !k.data.isDir && k.r < minFileR);
    if (n.depth > 0 && (n.r < minDirR || allCulled)) {
      c.aggregate = n.leaves().filter((l) => !l.data.isDir).length;
      out.set(c.path, c);
      return;
    }
    out.set(c.path, c);
    for (const k of kids) visit(k);
  };
  visit(packed.node);
  return out;
}

/** packTree + cullLayout in one go (see both). */
export function computeLayout(root: TreeNode, width: number, height: number, opts?: CullOptions): Map<string, Circle> {
  return cullLayout(packTree(root, width, height), opts);
}
