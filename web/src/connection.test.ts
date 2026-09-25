import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs, connect, STOPPED_AFTER_FAILURES, statusAfterClose, wsUrlFromLocation } from "./connection";
import type { Patch, Snapshot } from "./protocol";
import { RepoStore } from "./store";

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  // test helpers
  open(): void {
    this.onopen?.();
  }
  message(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(): void {
    this.onclose?.();
  }
}

const snap: Snapshot = {
  type: "snapshot",
  seq: 1,
  repo: { name: "sample-app", base: "main", baseSha: "b" },
  worktrees: [],
  tree: [],
  overlays: {},
  activity: [],
};
const patch = (seq: number): Patch => ({ type: "patch", seq });
const last = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1]!;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("wsUrlFromLocation", () => {
  it("maps http to ws and https to wss on the same host", () => {
    expect(wsUrlFromLocation(new URL("http://127.0.0.1:7070/"))).toBe("ws://127.0.0.1:7070/ws");
    expect(wsUrlFromLocation(new URL("https://localhost:9000/x"))).toBe("wss://localhost:9000/ws");
  });

  it("forwards the ?t= token so a cookie-less first load still authenticates", () => {
    expect(wsUrlFromLocation(new URL("http://127.0.0.1:7070/?t=abc%2F1"))).toBe("ws://127.0.0.1:7070/ws?t=abc%2F1");
  });
});

describe("backoffMs", () => {
  it("doubles from 250ms and caps at 5s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 30].map(backoffMs)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });
});

describe("statusAfterClose", () => {
  it("reports reconnecting until STOPPED_AFTER_FAILURES consecutive failures, then stopped", () => {
    expect(STOPPED_AFTER_FAILURES).toBe(8);
    expect(statusAfterClose(1)).toBe("reconnecting");
    expect(statusAfterClose(7)).toBe("reconnecting");
    expect(statusAfterClose(8)).toBe("stopped");
    expect(statusAfterClose(50)).toBe("stopped");
  });
});

describe("connect", () => {
  it("applies messages to the store and reports status", () => {
    const store = new RepoStore();
    const statuses: string[] = [];
    connect(store, { url: "ws://x/ws", onStatus: (s) => statuses.push(s) });
    expect(last().url).toBe("ws://x/ws");
    last().open();
    last().message(snap);
    last().message(patch(2));
    expect(store.state?.seq).toBe(2);
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("sends one resync on a seq gap and none again until a snapshot arrives", () => {
    const store = new RepoStore();
    connect(store, { url: "ws://x/ws" });
    last().open();
    last().message(snap);
    last().message(patch(3));
    last().message(patch(4));
    expect(last().sent).toEqual([JSON.stringify({ type: "resync" })]);
    last().message({ ...snap, seq: 4 });
    last().message(patch(9));
    expect(last().sent).toHaveLength(2);
  });

  it("ignores frames that are not valid JSON", () => {
    const store = new RepoStore();
    connect(store, { url: "ws://x/ws" });
    last().open();
    last().onmessage?.({ data: "{nope" });
    expect(store.state).toBeNull();
  });

  it("reconnects with exponential backoff and resets after a successful open", () => {
    const store = new RepoStore();
    const statuses: string[] = [];
    connect(store, { url: "ws://x/ws", onStatus: (s) => statuses.push(s) });
    last().drop();
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(249);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    last().drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    last().open();
    last().drop();
    vi.advanceTimersByTime(250);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("reports stopped after 8 consecutive failed reconnects but keeps retrying quietly", () => {
    const store = new RepoStore();
    const statuses: string[] = [];
    connect(store, { url: "ws://x/ws", onStatus: (s) => statuses.push(s) });
    last().open();
    for (let i = 0; i < 7; i++) {
      last().drop();
      vi.advanceTimersByTime(5000);
    }
    expect(statuses.at(-1)).toBe("reconnecting");
    last().drop();
    expect(statuses.at(-1)).toBe("stopped");
    const before = FakeSocket.instances.length;
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances).toHaveLength(before + 1);
    last().drop();
    expect(statuses.at(-1)).toBe("stopped");
    vi.advanceTimersByTime(5000);
    last().open();
    expect(statuses.at(-1)).toBe("open");
  });

  it("calls onReconnect when a socket opens after a previous one was open and closed, but not on the first open", () => {
    const store = new RepoStore();
    const reconnects: number[] = [];
    let calls = 0;
    connect(store, { url: "ws://x/ws", onReconnect: () => reconnects.push(++calls) });
    last().open();
    expect(reconnects).toEqual([]);
    last().drop();
    vi.advanceTimersByTime(250);
    last().open();
    expect(reconnects).toEqual([1]);
    last().drop();
    vi.advanceTimersByTime(500);
    last().open();
    expect(reconnects).toEqual([1, 2]);
  });

  it("does not call onReconnect when reconnect attempts fail before ever opening", () => {
    const store = new RepoStore();
    const onReconnect = vi.fn();
    connect(store, { url: "ws://x/ws", onReconnect });
    last().drop();
    vi.advanceTimersByTime(250);
    last().drop();
    vi.advanceTimersByTime(500);
    last().open();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("stops reconnecting and closes the socket when disposed", () => {
    const store = new RepoStore();
    const stop = connect(store, { url: "ws://x/ws" });
    const sock = last();
    stop();
    expect(sock.closed).toBe(true);
    sock.drop();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
