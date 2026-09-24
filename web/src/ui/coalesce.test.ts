import { describe, expect, it, vi } from "vitest";
import type { Change } from "../store";
import { FrameCoalescer, mergeChange } from "./coalesce";

const patch = (merged: string[]): Change => ({ kind: "patch", merged });

function fakeFrames(): { raf: (cb: () => void) => number; caf: (id: number) => void; tick: () => void; pending: () => number } {
  const q = new Map<number, () => void>();
  let id = 0;
  return {
    raf: (cb) => (q.set(++id, cb), id),
    caf: (i) => void q.delete(i),
    tick: () => {
      const cbs = [...q.values()];
      q.clear();
      for (const cb of cbs) cb();
    },
    pending: () => q.size,
  };
}

describe("mergeChange", () => {
  it("unions merged paths in order without duplicates", () => {
    expect(mergeChange(patch(["a", "b"]), patch(["b", "c"])).merged).toEqual(["a", "b", "c"]);
  });

  it("is a snapshot if either change is", () => {
    expect(mergeChange({ kind: "snapshot", merged: [] }, patch(["a"]))).toMatchObject({ kind: "snapshot", merged: ["a"] });
    expect(mergeChange(patch([]), { kind: "snapshot", merged: [] }).kind).toBe("snapshot");
  });

  it("returns the next change as-is when nothing is pending", () => {
    const c = patch(["a"]);
    expect(mergeChange(null, c)).toBe(c);
  });
});

describe("FrameCoalescer", () => {
  it("runs at most once per frame, with every merged path of the coalesced changes", () => {
    const f = fakeFrames();
    const run = vi.fn();
    const q = new FrameCoalescer(run, f.raf, f.caf);
    q.request(patch(["a"]));
    q.request(patch([]));
    q.request(patch(["b", "a"]));
    expect(run).not.toHaveBeenCalled();
    expect(f.pending()).toBe(1);
    f.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].merged).toEqual(["a", "b"]);
    f.tick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush runs the pending change now and cancels the frame", () => {
    const f = fakeFrames();
    const run = vi.fn();
    const q = new FrameCoalescer(run, f.raf, f.caf);
    q.request(patch(["a"]));
    q.flush();
    expect(run).toHaveBeenCalledWith(patch(["a"]));
    expect(f.pending()).toBe(0);
    q.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps working after a run throws", () => {
    const f = fakeFrames();
    const run = vi.fn().mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const q = new FrameCoalescer(run, f.raf, f.caf);
    q.request(patch(["a"]));
    expect(() => f.tick()).toThrow("boom");
    q.request(patch(["b"]));
    f.tick();
    expect(run).toHaveBeenLastCalledWith(patch(["b"]));
  });

  it("cancel drops the pending change", () => {
    const f = fakeFrames();
    const run = vi.fn();
    const q = new FrameCoalescer(run, f.raf, f.caf);
    q.request(patch(["a"]));
    q.cancel();
    f.tick();
    expect(run).not.toHaveBeenCalled();
  });
});
