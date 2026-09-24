import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeState, wt } from "../layout/fixtures";
import Legend from "./Legend.svelte";

const NOW = 50_000_000;

function repoState() {
  const s = makeState(
    { "a.ts": 1 },
    {
      w0: [{ path: "a.ts", kind: "modified", stage: "uncommitted", size: 1 }],
      w1: [
        { path: "b.ts", kind: "added", stage: "uncommitted", size: 1 },
        { path: "c.ts", kind: "added", stage: "committed", size: 1 },
      ],
    },
    [wt("w0", 0, "main"), wt("w1", 1, "feat/a"), wt("w2", 2, "fix/b"), wt("w3", 3, "chore/c")],
  );
  return s;
}

describe("Legend", () => {
  it("shows the repo name, active worktrees with changed counts, and collapses idle ones", async () => {
    render(Legend, { repo: repoState(), now: NOW, isolated: null, onIsolate: () => {} });
    expect(screen.getByRole("heading", { name: "sample-app" })).toBeInTheDocument();
    const pills = screen.getAllByTestId("worktree-pill");
    expect(pills.map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual(["main 1 changed files", "feat/a 2 changed files"]);
    expect(screen.getByRole("button", { name: /feat\/a 2 changed files/ })).toBeInTheDocument();
    expect(screen.queryByText("fix/b")).toBeNull();

    const more = screen.getByRole("button", { name: "+2 idle" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(screen.getByText("fix/b")).toBeInTheDocument();
    expect(screen.getByText("chore/c")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide idle" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps 30+ long-named idle worktrees inside its own scrolling list, full names in the tooltip", async () => {
    const long = (i: number): string => `agent/experiment-${String(i).padStart(2, "0")}-${"x".repeat(60 - 20)}`;
    const idle = Array.from({ length: 32 }, (_, i) => wt(`i${i}`, -1, long(i)));
    const s = makeState({ "a.ts": 1 }, { w0: [{ path: "a.ts", kind: "modified", stage: "uncommitted", size: 1 }] }, [wt("w0", 0, "main"), ...idle]);
    render(Legend, { repo: s, now: NOW, isolated: null, onIsolate: () => {} });
    await userEvent.click(screen.getByRole("button", { name: "+32 idle" }));

    const list = screen.getByTestId("legend-list");
    const pills = within(list).getAllByTestId("worktree-pill");
    expect(pills).toHaveLength(33);
    for (const [i, w] of idle.entries()) {
      expect(w.label).toHaveLength(60);
      expect(pills[i + 1]).toHaveAttribute("title", `${w.label}: ${w.path}`);
    }
  });

  it("isolates a worktree on click and clears on a second click", async () => {
    const onIsolate = vi.fn();
    const { rerender } = render(Legend, { repo: repoState(), now: NOW, isolated: null, onIsolate });
    await userEvent.click(screen.getByRole("button", { name: /feat\/a/ }));
    expect(onIsolate).toHaveBeenLastCalledWith("w1");

    await rerender({ isolated: "w1" });
    const pill = screen.getByRole("button", { name: /feat\/a/ });
    expect(pill).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /main/ })).toHaveClass("dim");
    await userEvent.click(pill);
    expect(onIsolate).toHaveBeenLastCalledWith(null);
  });
});
