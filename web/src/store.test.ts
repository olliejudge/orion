import { describe, expect, it, vi } from "vitest";
import type { Activity, Patch, Snapshot } from "./protocol";
import { RepoStore, type Change, type RepoState } from "./store";

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    type: "snapshot",
    seq: 5,
    repo: { name: "sample-app", base: "origin/main", baseSha: "b1" },
    worktrees: [
      { id: "w0", path: "/r", label: "main", branch: "main", head: "h0", isMain: true, locked: false, colorIndex: 0 },
      { id: "w1", path: "/r/.claude/worktrees/a", label: "feat/a", branch: "feat/a", head: "h1", isMain: false, locked: false, colorIndex: 1 },
    ],
    tree: [
      { path: "README.md", size: 120 },
      { path: "src/app.ts", size: 900 },
    ],
    overlays: {
      w1: [
        { path: "src/app.ts", kind: "modified", stage: "committed", size: 950 },
        { path: "src/new.ts", kind: "added", stage: "uncommitted", size: 40 },
      ],
    },
    activity: [],
    ...over,
  };
}

function patch(seq: number, over: Partial<Patch> = {}): Patch {
  return { type: "patch", seq, ...over };
}

function act(ts: number): Activity {
  return { ts, worktree: "w1", kind: "modified", path: `f${ts}.ts` };
}

