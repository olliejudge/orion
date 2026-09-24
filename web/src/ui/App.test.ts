import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Patch, Snapshot, Worktree } from "../protocol";
import type { RepoStore } from "../store";

// App composes the real store, layout and panels; only the WebGL renderer and
// the socket are replaced (jsdom has neither).
const h = vi.hoisted(() => ({
  store: null as RepoStore | null,
  initFails: false,
  isolate: [] as (string | null)[],
  zoomTo: [] as string[],
  highlight: [] as (string | null)[],
  updates: 0,
  updateThrows: false,
}));

vi.mock("../connection", () => ({
  connect: (store: RepoStore, opts?: { onStatus?: (s: string) => void }) => {
    h.store = store;
    opts?.onStatus?.("open");
    return () => {};
  },
}));

vi.mock("../render/MapRenderer", () => ({
  MapRenderer: class {
    init(): Promise<void> {
      return h.initFails ? Promise.reject(new Error("no context")) : Promise.resolve();
    }
    update(): void {
      h.updates++;
      if (h.updateThrows) throw new Error("renderer broke");
    }
    setFreeArea(): void {}
    setTheme(): void {}
    isolate(id: string | null): void {
      h.isolate.push(id);
    }
    highlight(path: string | null): void {
      h.highlight.push(path);
    }
    zoomTo(path: string): void {
      h.zoomTo.push(path);
    }
    onZoom(): void {}
    onClick(): void {}
    onHover(): void {}
    destroy(): void {}
  },
}));

const { default: App } = await import("./App.svelte");

const wt = (id: string, colorIndex: number, label: string): Worktree => ({
  id,
  path: `/repo/${id}`,
  label,
  head: "0000000",
  isMain: colorIndex === 0,
  locked: false,
  colorIndex,
});

const snapshot: Snapshot = {
  type: "snapshot",
  seq: 1,
  repo: { name: "sample-app", base: "origin/main", baseSha: "b0" },
  worktrees: [wt("w0", 0, "main"), wt("w1", 1, "feat/a")],
  tree: [{ path: "a.ts", size: 10 }],
  overlays: {
    w0: [{ path: "a.ts", kind: "modified", stage: "uncommitted", size: 12 }],
    w1: [{ path: "b.ts", kind: "added", stage: "uncommitted", size: 5 }],
  },
  activity: [],
};

// jsdom has no layout: give every element (the map included) a viewport-like size.
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });

beforeEach(() => {
  h.store = null;
  h.initFails = false;
  h.isolate = [];
  h.zoomTo = [];
  h.highlight = [];
  h.updates = 0;
  h.updateThrows = false;
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

async function ready(): Promise<RepoStore> {
  render(App);
  await waitFor(() => expect(h.store).not.toBeNull());
  h.store!.apply(snapshot);
  await screen.findAllByTestId("worktree-pill");
  return h.store!;
}

describe("App", () => {
  it("shows a pill per changed worktree and the live pill", async () => {
    await ready();
    expect(screen.getAllByTestId("worktree-pill")).toHaveLength(2);
    expect(screen.getByTestId("live-pill")).toHaveTextContent("Live");
  });

  it("clears the isolation when the isolated worktree goes away", async () => {
    const store = await ready();
    await userEvent.click(screen.getByRole("button", { name: /feat\/a/ }));
    expect(h.isolate.at(-1)).toBe("w1");

    const gone: Patch = { type: "patch", seq: 2, worktrees: [wt("w0", 0, "main")], overlays: { w1: { upsert: [], remove: ["b.ts"] } } };
    store.apply(gone);
    await waitFor(() => expect(h.isolate.at(-1)).toBeNull());
    expect(screen.getByRole("button", { name: /main/ })).not.toHaveClass("dim");
  });

  it("Esc clears the isolation first, then zooms out", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /feat\/a/ }));
    expect(h.isolate.at(-1)).toBe("w1");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(h.isolate.at(-1)).toBeNull());
    expect(h.zoomTo).toEqual([]);

    await userEvent.keyboard("{Escape}");
    expect(h.zoomTo).toEqual([""]);
  });

  it("explains a renderer that cannot start instead of showing a blank page", async () => {
    h.initFails = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(App);
    expect(await screen.findByRole("alert")).toHaveTextContent("Can’t draw the map");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    // The panels still work without the map.
    await waitFor(() => expect(h.store).not.toBeNull());
    h.store!.apply(snapshot);
    expect(await screen.findAllByTestId("worktree-pill")).toHaveLength(2);
  });

  it("labels the map for assistive tech", async () => {
    await ready();
    expect(screen.getByRole("img", { name: "Repository map" })).toBe(screen.getByTestId("map"));
  });

  it("highlights the collapsed folder that holds a hovered activity row's file", async () => {
    render(App);
    await waitFor(() => expect(h.store).not.toBeNull());
    // Beside a huge file the vendor folder is too small to open at fit zoom.
    h.store!.apply({
      ...snapshot,
      tree: [{ path: "big.bin", size: 50_000_000 }, { path: "vendor/lib/x.js", size: 10 }, { path: "vendor/lib/y.js", size: 10 }],
      activity: [{ ts: Date.now(), worktree: "w1", kind: "modified", path: "vendor/lib/x.js" }],
    });
    const row = await screen.findByRole("button", { name: /x\.js/ });
    await waitFor(() => expect(h.updates).toBeGreaterThan(0));
    await userEvent.hover(row);
    const shown = h.highlight.at(-1);
    expect(shown === "vendor" || shown === "vendor/lib").toBe(true);
    await userEvent.unhover(row);
    expect(h.highlight.at(-1)).toBeNull();
  });

  it("logs a renderer error on a patch and keeps applying later ones", async () => {
    const store = await ready();
    await waitFor(() => expect(h.updates).toBeGreaterThan(0));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.updateThrows = true;
    const before = h.updates;
    store.apply({ type: "patch", seq: 2, overlays: { w1: { upsert: [{ path: "c.ts", kind: "added", stage: "uncommitted", size: 1 }], remove: [] } } });
    await waitFor(() => expect(err).toHaveBeenCalled());
    h.updateThrows = false;
    store.apply({ type: "patch", seq: 3, overlays: { w1: { upsert: [{ path: "d.ts", kind: "added", stage: "uncommitted", size: 1 }], remove: [] } } });
    await waitFor(() => expect(h.updates).toBeGreaterThan(before + 1));
    err.mockRestore();
  });
});
