import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["demo", "web/src", "components"]);
    expect(buttons[2]).toHaveAttribute("aria-current", "location");
    expect(buttons[0]).not.toHaveAttribute("aria-current");
    expect(nav).toHaveAccessibleName("Map location");
  });

  it("zooms to the folder of the clicked segment, the repo name to the root", async () => {
    const onSelect = vi.fn();
    render(Breadcrumbs, { crumbs: trail, onSelect });
    await userEvent.click(screen.getByRole("button", { name: "web/src" }));
    await userEvent.click(screen.getByRole("button", { name: "demo" }));
    expect(onSelect.mock.calls).toEqual([["web/src"], [""]]);
  });

  it("centres over the map's free area when given its centre", () => {
    render(Breadcrumbs, { crumbs: trail, centerX: 640, onSelect: () => {} });
    expect(screen.getByTestId("breadcrumbs").style.left).toBe("640px");
  });
});
