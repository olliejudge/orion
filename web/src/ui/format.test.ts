import { describe, expect, it } from "vitest";
import { humanSize, relativeTime, splitPath, timeAgo } from "./format";

describe("humanSize", () => {
  it("uses decimal units like Finder", () => {
    expect(humanSize(0)).toBe("0 bytes");
    expect(humanSize(1)).toBe("1 byte");
    expect(humanSize(999)).toBe("999 bytes");
    expect(humanSize(1234)).toBe("1.2 KB");
    expect(humanSize(56_700)).toBe("57 KB");
    expect(humanSize(3_400_000)).toBe("3.4 MB");
    expect(humanSize(2_000_000_000)).toBe("2.0 GB");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000;
  it("rounds to the largest sensible unit", () => {
    expect(relativeTime(now - 3_000, now)).toBe("now");
    expect(relativeTime(now - 42_000, now)).toBe("42s");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
  });
  it("treats future timestamps (clock skew) as now", () => {
    expect(relativeTime(now + 5_000, now)).toBe("now");
  });
});

describe("timeAgo", () => {
  const now = Date.UTC(2026, 8, 25);
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  it("reads naturally from just now to years", () => {
    expect(timeAgo(now - 20_000, now)).toBe("just now");
    expect(timeAgo(now + 60_000, now)).toBe("just now"); // clock skew
    expect(timeAgo(now - MIN, now)).toBe("1 min ago");
    expect(timeAgo(now - 4 * MIN, now)).toBe("4 min ago");
    expect(timeAgo(now - 60 * MIN, now)).toBe("1 hour ago");
    expect(timeAgo(now - 5 * 60 * MIN, now)).toBe("5 hours ago");
    expect(timeAgo(now - DAY, now)).toBe("1 day ago");
    expect(timeAgo(now - 13 * DAY, now)).toBe("13 days ago");
    expect(timeAgo(now - 14 * DAY, now)).toBe("2 weeks ago");
    expect(timeAgo(now - 44 * DAY, now)).toBe("6 weeks ago");
    expect(timeAgo(now - 45 * DAY, now)).toBe("1 month ago");
    expect(timeAgo(now - 92 * DAY, now)).toBe("3 months ago");
    expect(timeAgo(now - 320 * DAY, now)).toBe("1 year ago");
    expect(timeAgo(now - 800 * DAY, now)).toBe("2 years ago");
  });
});

describe("splitPath", () => {
  it("separates the folder (with trailing slash) from the name", () => {
    expect(splitPath("src/lib/a.ts")).toEqual({ dir: "src/lib/", name: "a.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});
