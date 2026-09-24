/**
 * Critically damped springs, stepped with the exact closed-form solution so
 * they are stable and frame-rate independent for any dt:
 *   x(t) = (x0 + (v0 + ω·x0)·t)·e^(−ωt),  x = value − target
 * With ω = 20 rad/s a move from rest is within 2% of its target after 300 ms.
 */
export const SPRING_OMEGA = 20;
const EPS = 0.01;

export interface Spring {
  value: number;
  velocity: number;
  target: number;
}

export function makeSpring(value: number, target: number = value): Spring {
  return { value, velocity: 0, target };
}

export function retarget(s: Spring, target: number): void {
  s.target = target;
}

export function isSettled(s: Spring, eps: number = EPS): boolean {
  return Math.abs(s.value - s.target) < eps && Math.abs(s.velocity) < eps * 10;
}

export function stepSpring(s: Spring, dtSec: number, omega: number = SPRING_OMEGA): void {
  if (s.value === s.target && s.velocity === 0) return;
  const x = s.value - s.target;
  const e = Math.exp(-omega * dtSec);
  const c = s.velocity + omega * x;
  s.value = s.target + (x + c * dtSec) * e;
  s.velocity = (s.velocity - omega * c * dtSec) * e;
  if (isSettled(s)) {
    s.value = s.target;
    s.velocity = 0;
  }
}
