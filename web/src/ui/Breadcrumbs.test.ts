import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Breadcrumbs from "./Breadcrumbs.svelte";

const trail = [
  { path: "", label: "demo" },
  { path: "web/src", label: "web/src" },
  { path: "web/src/components", label: "components" },
];

describe("Breadcrumbs", () => {
  it("shows one button per level, the last marked as the current location", () => {
    render(Breadcrumbs, { crumbs: trail, onSelect: () => {} });
    const nav = screen.getByTestId("breadcrumbs");
    const buttons = within(nav.querySelector("ol")!).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["demo", "web/src", "components"]);
    expect(buttons[2]).toHaveAttribute("aria-current", "location");
    expect(buttons[0]).not.toHaveAttribute("aria-current");
    expect(nav).toHaveAccessibleName("Map location");
  });

  describe("home button", () => {
    it("is hidden at home (a single crumb)", () => {
      render(Breadcrumbs, { crumbs: [{ path: "", label: "demo" }], onSelect: () => {} });
      expect(screen.queryByRole("button", { name: /Home/ })).toBeNull();
    });

    it("shows once away from home, has an accessible label, can be reached by keyboard, and zooms to the root", async () => {
      const onSelect = vi.fn();
      render(Breadcrumbs, { crumbs: trail, onSelect });
      const home = screen.getByRole("button", { name: /Home/ });
      home.focus();
      expect(home).toHaveFocus();
      await userEvent.click(home);
      expect(onSelect).toHaveBeenCalledWith("");
    });
  });

  it("zooms to the folder of the clicked segment, the repo name to the root", async () => {
    const onSelect = vi.fn();
    render(Breadcrumbs, { crumbs: trail, onSelect });
    await userEvent.click(screen.getByRole("button", { name: "web/src" }));
    await userEvent.click(screen.getByRole("button", { name: "demo" }));
    expect(onSelect.mock.calls).toEqual([["web/src"], [""]]);
  });

  it("sits in the slot it is given (clear of the panels)", () => {
    render(Breadcrumbs, { crumbs: trail, slot: { x: 640, top: 332, maxWidth: 300 }, onSelect: () => {} });
    const nav = screen.getByTestId("breadcrumbs");
    expect(nav.style.left).toBe("640px");
    expect(nav.style.top).toBe("332px");
    expect(nav.style.maxWidth).toBe("300px");
  });

  describe("with measured widths", () => {
    // jsdom has no layout: every crumb (separator included) is 10px per character.
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return { width: (this.textContent ?? "").length * 10 } as DOMRect;
      });
    });
    afterEach(() => vi.restoreAllMocks());

    const deep = [
      { path: "", label: "demo" }, // 40
      { path: "web", label: "web" }, // "/web" 40
      { path: "web/src", label: "src" }, // "/src" 40
      { path: "web/src/components", label: "components" }, // "/components" 110
      { path: "web/src/components/styles", label: "styles" }, // "/styles" 70
    ];
    // The "…" crumb is "/…": 20. The pill's padding and border: 14.

    it("reports the pill's width whole and collapsed", async () => {
      const onMeasure = vi.fn();
      render(Breadcrumbs, { crumbs: deep, onMeasure, onSelect: () => {} });
      await waitFor(() => expect(onMeasure).toHaveBeenLastCalledWith({ full: 14 + 300, min: 14 + 40 + 20 + 70 }));
    });

    it("shows the whole trail when it fits its slot", async () => {
      render(Breadcrumbs, { crumbs: deep, slot: { x: 500, top: 16, maxWidth: 314 }, onSelect: () => {} });
      const nav = screen.getByTestId("breadcrumbs");
      await waitFor(() => expect(within(nav.querySelector("ol")!).getAllByRole("button").map((b) => b.textContent)).toEqual(["demo", "web", "src", "components", "styles"]));
    });

    it("collapses the middle of a trail too long for its slot into one …, which zooms to the deepest hidden level", async () => {
      const onSelect = vi.fn();
      render(Breadcrumbs, { crumbs: deep, slot: { x: 500, top: 16, maxWidth: 260 }, onSelect });
      const nav = screen.getByTestId("breadcrumbs");
      await waitFor(() => expect(within(nav.querySelector("ol")!).getAllByRole("button").map((b) => b.textContent)).toEqual(["demo", "…", "components", "styles"]));
      const more = screen.getByRole("button", { name: "web/src" });
      expect(more).toHaveAttribute("title", "web/src");
      await userEvent.click(more);
      expect(onSelect).toHaveBeenCalledWith("web/src");
      expect(screen.getByRole("button", { name: "styles" })).toHaveAttribute("aria-current", "location");
    });
  });
});
