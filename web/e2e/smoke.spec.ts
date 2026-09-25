import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startOrion } from "./orion";

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "__screenshots__");

function env(name: "ORION_URL" | "ORION_DEMO_DIR"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: e2e/global-setup.ts did not run`);
  return v;
}

interface Worktree {
  path: string;
  branch: string; // "main", "agent/ui", ...
}

/** Every worktree of the demo repo, the main worktree first. */
function worktrees(demoDir: string): Worktree[] {
  const out = execFileSync("git", ["-C", demoDir, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  return out
    .trim()
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const field = (key: string) =>
        lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1) ?? "";
      return { path: field("worktree"), branch: field("branch").replace(/^refs\/heads\//, "") };
    });
}

/** The worktree whose branch starts with `prefix` (e.g. "agent/api" also matches "agent/api-2"). */
function worktreeOn(demoDir: string, prefix: string): Worktree {
  const wt = worktrees(demoDir).find((w) => w.branch.startsWith(prefix));
  if (!wt) throw new Error(`the demo has no worktree on a branch starting with ${prefix}`);
  return wt;
}

/** First tracked file (in sorted order) under `dir` that `keep` accepts, as a path relative to the worktree. */
function trackedFile(wt: Worktree, dir: string, keep: (file: string) => boolean): string {
  const files = execFileSync("git", ["-C", wt.path, "ls-files", "-z", "--", dir], { encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && keep(f))
    .sort();
  if (files.length === 0) throw new Error(`no matching tracked file under ${dir} in ${wt.branch}`);
  return files[0];
}

async function openOrion(page: Page, url = env("ORION_URL")): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId("map").locator("canvas")).toBeVisible();
  // The legend fills in once the first snapshot has arrived over the WebSocket.
  await expect(page.getByTestId("legend").getByTestId("worktree-pill").first()).toBeVisible();
}

/**
 * Fraction of the map's pixels whose brightest channel is above `threshold`,
 * counted only inside the disc the repo is fitted into (centred, diameter =
 * the map's short side), so the empty margins either side don't dilute it.
 * The chrome panels are masked black so only the canvas counts. The PNG is
 * taken at CSS scale (the fraction doesn't depend on it) and decoded in the
 * page (createImageBitmap) so no image library is needed.
 */
async function litFraction(page: Page, threshold: number): Promise<number> {
  const png = await page.getByTestId("map").screenshot({ mask: MAP_MASK(page), maskColor: "#000000", animations: "disabled", scale: "css" });
  return page.evaluate(
    async ({ b64, threshold }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(bmp, 0, 0);
      const { width, height } = bmp;
      const { data } = ctx.getImageData(0, 0, width, height);
      const r = Math.min(width, height) / 2;
      let inside = 0;
      let lit = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if ((x + 0.5 - width / 2) ** 2 + (y + 0.5 - height / 2) ** 2 > r * r) continue;
          inside++;
          const i = (y * width + x) * 4;
          if (Math.max(data[i], data[i + 1], data[i + 2]) > threshold) lit++;
        }
      }
      return lit / inside;
    },
    { b64: png.toString("base64"), threshold },
  );
}

const MAP_MASK = (page: Page) => [
  page.getByTestId("legend"),
  page.getByTestId("activity"),
  page.getByTestId("live-pill"),
  page.getByTestId("map-key"),
  page.getByTestId("dir-filter"),
];

/** Polls litFraction until it beats `min`, and records the last measurement on the test. */
async function expectLit(page: Page, label: string, threshold: number, min: number): Promise<void> {
  let measured = 0;
  await expect
    .poll(async () => (measured = await litFraction(page, threshold)), { timeout: 20_000 })
    .toBeGreaterThan(min);
  test.info().annotations.push({
    type: "lit-fraction",
    description: `${label}: ${(measured * 100).toFixed(2)}% of the map disc brighter than ${threshold} (min ${min * 100}%)`,
  });
}

async function theme(page: Page): Promise<string | null> {
  return page.locator("html").getAttribute("data-theme");
}

/** The path the breadcrumbs currently focus, e.g. via `title` on the last crumb ("" at the root). */
async function focusedPath(page: Page): Promise<string> {
  const title = await page.getByTestId("breadcrumbs").locator("button[aria-current='location']").getAttribute("title");
  return title === "Whole repository" ? "" : (title ?? "");
}

/** Whether `path` is `dir` or a descendant of it ("" is an ancestor of everything but itself). */
function isDeeper(dir: string, path: string): boolean {
  return dir === "" ? path !== "" : path.startsWith(`${dir}/`);
}

/**
 * Clicks into a folder one level deeper than the current focus: the packed
 * circles leave only thin gaps, so a small spiral of points around the map's
 * centre almost always lands inside one. A miss either leaves the focus
 * unchanged, or (clicking the background of the folder already in view)
 * steps back out a level, so this keeps trying until the focus is properly
 * deeper than where it started.
 */
async function clickIntoFolder(page: Page): Promise<void> {
  const box = await page.getByTestId("map").locator("canvas").boundingBox();
  if (!box) throw new Error("the map canvas has no layout box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const before = await focusedPath(page);
  const offsets = [
    [0, 0],
    [30, 0],
    [-30, 0],
    [0, 30],
    [0, -30],
    [60, 0],
    [-60, 0],
    [0, 60],
    [0, -60],
    [45, 45],
    [-45, 45],
    [45, -45],
    [-45, -45],
  ];
  for (const [dx, dy] of offsets) {
    await page.mouse.click(cx + dx, cy + dy);
    const after = await focusedPath(page);
    if (isDeeper(before, after)) return;
    // A miss zoomed out instead of in (or did nothing): back to `before` before the next try.
    if (after !== before) {
      await page.goBack();
      await expect.poll(() => focusedPath(page)).toBe(before);
    }
  }
  throw new Error("no click around the map's centre landed inside a folder");
}

test("loads via the tokenised URL and shows the chrome", async ({ page, request }) => {
  const bare = new URL(env("ORION_URL"));
  bare.search = "";
  const denied = await request.get(bare.toString());
  expect(denied.ok(), "a request without the token must be refused").toBe(false);

  await openOrion(page);
  // orion swaps the token for a SameSite=Strict cookie and redirects to `/`;
  // the legend filling in (above) shows that cookie authenticated the page and its WebSocket.
  expect(new URL(page.url()).search, "the token is dropped from the address bar").toBe("");
  await expect(page.getByTestId("legend")).toBeVisible();
  await expect(page.getByTestId("activity")).toBeVisible();
  await expect(page.getByTestId("live-pill")).toContainText("Live");
  const key = page.getByRole("region", { name: "Map key" });
  await expect(key).toBeVisible();
  await expect(key.getByTestId("map-key-entry")).toHaveCount(7);
});

test("the map canvas draws the repo", async ({ page }) => {
  await openOrion(page);
  // Night: pure black background, idle files #3a3a44, so anything > 40 is drawn content.
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("night");
  await expectLit(page, "night", 40, 0.01);
  // Vision: the background stays at or below 100 per channel; file bubbles are brighter.
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("vision");
  await expectLit(page, "vision", 120, 0.005);
});

test("the legend shows at least two worktrees", async ({ page }) => {
  await openOrion(page);
  const pills = page.getByTestId("legend").getByTestId("worktree-pill");
  await expect.poll(() => pills.count()).toBeGreaterThanOrEqual(2);
});

test("a new file in a nested agent worktree appears in the activity stream within 5s", async ({ page }) => {
  await openOrion(page);
  const nested = worktrees(env("ORION_DEMO_DIR"))
    .slice(1)
    .find((w) => w.path.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`));
  expect(nested, "the demo creates a nested worktree").toBeDefined();
  const name = `e2e-probe-${Date.now()}.md`;
  writeFileSync(path.join((nested as Worktree).path, name), "# probe\n");
  await expect(page.getByTestId("activity").getByText(name).first()).toBeVisible({ timeout: 5_000 });
});

