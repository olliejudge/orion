import { describe, expect, it } from "vitest";
import { keyAction } from "./keys";

const ev = (key: string, over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, target: document.body, ...over }) as KeyboardEvent;

describe("keyAction", () => {
  it("maps N, F and Esc (either case)", () => {
    expect(keyAction(ev("n"))).toBe("theme");
    expect(keyAction(ev("N"))).toBe("theme");
    expect(keyAction(ev("f"))).toBe("fullscreen");
    expect(keyAction(ev("Escape"))).toBe("zoomOut");
    expect(keyAction(ev("x"))).toBeNull();
  });

  it("maps Backspace to zooming out one level, like Esc", () => {
    expect(keyAction(ev("Backspace"))).toBe("zoomOut");
  });

  it("ignores shortcuts with modifiers (Cmd-N, Ctrl-F…)", () => {
    expect(keyAction(ev("n", { metaKey: true }))).toBeNull();
    expect(keyAction(ev("f", { ctrlKey: true }))).toBeNull();
    expect(keyAction(ev("n", { altKey: true }))).toBeNull();
  });

  it("ignores auto-repeat from a held key", () => {
    expect(keyAction(ev("n", { repeat: true }))).toBeNull();
  });

  it("ignores typing in form fields", () => {
    const input = document.createElement("input");
    expect(keyAction(ev("n", { target: input }))).toBeNull();
  });
});
