import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KEY_OPEN_KEY } from "./encodingKey";
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

const LABELS = ["Unchanged file", "Edited, uncommitted", "New, uncommitted", "Committed on branch", "Deleted", "Merged into base"];

describe("MapKey", () => {
  it("starts open on a first visit, listing every mark with a swatch and a fuller tooltip", () => {
    render(MapKey, { theme: "vision", storage: storage() });
    const key = screen.getByRole("region", { name: "Map key" });
    expect(within(key).getByRole("button", { name: "Key" })).toHaveAttribute("aria-expanded", "true");
    const rows = within(key).getAllByTestId("map-key-entry");
    expect(rows.map((r) => r.textContent?.trim())).toEqual(LABELS);
    for (const r of rows) {
      expect(r.querySelector("svg.swatch")).toHaveAttribute("aria-hidden", "true");
      expect(r.getAttribute("title")?.length).toBeGreaterThan(20);
    }
    expect(within(key).getByText(/Circles are folders/)).toBeVisible();
  });

  it("draws the swatches as the map does in each theme", () => {
    const { unmount } = render(MapKey, { theme: "vision", storage: storage() });
    const vision = screen.getByRole("region", { name: "Map key" });
    const row = (el: HTMLElement, id: string): Element => el.querySelector(`[data-entry="${id}"]`)!;
    // Vision: gradient spheres; edits get a dashed ring, commits a solid one.
    expect(row(vision, "unchanged").querySelectorAll('.body[data-kind="ext"]')).toHaveLength(2);
    expect(row(vision, "edited").querySelector(".ring")).toHaveAttribute("stroke-dasharray", "4 3");
    expect(row(vision, "committed").querySelector(".ring")).not.toHaveAttribute("stroke-dasharray");
    expect(row(vision, "committed").querySelector(".body")).toHaveAttribute("data-kind", "worktree");
    expect(row(vision, "added").querySelector(".outline")).toHaveAttribute("stroke-dasharray", "2 2");
    expect(row(vision, "added").querySelector(".body")).toBeNull();
    expect(row(vision, "merged").querySelector(".flash")).not.toBeNull();
    unmount();

    render(MapKey, { theme: "night", storage: storage() });
    const night = screen.getByRole("region", { name: "Map key" });
    // Night: flat discs, idle files in graphite.
    const idle = row(night, "unchanged").querySelectorAll(".body");
    expect([...idle].map((b) => [b.getAttribute("data-kind"), b.getAttribute("fill")])).toEqual([
      ["flat", "#3a3a44"],
      ["flat", "#3a3a44"],
    ]);
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