test("unticking a folder changes the map's bubbles; Show all restores them", async ({ page }) => {
  await openOrion(page);
  // A generous, low threshold: this only needs a consistent yardstick for
  // "how much of the disc is drawn", not a faithful lit-pixel count, and it
  // must survive both a lively Vision map and a near-black Night one.
  const threshold = 40;
  const baseline = await litFraction(page, threshold);

  const panel = page.getByTestId("dir-filter");
  await panel.getByRole("button", { name: /Folders/ }).click();
  // "web" is the demo's biggest top-level area (see scripts/demo/gen.go's
  // `areas`), so hiding it makes a large, reliably detectable change; which
  // way the fraction moves depends on how the rest re-packs, so the test
  // only checks that it moves.
  const checkbox = panel.getByLabel("web", { exact: true });
  await expect(checkbox).toBeChecked();
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
  await expect(panel.getByText(/^\d+ hidden$/)).toBeVisible();
  await page.waitForTimeout(1_500); // let the layout spring settle
  const hidden = await litFraction(page, threshold);
  expect(Math.abs(hidden - baseline), "hiding the map's biggest area should visibly change it").toBeGreaterThan(0.02);

  await panel.getByRole("button", { name: "Show all" }).click();
  await expect(checkbox).toBeChecked();
  await page.waitForTimeout(1_500);
  const restored = await litFraction(page, threshold);
  // Close to the original, allowing for the demo's own simulated activity
  // (new commits, edits) drifting file sizes a little in the meantime.
  expect(Math.abs(restored - baseline), "Show all should bring the map back close to how it looked before").toBeLessThan(0.02);
});

