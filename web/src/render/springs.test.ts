import { describe, expect, it } from "vitest";
import { SPRING_OMEGA, isSettled, makeSpring, retarget, stepSpring } from "./springs";

function run(s: ReturnType<typeof makeSpring>, ms: number, frameMs = 1000 / 60): number[] {
  const trace: number[] = [];
  for (let t = 0; t < ms; t += frameMs) {
    stepSpring(s, frameMs / 1000);
    trace.push(s.value);
  }
  return trace;
}

describe("springs", () => {
  it("settles within ~300ms from rest (critically damped)", () => {
    const s = makeSpring(0, 100);
    run(s, 300);
    expect(Math.abs(100 - s.value)).toBeLessThan(2);
    run(s, 400);
    expect(isSettled(s)).toBe(true);
    expect(s.value).toBe(100);
    expect(s.velocity).toBe(0);
  });

  it("never overshoots when starting from rest", () => {
    const s = makeSpring(0, 100);
    const trace = run(s, 1000);
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]!).toBeGreaterThanOrEqual(trace[i - 1]!);
      expect(trace[i]!).toBeLessThanOrEqual(100);
    }
  });

  it("is frame-rate independent (exact solution per step)", () => {
    const a = makeSpring(0, 50);
    const b = makeSpring(0, 50);
    stepSpring(a, 0.12);
    for (let i = 0; i < 12; i++) stepSpring(b, 0.01);
    expect(a.value).toBeCloseTo(b.value, 9);
    expect(a.velocity).toBeCloseTo(b.velocity, 9);
  });

  it("keeps velocity when retargeted mid-flight", () => {
    const s = makeSpring(0, 100);
    stepSpring(s, 0.05);
    const v = s.velocity;
    retarget(s, -100);
    expect(s.velocity).toBe(v);
    expect(s.target).toBe(-100);
    expect(isSettled(s)).toBe(false);
  });

  it("stays put when already at target", () => {
    const s = makeSpring(7);
    stepSpring(s, 1);
    expect(s.value).toBe(7);
    expect(isSettled(s)).toBe(true);
  });

  it("exposes the tuning constant", () => {
    expect(SPRING_OMEGA).toBe(20);
  });
});
