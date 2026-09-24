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

/**
 * Stable circle packing. Children are ordered by name (never by size).
 * Radii are in layout pixels; to cull at a zoom scale k, pass
 * minFileR/minDirR divided by k.
 *
 * Culling: files with r < minFileR are omitted. A directory (other than the
 * root) collapses to one aggregate circle, and none of its descendants are
 * emitted, when r < minDirR or when every child is a file that would be
 * culled. `aggregate` is its descendant file count.
 *
 * The returned map is in pre-order (parents before children), which the
 * renderer relies on for draw order.
 */
export function computeLayout(
  root: TreeNode,
  width: number,
  height: number,
  opts?: { minFileR?: number; minDirR?: number },
): Map<string, Circle> {
  const minFileR = opts?.minFileR ?? MIN_FILE_R;
  const minDirR = opts?.minDirR ?? MIN_DIR_R;
  const out = new Map<string, Circle>();

  if (!root.children || root.children.length === 0) {
    const r = Math.max(0, Math.min(width, height) / 2 - PADDING);
    out.set(root.path, { path: root.path, x: width / 2, y: height / 2, r, depth: 0, isDir: true });
    return out;
  }

  const h = hierarchy<TreeNode>(root, (d) => d.children)
    .sum((d) => (d.isDir ? 0 : packValue(d.size)))
    .sort((a, b) => (a.data.name < b.data.name ? -1 : a.data.name > b.data.name ? 1 : 0));
  const packed = pack<TreeNode>().size([width, height]).padding(PADDING)(h);

  const visit = (n: HierarchyCircularNode<TreeNode>): void => {
    const c: Circle = { path: n.data.path, x: n.x, y: n.y, r: n.r, depth: n.depth, isDir: n.data.isDir };
    if (!n.data.isDir) {
      if (n.r >= minFileR) out.set(c.path, c);
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
  visit(packed);
  return out;
}