/** Axis-aligned overlap test for two Playwright bounding boxes. */
function boxesOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

test("the open folder filter never overlaps the legend, at a normal or a short viewport", async ({ page }) => {
  await openOrion(page);
  const panel = page.getByTestId("dir-filter");
  const legend = page.getByTestId("legend");

  for (const size of [{ width: 1440, height: 900 }, { width: 1440, height: 700 }]) {
    await page.setViewportSize(size);
    // Reopen at each size: a resize can change how much room the panel has,
    // and its own layout effect only recomputes while mounted and open.
    const toggle = panel.getByRole("button", { name: /Folders/ });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(300); // let the ResizeObserver-driven cap settle

    const legendBox = await legend.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(legendBox, "the legend should be measurable").not.toBeNull();
    expect(panelBox, "the open panel should be measurable").not.toBeNull();
    expect(boxesOverlap(legendBox!, panelBox!), `at ${size.width}x${size.height}: legend ${JSON.stringify(legendBox)} vs panel ${JSON.stringify(panelBox)}`).toBe(
      false,
    );
  }
});

test("hovering a folder names it, with its file count", async ({ page }) => {
  await openOrion(page);
  const box = await page.getByTestId("map").boundingBox();
  expect(box).not.toBeNull();
  const tip = page.getByTestId("tooltip");
  // Sweep the map until the pointer rests on a folder (files show a size instead).
  let found = false;
  for (let gy = 1; gy < 16 && !found; gy++) {
    for (let gx = 1; gx < 24 && !found; gx++) {
      await page.mouse.move(box!.x + (box!.width * gx) / 24, box!.y + (box!.height * gy) / 16);
      const text = (await tip.isVisible()) ? await tip.innerText({ timeout: 1_000 }).catch(() => "") : "";
      found = /\d+ files?$/m.test(text);
    }
  }
  expect(found, "some folder on the map shows a tooltip").toBe(true);
  await expect(tip.locator(".name")).toHaveText(/\/$/);
});

test("N toggles Night and Vision and remembers the choice", async ({ page }) => {
  await openOrion(page);
  expect(await theme(page)).toBe("vision");
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("night");
  await page.reload();
  await expect.poll(() => theme(page)).toBe("night");
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("vision");
});

