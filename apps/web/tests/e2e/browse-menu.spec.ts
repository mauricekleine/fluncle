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
    const popupRequests: string[] = [];

    page.on("request", (request) => {
      if (request.url().includes("/components/nav/browse-popup.tsx")) {
        popupRequests.push(request.url());
      }
    });

    await blockExternalRequests(page);
    await hydrate(page, "/fresh");

    expect(popupRequests).toHaveLength(0);
    await page.getByRole("button", { name: "Browse the archive" }).focus();
    await expect.poll(() => popupRequests.length).toBe(1);
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

test.describe("browse menu — search takes over", () => {
  for (const [name, viewport, mobile] of [
    ["desktop", { height: 900, width: 1440 }, false],
    ["phone", { height: 844, width: 390 }, true],
  ] as const) {
    test(`${name}: Ctrl+K closes Browse, opens one search dialog, and Escape lands on Browse`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ hasTouch: mobile, isMobile: mobile, viewport });
      const page = await context.newPage();

      await blockExternalRequests(page);
      await hydrate(page, "/labels");

      const trigger = page.getByRole("button", { name: "Browse the archive" });

      await trigger.click();
      if (mobile) {
        await expect(page.getByRole("dialog", { name: "Browse" })).toBeVisible();
      } else {
        await expect(page.getByRole("menuitem").first()).toBeVisible();
      }

      await page.keyboard.press("Control+k");

      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(page.getByRole("dialog", { name: "Browse" })).toHaveCount(0);
      await expect(page.getByRole("menuitem")).toHaveCount(0);
      const search = page.getByRole("dialog", { name: "Search the archive" });

      await expect(search).toBeVisible();
      await expect
        .poll(() => search.evaluate((dialog) => dialog.contains(document.activeElement)))
        .toBe(true);

      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await context.close();
    });
  }
});

test.describe("browse menu — a short viewport", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 360, width: 740 } });

  test("the sheet fits the screen and scrolls to its last row", async ({ page }) => {
    await blockExternalRequests(page);
    await page.setViewportSize({ height: 360, width: 600 });
    await hydrate(page, "/labels");

    await page.getByRole("button", { name: "Browse the archive" }).tap();

    const sheet = page.getByRole("dialog", { name: "Browse" });

    await expect
      .poll(async () => {
        const box = await sheet.boundingBox();

        return box !== null && box.y >= 0 && box.y + box.height <= 360;
      })
      .toBe(true);
    await expect(sheet.getByRole("button", { name: "Close" })).toBeInViewport();

    const last = sheet.getByRole("link", { name: /Fresh/ });

    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
  });
});
