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

  it("maps -, + (and =, the unshifted key) to stepping out/in a level", () => {
    expect(keyAction(ev("-"))).toBe("zoomOut");
    expect(keyAction(ev("_"))).toBe("zoomOut");
    expect(keyAction(ev("+"))).toBe("zoomIn");
    expect(keyAction(ev("="))).toBe("zoomIn");
  });

  it("maps 0 and Home to going home", () => {
    expect(keyAction(ev("0"))).toBe("home");
    expect(keyAction(ev("Home"))).toBe("home");
  });

  it("leaves / unbound for search", () => {
    expect(keyAction(ev("/"))).toBeNull();
  });

  it("ignores shortcuts with modifiers (Cmd-N, Ctrl-F…)", () => {
    expect(keyAction(ev("n", { metaKey: true }))).toBeNull();
    expect(keyAction(ev("f", { ctrlKey: true }))).toBeNull();
    expect(keyAction(ev("n", { altKey: true }))).toBeNull();
    expect(keyAction(ev("+", { metaKey: true }))).toBeNull();
    expect(keyAction(ev("0", { ctrlKey: true }))).toBeNull();
  });

  it("ignores auto-repeat from a held key", () => {
    expect(keyAction(ev("n", { repeat: true }))).toBeNull();
    expect(keyAction(ev("+", { repeat: true }))).toBeNull();
  });

  it("ignores typing in form fields", () => {
    const input = document.createElement("input");
    expect(keyAction(ev("n", { target: input }))).toBeNull();
  });

  it("maps Alt+Left/Right to retracing the navigation history", () => {
    expect(keyAction(ev("ArrowLeft", { altKey: true }))).toBe("back");
    expect(keyAction(ev("ArrowRight", { altKey: true }))).toBe("forward");
  });

  it("ignores Alt+Left/Right combined with another modifier or held down", () => {
    expect(keyAction(ev("ArrowLeft", { altKey: true, metaKey: true }))).toBeNull();
    expect(keyAction(ev("ArrowLeft", { altKey: true, ctrlKey: true }))).toBeNull();
    expect(keyAction(ev("ArrowLeft", { altKey: true, repeat: true }))).toBeNull();
  });

  it("ignores plain arrow keys (no Alt)", () => {
    expect(keyAction(ev("ArrowLeft"))).toBeNull();
    expect(keyAction(ev("ArrowRight"))).toBeNull();
  });

  it("ignores Alt+Left/Right while typing in a form field", () => {
    const input = document.createElement("input");
    expect(keyAction(ev("ArrowLeft", { altKey: true, target: input }))).toBeNull();
  });
});
