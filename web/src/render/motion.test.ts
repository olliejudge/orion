import { afterEach, describe, expect, it, vi } from "vitest";
import { BREATH_MS, STATIC_FLASH_ALPHA, motionPolicy, watchReducedMotion } from "./motion";

describe("motionPolicy", () => {
  it("animates by default: springs move, the merge shimmer pulses and grows", () => {
    const m = motionPolicy(false);
    expect(m.snap).toBe(false);
    expect(m.shimmer(0)).toEqual({ alpha: 0, scale: 1 });
    expect(m.shimmer(0.5).alpha).toBeCloseTo(0.55);
    expect(m.shimmer(0.5).scale).toBeCloseTo(1.125);
  });

  it("with reduced motion: springs snap and the shimmer is a static, brief highlight", () => {
    const m = motionPolicy(true);
    expect(m.snap).toBe(true);
    for (const p of [0, 0.3, 0.99]) expect(m.shimmer(p)).toEqual({ alpha: STATIC_FLASH_ALPHA, scale: 1 });
  });
});

describe("live glow and ping", () => {
  it("a live glow breathes: dim and full size between breaths, full and swollen mid-breath", () => {
    const m = motionPolicy(false);
    expect(m.breathes).toBe(true);
    expect(m.breath(0).alpha).toBeCloseTo(0.55);
    expect(m.breath(0).scale).toBeCloseTo(1);
    expect(m.breath(BREATH_MS / 2).alpha).toBeCloseTo(1);
    expect(m.breath(BREATH_MS / 2).scale).toBeCloseTo(1.1);
    expect(m.breath(BREATH_MS).alpha).toBeCloseTo(m.breath(0).alpha);
  });

  it("a ping rings out from the bubble and fades to nothing", () => {
    const m = motionPolicy(false);
    expect(m.ping(0)).toEqual({ alpha: 0.8, scale: 1 });
    const mid = m.ping(0.5)!;
    expect(mid.alpha).toBeGreaterThan(0);
    expect(mid.scale).toBeGreaterThan(1.5);
    expect(m.ping(1)!.alpha).toBeCloseTo(0);
    expect(m.ping(1)!.scale).toBeCloseTo(2.6);
  });

  it("with reduced motion the glow holds still and there is no ping", () => {
    const m = motionPolicy(true);
    expect(m.breathes).toBe(false);
    for (const t of [0, 600, 1200]) expect(m.breath(t)).toEqual({ alpha: 1, scale: 1 });
    expect(m.ping(0.2)).toBeNull();
  });
});

describe("watchReducedMotion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports the current preference and later changes, until stopped", () => {
    let listener: ((e: { matches: boolean }) => void) | null = null;
    const mql = {
      matches: true,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => (listener = fn),
      removeEventListener: () => (listener = null),
    };
    vi.stubGlobal("matchMedia", (q: string) => (q === "(prefers-reduced-motion: reduce)" ? mql : null));
    const seen: boolean[] = [];
    const stop = watchReducedMotion((r) => seen.push(r));
    listener!({ matches: false });
    stop();
    expect(seen).toEqual([true, false]);
    expect(listener).toBeNull();
  });

  it("assumes full motion where matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const seen: boolean[] = [];
    watchReducedMotion((r) => seen.push(r))();
    expect(seen).toEqual([false]);
  });
});
