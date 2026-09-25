import { cleanup, render, screen, waitFor, within } from "@testing-library/svelte";
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
    onDoubleClick(): void {}
    onFocus(): void {}
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
  // Each test starts with a clean address bar: App reads it back on the
  // first snapshot, and a stale hash from an earlier test would otherwise
  // silently steer that test's own restore.
  history.replaceState(null, "", "/");
});

afterEach(() => {
  // Without this, an earlier test's App instance stays mounted (its
  // svelte:window keydown binding and its onMount's popstate/hashchange
  // listeners keep firing), so a later test's synthetic key presses or
  // dispatched events would reach every still-mounted instance too.
  cleanup();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
  // vi.spyOn reuses an existing spy on the same object/method instead of
  // wrapping it again, so an unrestored history.pushState/replaceState spy
  // from one test would otherwise keep recording the next test's calls too.
  vi.restoreAllMocks();
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

  it("shows where the map is zoomed as breadcrumbs; Backspace/- step out, +/= step in, 0/Home go home", async () => {
    render(App);
    await waitFor(() => expect(h.store).not.toBeNull());
    h.store!.apply({
      ...snapshot,
      tree: [{ path: "a.ts", size: 10 }, { path: "src/lib/x.ts", size: 10 }, { path: "src/lib/y.ts", size: 10 }, { path: "src/lib/deep/z.ts", size: 10 }],
      activity: [{ ts: Date.now(), worktree: "w1", kind: "modified", path: "src/lib/deep/z.ts" }],
    });
    const crumbs = await screen.findByTestId("breadcrumbs");
    await waitFor(() => expect(h.updates).toBeGreaterThan(0));
    expect(crumbs).toHaveTextContent("sample-app");

    await userEvent.click(await screen.findByRole("button", { name: /z\.ts/ }));
    expect(h.zoomTo.at(-1)).toBe("src/lib/deep");
    // src holds only lib, so the chain is one level.
    await waitFor(() => expect([...crumbs.querySelectorAll("ol button")].map((b) => b.textContent)).toEqual(["sample-app", "src/lib", "deep"]));

    await userEvent.keyboard("{Backspace}");
    expect(h.zoomTo.at(-1)).toBe("src/lib");
    await userEvent.click(within(crumbs).getByRole("button", { name: "sample-app" }));
    expect(h.zoomTo.at(-1)).toBe("");

    // 0/Home go home from any depth.
    await userEvent.click(await screen.findByRole("button", { name: /z\.ts/ }));
    expect(h.zoomTo.at(-1)).toBe("src/lib/deep");
    await userEvent.keyboard("0");
    expect(h.zoomTo.at(-1)).toBe("");
    await userEvent.click(await screen.findByRole("button", { name: /z\.ts/ }));
    await userEvent.keyboard("{Home}");
    expect(h.zoomTo.at(-1)).toBe("");

    // +/= step in one level (the map's own hover is untracked in this
    // harness, so this exercises the "largest child" fallback): src holds
    // only lib, so the one child level of the root is src/lib.
    await userEvent.keyboard("+");
    expect(h.zoomTo.at(-1)).toBe("src/lib");
    await userEvent.keyboard("=");
    expect(h.zoomTo.at(-1)).toBe("src/lib/deep");
  });

  it("every discrete zoom (click, Esc, +, 0/Home, an Activity row) pushes a history entry; the hash follows", async () => {
    const pushed = vi.spyOn(history, "pushState");
    const replaced = vi.spyOn(history, "replaceState");
    render(App);
    await waitFor(() => expect(h.store).not.toBeNull());
    h.store!.apply({
      ...snapshot,
      tree: [{ path: "a.ts", size: 10 }, { path: "src/lib/x.ts", size: 10 }, { path: "src/lib/y.ts", size: 10 }, { path: "src/lib/deep/z.ts", size: 10 }],
      activity: [{ ts: Date.now(), worktree: "w1", kind: "modified", path: "src/lib/deep/z.ts" }],
    });
    const crumbs = await screen.findByTestId("breadcrumbs");
    await waitFor(() => expect(h.updates).toBeGreaterThan(0));

    // An Activity row jump.
    await userEvent.click(await screen.findByRole("button", { name: /z\.ts/ }));
    expect(location.hash).toBe("#/src/lib/deep");
    expect(pushed).toHaveBeenCalledTimes(1);

    // Backspace steps out.
    await userEvent.keyboard("{Backspace}");
    expect(location.hash).toBe("#/src/lib");
    expect(pushed).toHaveBeenCalledTimes(2);

    // + steps in.
    await userEvent.keyboard("+");
    expect(location.hash).toBe("#/src/lib/deep");
    expect(pushed).toHaveBeenCalledTimes(3);

    // 0 goes home.
    await userEvent.keyboard("0");
    expect(location.hash).toBe("#/");
    expect(pushed).toHaveBeenCalledTimes(4);

    // A breadcrumb click.
    await userEvent.click(await screen.findByRole("button", { name: /z\.ts/ }));
    await userEvent.click(within(crumbs).getByRole("button", { name: "sample-app" }));
    expect(location.hash).toBe("#/");
    expect(pushed).toHaveBeenCalledTimes(6);

    expect(replaced, "no free-camera move happened in this harness, so nothing should have replaced the hash").not.toHaveBeenCalled();
  });

  it("hiding the folder you're in replaces the hash with its visible ancestor, instead of pushing", async () => {
    const pushed = vi.spyOn(history, "pushState");
    const replaced = vi.spyOn(history, "replaceState");
    render(App);
    await waitFor(() => expect(h.store).not.toBeNull());
    h.store!.apply({ ...snapshot, tree: [{ path: "a.ts", size: 10 }, { path: "src/lib/x.ts", size: 10 }] });
    await waitFor(() => expect(h.updates).toBeGreaterThan(0));

    await userEvent.keyboard("+"); // -> "src/lib" (src's only child level)
    expect(location.hash).toBe("#/src/lib");
    expect(pushed).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /Folders/ }));
    await userEvent.click(screen.getByLabelText("src", { exact: true }));

    await waitFor(() => expect(location.hash).toBe("#/"));
    expect(h.zoomTo.at(-1)).toBe("");
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(pushed, "hiding the current folder must not add a history entry").toHaveBeenCalledTimes(1);
  });

  it("a stored location naming a now-hidden path lands on the visible ancestor and corrects the hash, without revealing it", async () => {
    render(App);
    await waitFor(() => expect(h.store).not.toBeNull());
    h.store!.apply({ ...snapshot, tree: [{ path: "a.ts", size: 10 }, { path: "src/lib/deep/z.ts", size: 10 }] });
    await waitFor(() => expect(h.updates).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("button", { name: /Folders/ }));
    const checkbox = screen.getByLabelText("src", { exact: true });
    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    // Simulate arriving here via Back at an old hash from before "src" was hidden.
    history.pushState(null, "", "#/src/lib/deep");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => expect(location.hash).toBe("#/"));
    expect(h.zoomTo.at(-1)).toBe("");
    expect(checkbox, "the filter itself is unchanged").not.toBeChecked();
  });

  it("navigateTo (an explicit jump) reveals a hidden folder, unlike a stored or retraced location", async () => {
    const { navigateTo } = await import("./navigate");
    render(App);
    await waitFor(() => expect(h.store).not.toBeNull());
    h.store!.apply({ ...snapshot, tree: [{ path: "a.ts", size: 10 }, { path: "src/lib/deep/z.ts", size: 10 }] });
    await waitFor(() => expect(h.updates).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("button", { name: /Folders/ }));
    const checkbox = screen.getByLabelText("src", { exact: true });
    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    navigateTo("src/lib/deep/z.ts");

    await waitFor(() => expect(h.zoomTo.at(-1)).toBe("src/lib/deep"));
    expect(checkbox, "navigateTo un-hides the folder it jumps into").toBeChecked();
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

  it("shows a key to the map's marks", async () => {
    await ready();
    expect(screen.getByRole("region", { name: "Map key" })).toBeInTheDocument();
  });

  it("has no map key when the renderer cannot start", async () => {
    h.initFails = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(App);
    await screen.findByRole("alert");
    expect(screen.queryByRole("region", { name: "Map key" })).toBeNull();
    err.mockRestore();
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
