import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { worktreeColor } from "../colors";
import { idleTint } from "../render/style";
import { KEY_OPEN_KEY, countSwatch, hexOf } from "./encodingKey";
import MapKey from "./MapKey.svelte";

function storage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const LABELS = [
  "Unchanged file",
  "Edited, uncommitted",
  "New, uncommitted",
  "Committed on branch",
  "Deleted",
  "Merged into base",
  "Now → a year ago",
  "Files in a small folder",
];

describe("MapKey", () => {
  it("starts open on a first visit, listing every mark with a swatch and a fuller tooltip", () => {
    render(MapKey, { theme: "vision", storage: storage() });
    const key = screen.getByRole("region", { name: "Map key" });
    expect(within(key).getByRole("button", { name: "Key" })).toHaveAttribute("aria-expanded", "true");
    const rows = within(key).getAllByTestId("map-key-entry");
    expect(rows.map((r) => r.querySelector("span")?.textContent?.trim())).toEqual(LABELS);
    for (const r of rows) {
      expect(r.querySelector("svg.swatch")).toHaveAttribute("aria-hidden", "true");
      expect(r.getAttribute("title")?.length).toBeGreaterThan(20);
    }
    expect(within(key).getByText(/Circles are folders/)).toBeVisible();
    expect(within(key).getByText(/Click: in one level/)).toHaveTextContent("Click: in one level · Double-click: straight in · Scroll: zoom · Esc: out · 0: home");
  });

  it("draws the swatches as the map does in each theme", () => {
    const { unmount } = render(MapKey, { theme: "vision", storage: storage() });
    const vision = screen.getByRole("region", { name: "Map key" });
    const row = (el: HTMLElement, id: string): Element => el.querySelector(`[data-entry="${id}"]`)!;
    // Flat discs: grey when unchanged, the worktree's colour when changed.
    const idle = hexOf(idleTint("vision", 0.6));
    expect([...row(vision, "unchanged").querySelectorAll(".body")].map((b) => b.getAttribute("fill"))).toEqual([idle, idle]);
    expect(row(vision, "edited").querySelector(".body")).toHaveAttribute("fill", worktreeColor(0));
    expect(row(vision, "edited").querySelector(".ring")).toBeNull();
    expect(row(vision, "edited").querySelector(".glyph")).toBeNull();
    expect(row(vision, "added").querySelector(".glyph")).toHaveAttribute("data-shape", "plus");
    expect(row(vision, "committed").querySelector(".ring")).not.toHaveAttribute("stroke-dasharray");
    expect(row(vision, "deleted").querySelector(".body")).toBeNull();
    expect(row(vision, "deleted").querySelector(".outline")).not.toBeNull();
    expect(row(vision, "deleted").querySelector(".glyph")).toHaveAttribute("data-shape", "cross");
    expect(row(vision, "merged").querySelector(".flash")).not.toBeNull();
    // The age strip: six discs, fading from now to a year ago.
    const ages = [...row(vision, "age").querySelectorAll(".body")].map((b) => Number(b.getAttribute("opacity")));
    expect(ages).toHaveLength(6);
    expect(ages[0]).toBeGreaterThan(ages[5]! * 4);
    // A collapsed folder: a faint disc with its file count, as the map draws it.
    expect(row(vision, "collapsed").querySelector(".disc")).toHaveAttribute("fill-opacity", String(countSwatch("vision").fill.alpha));
    expect(row(vision, "collapsed").querySelector(".count")).toHaveTextContent("12");
    unmount();

    render(MapKey, { theme: "night", storage: storage() });
    const night = screen.getByRole("region", { name: "Map key" });
    expect(row(night, "collapsed").querySelector(".disc")).toHaveAttribute("fill-opacity", String(countSwatch("night").fill.alpha));
    // Night: the same system in its own tones.
    const nightIdle = row(night, "unchanged").querySelectorAll(".body");
    expect([...nightIdle].map((b) => b.getAttribute("fill"))).toEqual([hexOf(idleTint("night", 0.6)), hexOf(idleTint("night", 0.6))]);
  });

  it("collapses and expands from its button (mouse or keyboard) and remembers the choice", async () => {
    const s = storage();
    const { unmount } = render(MapKey, { theme: "vision", storage: s });
    const button = screen.getByRole("button", { name: "Key" });
    const rows = document.getElementById(button.getAttribute("aria-controls")!)!;

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(rows).not.toBeVisible();
    expect(s.getItem(KEY_OPEN_KEY)).toBe("closed");

    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(rows).toBeVisible();
    await userEvent.keyboard(" ");
    expect(button).toHaveAttribute("aria-expanded", "false");
    unmount();

    // A later visit starts the way the viewer left it.
    render(MapKey, { theme: "vision", storage: s });
    const again = screen.getByRole("button", { name: "Key" });
    expect(again).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(again.getAttribute("aria-controls")!)).not.toBeVisible();
  });

  it("starts collapsed on a first visit to a narrow screen, where it would cover the activity sheet", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width: 720px") }));
    try {
      render(MapKey, { theme: "vision", storage: storage() });
      expect(screen.getByRole("button", { name: "Key" })).toHaveAttribute("aria-expanded", "false");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still works when storage is unavailable", async () => {
    render(MapKey, { theme: "night", storage: null });
    const button = screen.getByRole("button", { name: "Key" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});
