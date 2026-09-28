// Rectangle views of the repo: a tree map (d3 treemap, squarified) and a
// partition (d3 partition as an icicle: one row per depth, top to bottom).
// Both emit the same Circle entries as the bubbles view, with `box` set, so
// navigation, labels and tooltips keep working unchanged (see Circle.box).
import { hierarchy, partition, treemap, treemapSquarify, type HierarchyNode, type HierarchyRectangularNode } from "d3-hierarchy";
import type { RepoState } from "../store";
import { encodeAll } from "./encoding";
import { freeArea, type Frame, type FreeArea, type Insets } from "./frame";
import { buildTree, type TreeNode } from "./nodes";
import { packValue, type Box, type Circle } from "./pack";

export type RectKind = "treemap" | "partition";

/** Tree map: the strip at the top of every folder box that holds its name. */
export const TREEMAP_HEADER_PX = 18;
/** Tree map: the gap between a folder's edge and its children (other than the header side). */
export const TREEMAP_OUTER_PX = 3;
/** Tree map: the gap between sibling boxes. */
export const TREEMAP_INNER_PX = 2;
/** Tree map: a folder narrower or shorter than this collapses into an aggregate. */
export const TREEMAP_MIN_DIR_W = 30;
export const TREEMAP_MIN_DIR_H = 24;
/** Tree map: a file box narrower or shorter than this is dropped (unless touched or lingering). */
export const TREEMAP_MIN_FILE_PX = 2;
/** Partition: the minimum row height; rows past the cap fold into aggregates. */
export const PARTITION_ROW_PX = 26;
/** Partition: a cell narrower than this is dropped with its subtree (unless touched or lingering). */
export const PARTITION_MIN_W = 1.5;

/** Value descending, then name, so equal-sized siblings keep a stable order. */
function byValueThenName(a: HierarchyNode<TreeNode>, b: HierarchyNode<TreeNode>): number {
  const dv = (b.value ?? 0) - (a.value ?? 0);
  if (dv !== 0) return dv;
  return a.data.name < b.data.name ? -1 : a.data.name > b.data.name ? 1 : 0;
}

function pathDepth(path: string): number {
  return path === "" ? 0 : path.split("/").length;
}

/** The folder node for `focus`, or its nearest ancestor folder in the tree, or the root. */
function findFocus(root: TreeNode, focus: string): TreeNode {
  let node = root;
  if (focus === "") return node;
  for (const seg of focus.split("/")) {
    const next = node.children?.find((c) => c.name === seg && c.isDir);
    if (!next) break;
    node = next;
  }
  return node;
}

function fileCount(n: TreeNode): number {
  if (!n.isDir) return 1;
  let c = 0;
  for (const k of n.children ?? []) c += fileCount(k);
  return c;
}

function entry(n: TreeNode, depth: number, b: Box): Circle {
  return {
    path: n.path,
    x: (b.x0 + b.x1) / 2,
    y: (b.y0 + b.y1) / 2,
    r: Math.max(0, Math.min(b.x1 - b.x0, b.y1 - b.y0) / 2),
    depth,
    isDir: n.isDir,
    box: b,
  };
}

// One-entry cache: the renderer asks again with identical inputs on every
// redraw that isn't a state, size or view change (e.g. hover), so reuse the
// last frame when nothing it depends on changed.
interface CacheKey {
  state: RepoState;
  kind: RectKind;
  focus: string;
  width: number;
  height: number;
  pad: string;
  linger?: ReadonlySet<string>;
  excluded?: ReadonlySet<string>;
}
let last: { key: CacheKey; frame: Frame } | null = null;

function sameKey(a: CacheKey, b: CacheKey): boolean {
  return (
    a.state === b.state &&
    a.kind === b.kind &&
    a.focus === b.focus &&
    a.width === b.width &&
    a.height === b.height &&
    a.pad === b.pad &&
    a.linger === b.linger &&
    a.excluded === b.excluded
  );
}

/**
 * state → layout + visuals for a rectangle view of the folder `focus` ("" =
 * the repo root) in a width×height viewport. The focus fills the free area
 * (freeArea(width, height, pad)); a focus that isn't a folder in the tree
 * falls back to its nearest ancestor folder. Every entry has `box` (CSS px,
 * offset into the free area), x/y at its centre, r = half its shorter side,
 * and its absolute depth (root 0). Proper ancestors of the focus are
 * included with `hidden: true` and the whole free area as their box, for
 * navigation only. The map is in pre-order (parents first).
 *
 * `linger` paths are kept like touched files; `excluded` directories are
 * dropped before layout (see buildTree).
 */
export function computeRectFrame(
  state: RepoState,
  kind: RectKind,
  focus: string,
  width: number,
  height: number,
  pad: number | Insets = 0,
  linger?: ReadonlySet<string>,
  excluded?: ReadonlySet<string>,
): Frame {
  const key: CacheKey = { state, kind, focus, width, height, pad: JSON.stringify(pad), linger, excluded };
  if (last && sameKey(last.key, key)) return last.frame;

  const free = freeArea(width, height, pad);
  const root = buildTree(state, excluded);
  const node = findFocus(root, focus);
  const baseDepth = pathDepth(node.path);
  const layout = new Map<string, Circle>();
  const whole: Box = { x0: free.x0, y0: free.y0, x1: free.x1, y1: free.y1 };

  // Hidden ancestors, shallowest first.
  if (node.path !== "") {
    const segs = node.path.split("/");
    for (let i = 0; i < segs.length; i++) {
      const p = segs.slice(0, i).join("/");
      layout.set(p, { ...entry({ path: p, name: "", isDir: true, size: 0 }, i, whole), hidden: true });
    }
  }

  const keep = (n: TreeNode): boolean => n.touched === true || (linger?.has(n.path) ?? false);

  if (!node.children || node.children.length === 0) {
    layout.set(node.path, entry(node, baseDepth, whole));
  } else if (kind === "treemap") {
    layoutTreemap(node, free, baseDepth, keep, layout);
  } else {
    layoutPartition(node, free, baseDepth, keep, layout);
  }

  const frame: Frame = { layout, visuals: encodeAll(state, layout), free };
  last = { key, frame };
  return frame;
}

