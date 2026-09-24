import type { Activity, ChangeEntry, Patch, RepoInfo, ServerMessage, Snapshot, Worktree, WorktreeId } from "./protocol";

export const ACTIVITY_LIMIT = 200;

export interface RepoState {
  repo: RepoInfo;
  seq: number;
  worktrees: Map<WorktreeId, Worktree>;
  tree: Map<string, number>;
  overlays: Map<WorktreeId, Map<string, ChangeEntry>>;
  activity: Activity[]; // newest LAST, ≤200
}

export interface Change {
  kind: "snapshot" | "patch";
  patch?: Patch;
  merged: string[]; // paths that left all overlays and are now in base
}

type Listener = (s: RepoState, c: Change) => void;

/**
 * Holds the client's copy of the repo state. Every successful apply builds a
 * NEW RepoState object (copy-on-write for the maps a patch touches), so
 * consumers can compare by identity and a rejected patch leaves state intact.
 */
export class RepoStore {
  #state: RepoState | null = null;
  #listeners = new Set<Listener>();

  get state(): RepoState | null {
    return this.#state;
  }

  apply(msg: ServerMessage): { ok: true } | { ok: false; needsResync: true } {
    if (msg.type === "snapshot") {
      this.#state = fromSnapshot(msg);
      this.#emit({ kind: "snapshot", merged: [] });
      return { ok: true };
    }
    const prev = this.#state;
    if (prev === null || msg.seq !== prev.seq + 1) {
      return { ok: false, needsResync: true };
    }
    const { state, merged } = applyPatch(prev, msg);
    this.#state = state;
    this.#emit({ kind: "patch", patch: msg, merged });
    return { ok: true };
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  #emit(c: Change): void {
    const s = this.#state;
    if (s === null) return;
    for (const fn of this.#listeners) fn(s, c);
  }
}

function fromSnapshot(s: Snapshot): RepoState {
  const overlays = new Map<WorktreeId, Map<string, ChangeEntry>>();
  for (const [id, entries] of Object.entries(s.overlays ?? {})) {
    if (!entries || entries.length === 0) continue;
    overlays.set(id, new Map(entries.map((e) => [e.path, e])));
  }
  return {
    repo: { ...s.repo },
    seq: s.seq,
    worktrees: new Map((s.worktrees ?? []).map((w) => [w.id, w])),
    tree: new Map((s.tree ?? []).map((f) => [f.path, f.size])),
    overlays,
    activity: (s.activity ?? []).slice(-ACTIVITY_LIMIT),
  };
}

function applyPatch(prev: RepoState, p: Patch): { state: RepoState; merged: string[] } {
  const next: RepoState = { ...prev, seq: p.seq };

  if (p.worktrees) {
    next.worktrees = new Map(p.worktrees.map((w) => [w.id, w]));
  }

  const baseTouched = new Set<string>();
  if (p.base) {
    const tree = new Map(prev.tree);
    for (const f of p.base.upsert ?? []) {
      tree.set(f.path, f.size);
      baseTouched.add(f.path);
    }
    for (const path of p.base.remove ?? []) {
      tree.delete(path);
      baseTouched.add(path);
    }
    next.tree = tree;
    next.repo = { ...prev.repo, baseSha: p.base.sha };
  }

  // Entries removed by this patch, remembered with their previous stage.
  // Only worktrees still present after the patch contribute: the server
  // removes every path of a vanished worktree in the same patch that drops
  // it from `worktrees`, and those removals are not merges.
  const removed: ChangeEntry[] = [];
  if (p.overlays || p.worktrees) {
    const overlays = new Map(prev.overlays);
    for (const [id, op] of Object.entries(p.overlays ?? {})) {
      const m = new Map(overlays.get(id) ?? []);
      const alive = next.worktrees.has(id);
      for (const path of op.remove ?? []) {
        const old = m.get(path);
        if (old && alive) removed.push(old);
        m.delete(path);
      }
      for (const e of op.upsert ?? []) m.set(e.path, e);
      if (m.size === 0) overlays.delete(id);
      else overlays.set(id, m);
    }
    // Defensive: a worktree that left the list takes any remaining overlay
    // with it. These removals are NOT merge candidates either.
    for (const id of [...overlays.keys()]) {
      if (!next.worktrees.has(id)) overlays.delete(id);
    }
    next.overlays = overlays;
  }

  if (p.activity && p.activity.length > 0) {
    next.activity = prev.activity.concat(p.activity).slice(-ACTIVITY_LIMIT);
  }

  return { state: next, merged: mergedPaths(next, removed, p.base !== undefined, baseTouched) };
}

// A removed overlay entry counts as "merged into base" when no overlay still
// touches the path, base has the path after the patch, and either the entry
// was already committed on its branch and this same patch moved base, or
// this same patch changed the base entry itself. Requiring base to move stops
// a reverted uncommitted edit, or a committed one dropped by a branch reset,
// from shimmering.
function mergedPaths(s: RepoState, removed: ChangeEntry[], baseMoved: boolean, baseTouched: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of removed) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    if (!s.tree.has(e.path)) continue;
    if (!baseTouched.has(e.path) && !(e.stage === "committed" && baseMoved)) continue;
    let stillTouched = false;
    for (const m of s.overlays.values()) {
      if (m.has(e.path)) {
        stillTouched = true;
        break;
      }
    }
    if (!stillTouched) out.push(e.path);
  }
  return out;
}
