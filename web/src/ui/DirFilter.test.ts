import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DIRFILTER_OPEN_KEY, type DirEntry } from "../layout/exclude";
import DirFilter from "./DirFilter.svelte";

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

const DIRS: DirEntry[] = [
  { path: "src", name: "src", children: [{ path: "src/lib", name: "lib", children: [{ path: "src/lib/deep", name: "deep", children: [] }] }] },
  { path: "docs", name: "docs", children: [] },
];

function open(dirs = DIRS, excluded: ReadonlySet<string> = new Set<string>(), onChange = vi.fn(), s = storage({ [DIRFILTER_OPEN_KEY]: "open" })) {
  render(DirFilter, { dirs, excluded, onChange, storage: s });
  return { onChange, s };
}

describe("DirFilter", () => {
  it("starts collapsed on a first visit, with no badge when nothing is hidden", () => {
    render(DirFilter, { dirs: DIRS, excluded: new Set<string>(), onChange: vi.fn(), storage: storage() });
    const button = screen.getByRole("button", { name: /Folders/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(within(button).queryByText(/hidden/)).toBeNull();
  });

  it("shows a count badge when directories are hidden", () => {
    render(DirFilter, { dirs: DIRS, excluded: new Set(["docs", "src/lib"]), onChange: vi.fn(), storage: storage() });
    expect(screen.getByText("2 hidden")).toBeInTheDocument();
  });

  it("lists the top level expanded, deeper levels collapsed behind a caret", () => {
    open();
    const panel = screen.getByTestId("dir-filter");
    expect(within(panel).getByLabelText("src")).toBeInTheDocument();
    expect(within(panel).getByLabelText("docs")).toBeInTheDocument();
    // src/lib exists (top level is expanded) but its own child is collapsed.
    expect(within(panel).getByLabelText("lib")).toBeInTheDocument();
    expect(within(panel).queryByLabelText("deep")).toBeNull();
    const caret = within(panel).getByRole("button", { name: "Expand" });
    expect(caret).toHaveAttribute("aria-expanded", "false");
  });

  it("expands a deeper level from its caret", async () => {
    open();
    const panel = screen.getByTestId("dir-filter");
    const caret = within(panel).getByRole("button", { name: "Expand" });
    await userEvent.click(caret);
    expect(caret).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByLabelText("deep")).toBeInTheDocument();
  });

  it("unticking a directory reports it added to the excluded set", async () => {
    const { onChange } = open();
    await userEvent.click(screen.getByLabelText("docs"));
    expect(onChange).toHaveBeenCalledWith(new Set(["docs"]));
  });

  it("re-ticking an excluded directory reports it removed", async () => {
    const onChange = vi.fn();
    open(DIRS, new Set(["docs"]), onChange);
    await userEvent.click(screen.getByLabelText("docs"));
    expect(onChange).toHaveBeenCalledWith(new Set<string>());
  });

  it("disables (but does not un-list) descendants of a hidden directory", () => {
    open(DIRS, new Set(["src"]));
    // src is auto-expanded (top level), so its child "lib" is listed without
    // any click, already showing as hidden and non-editable.
    const lib = screen.getByLabelText("lib") as HTMLInputElement;
    expect(lib.checked).toBe(false);
    expect(lib).toBeDisabled();
  });

  it("the directly-excluded directory itself stays editable", () => {
    open(DIRS, new Set(["src"]));
    const src = screen.getByLabelText("src") as HTMLInputElement;
    expect(src.checked).toBe(false);
    expect(src).not.toBeDisabled();
  });

  it('"Show all" clears every exclusion', async () => {
    const onChange = vi.fn();
    open(DIRS, new Set(["docs", "src"]), onChange);
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onChange).toHaveBeenCalledWith(new Set<string>());
  });

  it('"Show all" is disabled when nothing is hidden', () => {
    open(DIRS, new Set<string>());
    expect(screen.getByRole("button", { name: "Show all" })).toBeDisabled();
  });

  it("collapses and expands the panel from its toggle and remembers the choice", async () => {
    const s = storage();
    const { unmount } = render(DirFilter, { dirs: DIRS, excluded: new Set<string>(), onChange: vi.fn(), storage: s });
    const button = screen.getByRole("button", { name: /Folders/ });
    expect(button).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(s.getItem(DIRFILTER_OPEN_KEY)).toBe("open");
    unmount();

    render(DirFilter, { dirs: DIRS, excluded: new Set<string>(), onChange: vi.fn(), storage: s });
    expect(screen.getByRole("button", { name: /Folders/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("still works when storage is unavailable", async () => {
    render(DirFilter, { dirs: DIRS, excluded: new Set<string>(), onChange: vi.fn(), storage: null });
    const button = screen.getByRole("button", { name: /Folders/ });
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("says so when the repo has no directories", () => {
    open([]);
    expect(screen.getByText("No folders yet.")).toBeInTheDocument();
  });
});