function layoutTreemap(focus: TreeNode, free: FreeArea, baseDepth: number, keep: (n: TreeNode) => boolean, out: Map<string, Circle>): void {
  const h = hierarchy<TreeNode>(focus, (d) => d.children)
    .sum((d) => (d.isDir ? 0 : packValue(d.size)))
    .sort(byValueThenName);
  const laid = treemap<TreeNode>()
    .tile(treemapSquarify)
    .size([free.x1 - free.x0, free.y1 - free.y0])
    .paddingTop(TREEMAP_HEADER_PX)
    .paddingRight(TREEMAP_OUTER_PX)
    .paddingBottom(TREEMAP_OUTER_PX)
    .paddingLeft(TREEMAP_OUTER_PX)
    .paddingInner(TREEMAP_INNER_PX)
    .round(false)(h);

  const boxOf = (n: HierarchyRectangularNode<TreeNode>): Box => ({ x0: n.x0 + free.x0, y0: n.y0 + free.y0, x1: n.x1 + free.x0, y1: n.y1 + free.y0 });
  const tinyFile = (n: HierarchyRectangularNode<TreeNode>): boolean => n.x1 - n.x0 < TREEMAP_MIN_FILE_PX || n.y1 - n.y0 < TREEMAP_MIN_FILE_PX;

  const visit = (n: HierarchyRectangularNode<TreeNode>): void => {
    const c = entry(n.data, baseDepth + n.depth, boxOf(n));
    if (!n.data.isDir) {
      if (!tinyFile(n) || keep(n.data)) out.set(c.path, c);
      return;
    }
    const kids = n.children ?? [];
    // Purely geometric, like cullLayout: touches never flip a folder between
    // collapsed and expanded; the aggregate carries them instead.
    const small = n.x1 - n.x0 < TREEMAP_MIN_DIR_W || n.y1 - n.y0 < TREEMAP_MIN_DIR_H;
    const allCulled = kids.every((k) => !k.data.isDir && tinyFile(k));
    if (n.depth > 0 && (small || allCulled)) {
      c.aggregate = fileCount(n.data);
      out.set(c.path, c);
      return;
    }
    out.set(c.path, c);
    for (const k of kids) visit(k);
  };
  visit(laid);
}

function layoutPartition(focus: TreeNode, free: FreeArea, baseDepth: number, keep: (n: TreeNode) => boolean, out: Map<string, Circle>): void {
  const fw = free.x1 - free.x0;
  const fh = free.y1 - free.y0;
  const maxRows = Math.max(2, Math.floor(fh / PARTITION_ROW_PX));
  const lastRow = baseDepth + maxRows - 1; // absolute depth of the deepest row

  // Subtree totals and file counts, so folders cut at the last row keep the right width.
  const total = new Map<TreeNode, number>();
  const files = new Map<TreeNode, number>();
  const hasKept = new Set<TreeNode>();
  const measure = (n: TreeNode): void => {
    if (!n.isDir) {
      total.set(n, packValue(n.size));
      files.set(n, 1);
      if (keep(n)) hasKept.add(n);
      return;
    }
    let t = 0;
    let f = 0;
    for (const k of n.children ?? []) {
      measure(k);
      t += total.get(k)!;
      f += files.get(k)!;
      if (hasKept.has(k)) hasKept.add(n);
    }
    total.set(n, t);
    files.set(n, f);
  };
  measure(focus);

  const cut = (d: TreeNode): boolean => d.isDir && pathDepth(d.path) >= lastRow;
  const h = hierarchy<TreeNode>(focus, (d) => (cut(d) ? undefined : d.children))
    .sum((d) => (!d.isDir || cut(d) ? total.get(d)! : 0))
    .sort(byValueThenName);
  const laid = partition<TreeNode>().size([fw, fh]).round(false)(h);

  const visit = (n: HierarchyRectangularNode<TreeNode>): void => {
    const c = entry(n.data, baseDepth + n.depth, { x0: n.x0 + free.x0, y0: n.y0 + free.y0, x1: n.x1 + free.x0, y1: n.y1 + free.y0 });
    const narrow = n.depth > 0 && n.x1 - n.x0 < PARTITION_MIN_W;
    if (!n.data.isDir) {
      if (!narrow || keep(n.data)) out.set(c.path, c);
      return;
    }
    if (narrow) {
      // A narrow folder is dropped with its subtree, unless it holds a
      // touched or lingering file: then it stays as an aggregate carrying it.
      if (hasKept.has(n.data)) out.set(c.path, { ...c, aggregate: files.get(n.data)! });
      return;
    }
    if (n.depth > 0 && !n.children && (n.data.children?.length ?? 0) > 0) {
      c.aggregate = files.get(n.data)!;
      out.set(c.path, c);
      return;
    }
    out.set(c.path, c);
    for (const k of n.children ?? []) visit(k);
  };
  visit(laid);
}