describe("RepoStore", () => {
  it("starts empty", () => {
    expect(new RepoStore().state).toBeNull();
  });

  it("replaces all state on snapshot", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    const res = store.apply(snapshot({ seq: 9, tree: [{ path: "only.txt", size: 1 }], overlays: {} }));
    expect(res).toEqual({ ok: true });
    const s = store.state!;
    expect(s.seq).toBe(9);
    expect([...s.tree.keys()]).toEqual(["only.txt"]);
    expect(s.overlays.size).toBe(0);
    expect(s.worktrees.get("w1")?.label).toBe("feat/a");
  });

  it("rejects a patch before any snapshot", () => {
    expect(new RepoStore().apply(patch(1))).toEqual({ ok: false, needsResync: true });
  });

  it("rejects a patch with a seq gap and leaves state untouched", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    const before = store.state;
    const fn = vi.fn();
    store.subscribe(fn);
    expect(store.apply(patch(7, { base: { sha: "b2", upsert: [], remove: ["README.md"] } }))).toEqual({
      ok: false,
      needsResync: true,
    });
    expect(store.apply(patch(5))).toEqual({ ok: false, needsResync: true });
    expect(store.state).toBe(before);
    expect(store.state!.tree.has("README.md")).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it("applies base and overlay upserts/removes without mutating the previous state", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    const before = store.state!;
    store.apply(
      patch(6, {
        base: { sha: "b2", upsert: [{ path: "docs/guide.md", size: 10 }], remove: ["README.md"] },
        overlays: { w1: { upsert: [{ path: "src/x.ts", kind: "added", stage: "uncommitted", size: 3 }], remove: ["src/new.ts"] } },
      }),
    );
    const s = store.state!;
    expect(s.seq).toBe(6);
    expect(s.repo.baseSha).toBe("b2");
    expect(s.tree.has("README.md")).toBe(false);
    expect(s.tree.get("docs/guide.md")).toBe(10);
    expect([...s.overlays.get("w1")!.keys()].sort()).toEqual(["src/app.ts", "src/x.ts"]);
    expect(before.tree.has("README.md")).toBe(true);
    expect(before.overlays.get("w1")!.has("src/new.ts")).toBe(true);
  });

  it("drops a worktree's overlay map when it becomes empty", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    store.apply(patch(6, { overlays: { w1: { upsert: [], remove: ["src/app.ts", "src/new.ts"] } } }));
    expect(store.state!.overlays.has("w1")).toBe(false);
  });

  it("replaces the worktree list and drops overlays of vanished worktrees", () => {
    const store = new RepoStore();
    store.apply(snapshot());
    store.apply(patch(6, { worktrees: [snapshot().worktrees[0]!] }));
    expect([...store.state!.worktrees.keys()]).toEqual(["w0"]);
    expect(store.state!.overlays.has("w1")).toBe(false);
  });

  it("keeps activity newest-last and capped at 200", () => {
    const store = new RepoStore();
    store.apply(snapshot({ activity: Array.from({ length: 150 }, (_, i) => act(i)) }));
    store.apply(patch(6, { activity: Array.from({ length: 100 }, (_, i) => act(150 + i)) }));
    const a = store.state!.activity;
    expect(a).toHaveLength(200);
    expect(a[0]!.ts).toBe(50);
    expect(a[199]!.ts).toBe(249);
  });

  it("caps snapshot activity at 200", () => {
    const store = new RepoStore();
    store.apply(snapshot({ activity: Array.from({ length: 250 }, (_, i) => act(i)) }));
    expect(store.state!.activity).toHaveLength(200);
    expect(store.state!.activity[0]!.ts).toBe(50);
  });

  describe("merged", () => {
    function lastChange(store: RepoStore): () => Change {
      let c: Change | null = null;
      store.subscribe((_s: RepoState, change: Change) => {
        c = change;
      });
      return () => c!;
    }

    it("reports a committed entry that left every overlay while base kept the path", () => {
      const store = new RepoStore();
      store.apply(snapshot());
      const last = lastChange(store);
      store.apply(
        patch(6, {
          base: { sha: "b2", upsert: [{ path: "src/app.ts", size: 950 }], remove: [] },
          overlays: { w1: { upsert: [], remove: ["src/app.ts"] } },
        }),
      );
      expect(last()).toMatchObject({ kind: "patch", merged: ["src/app.ts"] });
    });

    it("reports an uncommitted entry that left the overlay when base changed that path in the same patch", () => {
      const store = new RepoStore();
      store.apply(snapshot());
      const last = lastChange(store);
      store.apply(
        patch(6, {
          base: { sha: "b2", upsert: [{ path: "src/new.ts", size: 40 }], remove: [] },
          overlays: { w1: { upsert: [], remove: ["src/new.ts"] } },
        }),
      );
      expect(last().merged).toEqual(["src/new.ts"]);
    });

    it("does not report a reverted uncommitted edit (base unchanged)", () => {
      const store = new RepoStore();
      store.apply(
        snapshot({ overlays: { w1: [{ path: "README.md", kind: "modified", stage: "uncommitted", size: 130 }] } }),
      );
      const last = lastChange(store);
      store.apply(patch(6, { overlays: { w1: { upsert: [], remove: ["README.md"] } } }));
      expect(last().merged).toEqual([]);
    });

    it("does not report a path another worktree still touches", () => {
      const store = new RepoStore();
      store.apply(
        snapshot({
          overlays: {
            w0: [{ path: "src/app.ts", kind: "modified", stage: "uncommitted", size: 1 }],
            w1: [{ path: "src/app.ts", kind: "modified", stage: "committed", size: 2 }],
          },
        }),
      );
      const last = lastChange(store);
      store.apply(patch(6, { overlays: { w1: { upsert: [], remove: ["src/app.ts"] } } }));
      expect(last().merged).toEqual([]);
    });

    it("does not report a path that is gone from base (a merged deletion)", () => {
      const store = new RepoStore();
      store.apply(snapshot({ overlays: { w1: [{ path: "README.md", kind: "deleted", stage: "committed", size: 0 }] } }));
      const last = lastChange(store);
      store.apply(
        patch(6, {
          base: { sha: "b2", upsert: [], remove: ["README.md"] },
          overlays: { w1: { upsert: [], remove: ["README.md"] } },
        }),
      );
      expect(last().merged).toEqual([]);
    });

    it("is empty for snapshots", () => {
      const store = new RepoStore();
      const last = lastChange(store);
      store.apply(snapshot());
      expect(last()).toEqual({ kind: "snapshot", merged: [] });
    });
  });

  it("notifies subscribers until they unsubscribe", () => {
    const store = new RepoStore();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.apply(snapshot());
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toBe(store.state);
    off();
    store.apply(patch(6));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
