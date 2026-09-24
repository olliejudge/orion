import { describe, expect, it } from "vitest";
import { Linger } from "./linger";

describe("Linger", () => {
  it("keeps paths until their time is up, then reports that the set changed", () => {
    const l = new Linger(600);
    expect(l.paths()).toBeUndefined();
    l.add(["a.ts", "b.ts"], 1000);
    l.add(["c.ts"], 1300);
    expect([...l.paths()!]).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(l.nextExpiry()).toBe(1600);
    expect(l.expire(1599)).toBe(false);
    expect(l.expire(1600)).toBe(true);
    expect([...l.paths()!]).toEqual(["c.ts"]);
    expect(l.nextExpiry()).toBe(1900);
    expect(l.expire(2000)).toBe(true);
    expect(l.paths()).toBeUndefined();
    expect(l.nextExpiry()).toBeNull();
  });

  it("extends a path merged again before it left", () => {
    const l = new Linger(600);
    l.add(["a.ts"], 0);
    l.add(["a.ts"], 500);
    expect(l.expire(700)).toBe(false);
    expect(l.expire(1100)).toBe(true);
  });
});
