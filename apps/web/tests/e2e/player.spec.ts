// THE PLAYER BAR — the persistent preview player of the public chrome (DESIGN.md §5).
//
// The contract, at both widths: hidden until the first play; once a preview starts it docks and
// SURVIVES client navigation (the sound never runs away from its control); it pauses and resumes
// from the bar on another page, from the keyboard, and closes on request. A preview never plays
// without a visible control that can stop it.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
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

      // Hidden until the first play.
      await expect(player).toHaveCount(0);

      await page.getByRole("button", { name: "Play the preview" }).click();
      await expect(player).toBeVisible();
      await expect(player).toContainText(SEEDED_LEAD.title);
      await expect(player.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();
      await expect.poll(() => mediaSessionState(page)).toBe("playing");

      // Client navigation to another page: the bar and the sound come along.
      await page.getByRole("banner").getByRole("link", { name: "Fluncle home" }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(player).toBeVisible();
      await expect(player).toContainText(SEEDED_LEAD.title);

      // Pause from the bar on the new page, then resume.
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

      // K toggles from anywhere outside a field.
      await page.locator("body").click({ position: { x: 5, y: 300 } });
      await page.keyboard.press("k");
      await expect(player.getByRole("button", { exact: true, name: "Play" })).toBeVisible();
      await page.keyboard.press("k");
      await expect(player.getByRole("button", { exact: true, name: "Pause" })).toBeVisible();

      await player.getByRole("button", { name: "Close the player" }).click();
      await expect(player).toHaveCount(0);
      await expect.poll(() => mediaSessionState(page)).not.toBe("playing");
    });
  });
}
