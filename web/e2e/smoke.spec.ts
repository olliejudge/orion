import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "__screenshots__");

function env(name: "ORION_URL" | "ORION_DEMO_DIR"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: e2e/global-setup.ts did not run`);
  return v;
}

/** Absolute paths of the demo's linked worktrees (the main worktree excluded). */
function linkedWorktrees(): string[] {
  const out = execFileSync("git", ["-C", env("ORION_DEMO_DIR"), "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .slice(1);
}

async function openOrion(page: Page): Promise<void> {
  await page.goto(env("ORION_URL"));
  await expect(page.getByTestId("map").locator("canvas")).toBeVisible();
  // The legend fills in once the first snapshot has arrived over the WebSocket.
  await expect(page.getByTestId("legend").getByTestId("worktree-pill").first()).toBeVisible();
}

/**
 * Fraction of the map's pixels whose brightest channel is above `threshold`,
 * counted only inside the disc the repo is fitted into (centred, diameter =
 * the map's short side), so the empty margins either side don't dilute it.
 * The chrome panels are masked black so only the canvas counts. The PNG is
 * decoded in the page (createImageBitmap) so no image library is needed.
 */
async function litFraction(page: Page, threshold: number): Promise<number> {
  const png = await page.getByTestId("map").screenshot({
    mask: [page.getByTestId("legend"), page.getByTestId("activity"), page.getByTestId("live-pill")],
    maskColor: "#000000",
    animations: "disabled",
  });
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

async function theme(page: Page): Promise<string | null> {
  return page.locator("html").getAttribute("data-theme");
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
});

test("the map canvas draws the repo", async ({ page }) => {
  await openOrion(page);
  // Night: pure black background, idle files #3a3a44, so anything > 40 is drawn content.
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("night");
  await expect.poll(() => litFraction(page, 40), { timeout: 10_000 }).toBeGreaterThan(0.01);
  // Vision: the background stays at or below 100 per channel; file bubbles are brighter.
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("vision");
  await expect.poll(() => litFraction(page, 120), { timeout: 10_000 }).toBeGreaterThan(0.005);
});

test("the legend shows at least two worktrees", async ({ page }) => {
  await openOrion(page);
  const pills = page.getByTestId("legend").getByTestId("worktree-pill");
  await expect.poll(() => pills.count()).toBeGreaterThanOrEqual(2);
});

test("a new file in a nested agent worktree appears in the activity stream within 5s", async ({ page }) => {
  await openOrion(page);
  const nested = linkedWorktrees().find((p) => p.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`));
  expect(nested, "the demo creates a nested worktree").toBeDefined();
  const name = `e2e-probe-${Date.now()}.md`;
  writeFileSync(path.join(nested as string, name), "# probe\n");
  await expect(page.getByTestId("activity").getByText(name).first()).toBeVisible({ timeout: 5_000 });
});

test("N toggles Night and Vision, remembers the choice, and screenshots both", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await openOrion(page);
  expect(await theme(page)).toBe("vision");
  await page.waitForTimeout(1_500); // let the layout springs settle before the screenshot
  await page.screenshot({ path: path.join(SHOTS, "vision.png") });

  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("night");
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: path.join(SHOTS, "night.png") });

  await page.reload();
  await expect.poll(() => theme(page)).toBe("night");
  await page.keyboard.press("n");
  await expect.poll(() => theme(page)).toBe("vision");
});
