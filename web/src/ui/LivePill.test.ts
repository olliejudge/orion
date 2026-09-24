import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import LivePill from "./LivePill.svelte";

describe("LivePill", () => {
  it("centres under the map's free area when given its centre", () => {
    render(LivePill, { status: "open", centerX: 746 });
    expect(screen.getByTestId("live-pill").style.left).toBe("746px");
  });

  it("falls back to the viewport centre (the stylesheet's 50%) before the map is laid out", () => {
    render(LivePill, { status: "connecting" });
    expect(screen.getByTestId("live-pill").style.left).toBe("");
  });

  it("tells the user to rerun Orion once reconnecting has given up hope", () => {
    render(LivePill, { status: "stopped" });
    const pill = screen.getByTestId("live-pill");
    expect(pill).toHaveTextContent("Orion stopped — run orion again and open the new URL");
    expect(pill.dataset.status).toBe("stopped");
  });
});
