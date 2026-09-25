import { describe, expect, it, vi } from "vitest";
import { decodeLocation, encodeLocation, HashSync, type HistoryLike } from "./location";

describe("encodeLocation", () => {
  it("is '#/' at the root", () => {
    expect(encodeLocation("")).toBe("#/");
  });

  it("joins segments with '/'", () => {
    expect(encodeLocation("web/src/ui")).toBe("#/web/src/ui");
  });

  it("percent-encodes odd characters per segment", () => {
    expect(encodeLocation("a b/c#d/e%f")).toBe("#/a%20b/c%23d/e%25f");
  });
});

describe("decodeLocation", () => {
  it("is '' at the root", () => {
    expect(decodeLocation("#/")).toBe("");
  });

  it("is null when there is no location hash", () => {
    expect(decodeLocation("")).toBeNull();
    expect(decodeLocation("#")).toBeNull();
    expect(decodeLocation("#foo")).toBeNull();
  });

  it("decodes percent-encoded segments back to the original path", () => {
    expect(decodeLocation("#/a%20b/c%23d/e%25f")).toBe("a b/c#d/e%f");
  });

  it("ignores a trailing slash", () => {
    expect(decodeLocation("#/web/src/")).toBe("web/src");
    expect(decodeLocation("#//")).toBe("");
  });

  it("is null for malformed percent-encoding, e.g. a hand-edited URL", () => {
    expect(decodeLocation("#/100%")).toBeNull();
  });

  it("round-trips every path encodeLocation produces", () => {
    for (const path of ["", "web", "web/src/ui", "docs/spec (draft).md", "café/日本語", "a b/c#d/e%f?g"]) {
      expect(decodeLocation(encodeLocation(path))).toBe(path);
    }
  });
});

/** A fake History that records calls instead of touching the real address bar. */
function fakeHistory(): HistoryLike & { calls: { kind: "push" | "replace"; hash: string }[] } {
  const calls: { kind: "push" | "replace"; hash: string }[] = [];
  return {
    calls,
    pushState: (_d, _u, url) => calls.push({ kind: "push", hash: String(url) }),
    replaceState: (_d, _u, url) => calls.push({ kind: "replace", hash: String(url) }),
  };
}

type TimerId = ReturnType<typeof setTimeout>;

/** A fake timer queue: setTimer schedules, tick() runs everything due so far. */
function fakeTimers(): {
  setTimer: (fn: () => void, ms: number) => TimerId;
  clearTimer: (id: TimerId) => void;
  tick: (ms: number) => void;
} {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  return {
    setTimer: (fn, ms) => {
      const id = ++nextId;
      pending.set(id, { fn, at: now + ms });
      return id as unknown as TimerId;
    },
    clearTimer: (id) => void pending.delete(id as unknown as number),
    tick: (ms) => {
      now += ms;
      for (const [id, t] of [...pending.entries()]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

describe("HashSync (push-vs-replace policy)", () => {
  it("push writes immediately and adds a history entry", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("", history, 300, t.setTimer, t.clearTimer);
    sync.push("web/src");
    expect(history.calls).toEqual([{ kind: "push", hash: "#/web/src" }]);
  });

  it("push is a no-op when the path repeats the hash's current value", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("web/src", history, 300, t.setTimer, t.clearTimer);
    sync.push("web/src");
    expect(history.calls).toEqual([]);
  });

  it("replace defers past the debounce window, writing once it settles", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("", history, 300, t.setTimer, t.clearTimer);
    sync.replace("web");
    expect(history.calls).toEqual([]); // not yet: still debouncing
    t.tick(299);
    expect(history.calls).toEqual([]);
    t.tick(1);
    expect(history.calls).toEqual([{ kind: "replace", hash: "#/web" }]);
  });

  it("a flurry of replace calls coalesces to just the last target", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("", history, 300, t.setTimer, t.clearTimer);
    sync.replace("a");
    t.tick(100);
    sync.replace("a/b");
    t.tick(100);
    sync.replace("a/b/c");
    t.tick(300);
    expect(history.calls).toEqual([{ kind: "replace", hash: "#/a/b/c" }]);
  });

  it("replace back to the hash's current value before it settles writes nothing", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("web", history, 300, t.setTimer, t.clearTimer);
    sync.replace("web/src");
    sync.replace("web"); // back to where we started
    t.tick(300);
    expect(history.calls).toEqual([]);
  });

  it("a discrete push cancels a pending debounced replace instead of racing it", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("", history, 300, t.setTimer, t.clearTimer);
    sync.replace("web/src"); // e.g. mid wheel-zoom
    sync.push("docs"); // then a click lands somewhere else entirely
    t.tick(300);
    expect(history.calls).toEqual([{ kind: "push", hash: "#/docs" }]);
  });

  it("replaceNow writes immediately, uncoalesced with any pending replace", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("", history, 300, t.setTimer, t.clearTimer);
    sync.replace("web/src"); // debouncing
    sync.replaceNow("docs"); // e.g. a load-time correction to an existing ancestor
    t.tick(300);
    expect(history.calls).toEqual([{ kind: "replace", hash: "#/docs" }]);
  });

  it("sync records the hash's value without writing to it", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("", history, 300, t.setTimer, t.clearTimer);
    sync.sync("web/src"); // e.g. after a popstate
    expect(history.calls).toEqual([]);
    sync.push("web/src"); // now a no-op: the hash already reads this
    expect(history.calls).toEqual([]);
  });

  it("sync drops a pending debounced replace instead of letting it fire later", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("", history, 300, t.setTimer, t.clearTimer);
    sync.replace("web/src");
    sync.sync("docs"); // the browser jumped elsewhere in the meantime (e.g. popstate)
    t.tick(300);
    expect(history.calls).toEqual([]);
  });

  it("flush commits a pending replace immediately (e.g. before the page unloads)", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("", history, 300, t.setTimer, t.clearTimer);
    sync.replace("web/src");
    sync.flush();
    expect(history.calls).toEqual([{ kind: "replace", hash: "#/web/src" }]);
    t.tick(300);
    expect(history.calls).toHaveLength(1); // the debounce timer was cancelled, not left to fire again
  });

  it("flush is a no-op when nothing is pending", () => {
    const history = fakeHistory();
    const t = fakeTimers();
    const sync = new HashSync("", history, 300, t.setTimer, t.clearTimer);
    sync.flush();
    expect(history.calls).toEqual([]);
  });

  it("uses the real History and setTimeout by default", () => {
    vi.useFakeTimers();
    try {
      const start = location.hash;
      const sync = new HashSync(start.startsWith("#/") ? start.slice(2) : "");
      sync.push("a-real-push-test");
      expect(location.hash).toBe("#/a-real-push-test");
    } finally {
      history.replaceState(null, "", "#/");
      vi.useRealTimers();
    }
  });
});