test("+ zooms in a level, 0 returns home, and the breadcrumbs (and the home button) reflect it", async ({ page }) => {
  await openOrion(page);
  const crumbs = page.getByTestId("breadcrumbs");
  // The visible trail (not its hidden measuring copy): just the repo name at home.
  const trail = crumbs.locator("ol").first().getByRole("button");
  const home = crumbs.getByRole("button", { name: /Home/ });
  await expect(trail).toHaveCount(1);
  await expect(home).toHaveCount(0);
  // The legend fills in from the snapshot a frame before the map is laid out,
  // and + has nothing to step into until it is: wait for the map to draw.
  await expectLit(page, "before +", 120, 0.005);

  await page.keyboard.press("+");
  await expect(trail).not.toHaveCount(1);
  await expect(home).toBeVisible();

  await page.keyboard.press("0");
  await expect(trail).toHaveCount(1);
  await expect(home).toHaveCount(0);
});

test("keeps the focused folder in the URL hash, with Back and reload restoring it", async ({ page }) => {
  await openOrion(page);
  expect(new URL(page.url()).hash, "no location yet at the root").toBe("");

  // + (with the pointer off the map) steps into the largest child, so this
  // is deterministic without guessing screen coordinates.
  await page.keyboard.press("+");
  const path1 = await focusedPath(page);
  expect(path1, "+ steps into a folder").not.toBe("");
  const hash1 = new URL(page.url()).hash;
  expect(decodeURIComponent(hash1), "the hash names the focused folder").toBe(`#/${path1}`);

  await page.keyboard.press("+");
  const path2 = await focusedPath(page);
  expect(path2.startsWith(`${path1}/`), "a second + goes a level deeper").toBe(true);
  const hash2 = new URL(page.url()).hash;
  expect(hash2).not.toBe(hash1);

  // Back retraces the second step without leaving the app.
  await page.goBack();
  await expect.poll(() => focusedPath(page)).toBe(path1);
  expect(new URL(page.url()).hash).toBe(hash1);

  // Reload restores the location from the hash (rather than returning home).
  await page.reload();
  await expect(page.getByTestId("map").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("legend").getByTestId("worktree-pill").first()).toBeVisible();
  await expect.poll(() => focusedPath(page)).toBe(path1);
  expect(new URL(page.url()).hash).toBe(hash1);
});

test("a click into a folder updates the URL hash", async ({ page }) => {
  await openOrion(page);
  await clickIntoFolder(page);
  const path1 = await focusedPath(page);
  expect(path1, "the click landed on a folder").not.toBe("");
  expect(decodeURIComponent(new URL(page.url()).hash)).toBe(`#/${path1}`);
});

test("a deep link's hash survives the token redirect", async ({ page }) => {
  // orion's own URL carries `?t=<token>`; a location hash appended to it must
  // come through the token-for-cookie redirect (see internal/server/server.go)
  // and land the map on that folder, not the root.
  await page.goto(`${env("ORION_URL")}#/web`);
  await expect(page.getByTestId("map").locator("canvas")).toBeVisible();
  await expect(page.getByTestId("legend").getByTestId("worktree-pill").first()).toBeVisible();
  expect(new URL(page.url()).search, "the token is dropped from the address bar").toBe("");
  expect(new URL(page.url()).hash, "the hash survives the token redirect").toBe("#/web");
  await expect.poll(() => focusedPath(page)).toBe("web");
});

test("hiding the folder you're in backs the camera out and replaces the hash, without pushing a history entry", async ({ page }) => {
  await openOrion(page);
  await page.keyboard.press("+");
  const path1 = await focusedPath(page);
  expect(path1).not.toBe("");
  expect(new URL(page.url()).hash).toBe(`#/${path1}`);

  const panel = page.getByTestId("dir-filter");
  await panel.getByRole("button", { name: /Folders/ }).click();
  const checkbox = panel.getByLabel(path1, { exact: true });
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();

  // The camera backs out to the root (path1's nearest visible ancestor); the
  // hash follows by replacing the current entry, not pushing a new one.
  await expect.poll(() => focusedPath(page)).toBe("");
  await expect.poll(() => new URL(page.url()).hash).toBe("#/");

  // Nothing was pushed: one Back returns all the way to the pre-navigation
  // state (no location in the URL) instead of an intermediate "path1, not
  // yet hidden" entry that a push would have left behind.
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await expect.poll(() => focusedPath(page)).toBe("");
});

