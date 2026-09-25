// THE BROWSE MENU: the top bar's one route between the five catalogue hubs (DX-24).
//
// On every public page the chrome wraps, front door included, one "Browse the archive" control
// opens Tracks, Artists, Albums, Labels and Fresh. From 40rem up it is a keyboard-operable menu that
// marks the current hub and hands focus back to its trigger on Escape; on a phone it is a sheet whose
// rows are thumb-sized and which closes itself once a row is taken.

import { expect, test, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";

const HUBS = ["Tracks", "Artists", "Albums", "Labels", "Fresh"] as const;

async function hydrate(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
}

test.describe("browse menu — desktop", () => {
  test.use({ viewport: { height: 900, width: 1440 } });

  for (const path of ["/", "/log", "/labels"]) {
    test(`${path}: one Browse control opens the five hubs`, async ({ page }) => {
      await blockExternalRequests(page);
      await hydrate(page, path);

      const trigger = page.getByRole("button", { name: "Browse the archive" });

      await expect(trigger).toHaveCount(1);
      await trigger.click();

      const items = page.getByRole("menuitem");

      await expect(items).toHaveCount(HUBS.length);
      for (const [index, hub] of HUBS.entries()) {
        await expect(items.nth(index)).toContainText(hub);
      }
    });
  }

  test("the current hub is marked, and Escape hands focus back", async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/labels");

    const trigger = page.getByRole("button", { name: "Browse the archive" });

    await trigger.click();

    const current = page.locator('[role="menuitem"][aria-current="page"]');

    await expect(current).toHaveText(/^Labels/);

    // The current hub's resting tint must give way to the highlight when the keyboard reaches it.
    const resting = await current.evaluate((row) => getComputedStyle(row).backgroundColor);

    await current.focus();
    await expect(current).toHaveAttribute("data-highlighted", "");
    expect(await current.evaluate((row) => getComputedStyle(row).backgroundColor)).not.toBe(
      resting,
    );

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the keyboard reaches a hub: Enter opens, arrows move, Enter goes", async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/fresh");

    await page.getByRole("button", { name: "Browse the archive" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/artists$/);
    await expect(page.getByRole("heading", { level: 1, name: "Artists" })).toBeVisible();
  });
});

test.describe("browse menu — phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } });

  test("a sheet with thumb-sized rows that closes once a row is taken", async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/labels");

    const trigger = page.getByRole("button", { name: "Browse the archive" });

    await expect(trigger).toHaveCount(1);

    const box = await trigger.boundingBox();

    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    await trigger.tap();

    const sheet = page.getByRole("dialog", { name: "Browse" });
    const rows = sheet.getByRole("navigation", { name: "Browse the archive" }).getByRole("link");

    await expect(rows).toHaveCount(HUBS.length);
    await expect(sheet.locator('[aria-current="page"]')).toHaveText(/^Labels/);

    for (const row of await rows.all()) {
      expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await rows.filter({ hasText: "Artists" }).tap();

    await expect(page).toHaveURL(/\/artists$/);
    await expect(sheet).toHaveCount(0);
  });
});
