/** Decimal byte sizes, as macOS Finder shows them. */
export function humanSize(bytes: number): string {
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Compact age: now, 42s, 5m, 3h, 2d. */
export function relativeTime(ts: number, now: number): string {
  const s = Math.floor((now - ts) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Spoken age for tooltips: just now, 4 min ago, 3 hours ago, 5 days ago, 2 weeks ago, 3 months ago, 2 years ago. */
export function timeAgo(ts: number, now: number): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const unit = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`} ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return unit(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 14) return unit(days, "day");
  if (days < 45) return unit(Math.round(days / 7), "week");
  if (days < 320) return unit(Math.round(days / 30.44), "month");
  return unit(Math.max(1, Math.round(days / 365.25)), "year");
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}
