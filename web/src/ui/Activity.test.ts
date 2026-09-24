import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeState } from "../layout/fixtures";
import type { Activity as Item } from "../protocol";
import Activity from "./Activity.svelte";

const NOW = 100_000_000;

function repoWith(activity: Item[]) {
  const s = makeState({});
  s.activity = activity;
  return s;
}

describe("Activity", () => {
  it("lists newest first with base name, dimmed folder, kind and relative time", () => {
    render(Activity, {
      repo: repoWith([
        { ts: NOW - 120_000, worktree: "w2", kind: "added", path: "db/pool.ts" },
        { ts: NOW - 2_000, worktree: "w1", kind: "modified", path: "src/auth/session.ts" },
      ]),
      now: NOW,
      onHover: () => {},
      onSelect: () => {},
    });
    const rows = within(screen.getByTestId("activity")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("src/auth/session.ts");
    expect(within(rows[0]!).getByText("session.ts")).toHaveClass("name");
    expect(within(rows[0]!).getByText("src/auth/")).toHaveClass("dir");
    expect(rows[0]).toHaveTextContent("edited");
    expect(rows[0]).toHaveTextContent("now");
    expect(rows[1]).toHaveTextContent("pool.ts");
    expect(rows[1]).toHaveTextContent("new");
    expect(rows[1]).toHaveTextContent("2m");
  });

  it("shows a coalesced burst as one row with a count", () => {
    render(Activity, {
      repo: repoWith([
        { ts: NOW - 9_000, worktree: "w1", kind: "modified", path: "a.ts" },
        { ts: NOW - 6_000, worktree: "w1", kind: "modified", path: "a.ts" },
        { ts: NOW - 3_000, worktree: "w1", kind: "modified", path: "a.ts" },
      ]),
      now: NOW,
      onHover: () => {},
      onSelect: () => {},
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("edited ×3");
  });

  it("emphasises commit and merge rows", () => {
    render(Activity, {
      repo: repoWith([
        { ts: NOW - 5_000, worktree: "w1", kind: "commit", sha: "abc1234", subject: "Add session refresh", files: 3 },
        { ts: NOW - 1_000, worktree: "w1", kind: "merge", files: 1 },
      ]),
      now: NOW,
      onHover: () => {},
      onSelect: () => {},
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Merged 1 file into origin/main");
    expect(rows[1]).toHaveTextContent("Committed 3 files");
    expect(rows[1]).toHaveTextContent("Add session refresh");
    for (const r of rows) expect(r).toHaveClass("emphasis");
  });

  it("highlights on hover and selects on click", async () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    render(Activity, {
      repo: repoWith([{ ts: NOW, worktree: "w1", kind: "modified", path: "src/a.ts" }]),
      now: NOW,
      onHover,
      onSelect,
    });
    const row = screen.getByRole("button", { name: /a\.ts/ });
    await userEvent.hover(row);
    expect(onHover).toHaveBeenLastCalledWith("src/a.ts");
    await userEvent.unhover(row);
    expect(onHover).toHaveBeenLastCalledWith(null);
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });

  it("invites the user when there is nothing yet", () => {
    render(Activity, { repo: repoWith([]), now: NOW, onHover: () => {}, onSelect: () => {} });
    expect(screen.getByText(/appear here as they happen/)).toBeInTheDocument();
  });
});
