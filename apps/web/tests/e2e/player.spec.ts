import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests, installDiscoveryEventProbe } from "./browser";
import { mediaSessionState, routePreviews } from "./player";
import { SEEDED_LEAD } from "./seed";

const VIEWPORTS = [
  { height: 900, name: "desktop 1440x900", width: 1440 },
  { height: 844, name: "mobile 390x844", width: 390 },
] as const;

function watchForErrors(page: Page): string[] {
  const problems: string[] = [];

  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      problems.push(`console.error: ${message.text()}`);
    }
  });

  return problems;
}

async function hydrate(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
}

async function recordedOutbound(page: Page): Promise<(string | undefined)[]> {
  return page.evaluate(() => {
    const held =
      (
        window as Window & {
          __discoveryEvents?: { event: string; metadata?: Record<string, string> }[];
        }
      ).__discoveryEvents ?? [];

    return held
      .filter((entry) => entry.event === "discovery_outbound")
      .map((entry) => entry.metadata?.service);
  });
}

async function barFits(page: Page): Promise<boolean> {
  return page
    .locator(".player-bar-inner")
    .evaluate((inner) => inner.scrollWidth <= inner.clientWidth);
}

for (const viewport of VIEWPORTS) {
  test.describe(`player bar — ${viewport.name}`, () => {
    test.use({ viewport: { height: viewport.height, width: viewport.width } });

    test("a preview docks the bar, follows navigation, and pauses from another page", async ({
      page,
    }) => {
      await blockExternalRequests(page);
      await routePreviews(page, { seconds: 30 });

      const problems = watchForErrors(page);

      await hydrate(page, `/log/${SEEDED_LEAD.logId}`);

      const player = page.getByRole("region", { name: "Player" });

      await expect(player).toHaveCount(0);

      await page.getByRole("button", { name: "Play the preview" }).click();
      await expect(player).toBeVisible();
      await expect(player).toContainText(SEEDED_LEAD.title);
      await expect(player.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();
      await expect.poll(() => mediaSessionState(page)).toBe("playing");

      await page.getByRole("banner").getByRole("link", { name: "Fluncle home" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(player).toBeVisible();
      await expect(player).toContainText(SEEDED_LEAD.title);

      await player.getByRole("button", { exact: true, name: "Pause" }).click();
      await expect(player.getByRole("button", { exact: true, name: "Play" })).toBeVisible();
      await expect.poll(() => mediaSessionState(page)).toBe("paused");
      await player.getByRole("button", { exact: true, name: "Play" }).click();
      await expect(player.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();

      expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
    });

    test("the keyboard plays and pauses, and close dismisses the bar", async ({ page }) => {
      await blockExternalRequests(page);
      await routePreviews(page, { seconds: 30 });
      await hydrate(page, `/log/${SEEDED_LEAD.logId}`);

      await page.getByRole("button", { name: "Play the preview" }).click();

      const player = page.getByRole("region", { name: "Player" });

      await expect(player.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();

      await page.locator("body").click({ position: { x: 5, y: 300 } });
      await page.keyboard.press("k");
      await expect(player.getByRole("button", { exact: true, name: "Play" })).toBeVisible();
      await page.keyboard.press("k");
      await expect(player.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();

      const position = await player.locator(".player-position").first().textContent();

      for (const chord of ["Shift+K", "Shift+L", "Shift+J", "Shift+Space"]) {
        await page.keyboard.press(chord);
      }

      await expect(player.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();
      await expect(player.locator(".player-position").first()).toHaveText(position ?? "");

      await player.getByRole("button", { name: "Close the player" }).click();
      await expect(player).toHaveCount(0);
      await expect.poll(() => mediaSessionState(page)).not.toBe("playing");
    });

    test("a resting preview offers the full song, counted as an outbound listen", async ({
      page,
    }) => {
      await blockExternalRequests(page);
      await installDiscoveryEventProbe(page);
      await routePreviews(page, { seconds: 30 });

      const problems = watchForErrors(page);

      await hydrate(page, `/log/${SEEDED_LEAD.logId}`);
      await page.getByRole("button", { name: "Play the preview" }).click();

      const player = page.getByRole("region", { name: "Player" });
      const listenOut = player.getByRole("link", { name: "Listen on Spotify" });

      await expect(player.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();
      await expect(listenOut).toHaveCount(0);

      await player.getByRole("button", { exact: true, name: "Pause" }).click();
      await expect(listenOut).toBeVisible();
      await expect(listenOut).toHaveAttribute("href", /open\.spotify\.com/);
      await expect(listenOut).toHaveAttribute("target", "_blank");
      expect(await barFits(page)).toBe(true);

      const popupPromise = page.waitForEvent("popup").catch(() => undefined);

      await listenOut.click();
      await (await popupPromise)?.close().catch(() => undefined);
      await expect.poll(() => recordedOutbound(page)).toEqual(["spotify"]);

      await player.getByRole("button", { exact: true, name: "Play" }).click();
      await expect(player.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();
      await expect(listenOut).toHaveCount(0);

      expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
    });

    test("an ended preview offers the full song beside Keep going", async ({ page }) => {
      await blockExternalRequests(page);
      await routePreviews(page, { seconds: 1 });
      await hydrate(page, `/log/${SEEDED_LEAD.logId}`);
      await page.getByRole("button", { name: "Play the preview" }).click();

      const player = page.getByRole("region", { name: "Player" });

      await expect(player.getByRole("button", { name: "Keep going" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(player.getByRole("link", { name: "Listen on Spotify" })).toBeVisible();
      await expect(player.getByRole("button", { name: "Close the player" })).toBeInViewport({
        ratio: 1,
      });
      expect(await barFits(page)).toBe(true);
    });
  });
}