test("Back into a folder hidden since you navigated there lands on the visible ancestor, without revealing it", async ({ page }) => {
  await openOrion(page);
  await page.keyboard.press("+"); // path1: a top-level folder
  const path1 = await focusedPath(page);
  await page.keyboard.press("+"); // path2: one of path1's children
  const path2 = await focusedPath(page);
  expect(path2.startsWith(`${path1}/`)).toBe(true);

  // Back home before hiding path1, so hiding it doesn't touch the current
  // (home) history entry — only the older path2 entry is left stale.
  await page.keyboard.press("0");
  await expect.poll(() => focusedPath(page)).toBe("");

  const panel = page.getByTestId("dir-filter");
  await panel.getByRole("button", { name: /Folders/ }).click();
  const checkbox = panel.getByLabel(path1, { exact: true });
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
  await page.waitForTimeout(1_500); // let the layout repack without path1's subtree before Back relies on it

  // Back once retraces the second + step, landing on path2's now-stale
  // entry: it must resolve to the nearest folder the filter still shows
  // (the root, since path1's whole subtree is hidden), not reveal path1.
  await page.goBack();
  await expect.poll(() => focusedPath(page)).toBe("");
  await expect.poll(() => new URL(page.url()).hash).toBe("#/");
  await expect(checkbox, "the filter itself is unchanged").not.toBeChecked();
});

// The Vision shot becomes the README image, so it runs on its own fresh demo
// repo and orion (nothing another test did can show up in it) and makes a few
// realistic agent edits so the activity stream has something to show.
test("screenshots both themes of a fresh demo with live agent edits", async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const orion = await startOrion();
  try {
    await openOrion(page, orion.url);
    expect(await theme(page)).toBe("vision");

    const ui = worktreeOn(orion.demoDir, "agent/ui");
    const api = worktreeOn(orion.demoDir, "agent/api");
    const guides = worktreeOn(orion.demoDir, "agent/guides");
    const edits: Array<{ wt: Worktree; file: string; text: string }> = [
      {
        wt: guides,
        file: trackedFile(guides, "docs/guides", (f) => f.endsWith(".md")),
        text: "\n## Troubleshooting\n\nIf the sky map stays empty, check that the catalog finished importing.\n",
      },
      {
        wt: api,
        file: trackedFile(api, "internal/api", (f) => f.endsWith(".go") && !f.endsWith("_test.go")),
        text: "\n// OrbitWindow returns the orbit window for n.\nfunc OrbitWindow(n int) int {\n\treturn n * 12\n}\n",
      },
      {
        wt: ui,
        file: trackedFile(ui, "web/src/components", (f) => f.endsWith(".tsx")),
        text: '\nexport function StarfieldLegend() {\n  return <div className="starfield-legend" />;\n}\n',
      },
    ];
    // One at a time, each waiting for its row, so the stream's order is deterministic.
    for (const e of edits) {
      appendFileSync(path.join(e.wt.path, e.file), e.text);
      await expect(page.getByTestId("activity").getByText(path.basename(e.file)).first()).toBeVisible({
        timeout: 5_000,
      });
    }
    await page.waitForTimeout(2_000); // let the halos and layout springs settle
    await page.screenshot({ path: path.join(SHOTS, "vision.png") });

    await page.keyboard.press("n");
    await expect.poll(() => theme(page)).toBe("night");
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: path.join(SHOTS, "night.png") });
  } finally {
    await orion.stop();
  }
});
