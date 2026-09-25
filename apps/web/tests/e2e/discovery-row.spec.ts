import { expect, test, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { routePreviews } from "./player";
import { SEEDED_LEAD } from "./seed";

async function clickWhereItSits(page: Page, selector: ReturnType<Page["locator"]>): Promise<void> {
  const box = await selector.boundingBox();

  expect(box, "the element should be on screen").not.toBeNull();
  await page.mouse.click(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2,
  );
}

async function hydrate(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
}

test("clicking a finding row's coordinate opens the finding", async ({ page }) => {
  await blockExternalRequests(page);
  await hydrate(page, "/tracks");

  const coordinate = page.locator(".discovery-row-coordinate", { hasText: SEEDED_LEAD.logId });

  await expect(coordinate).toBeVisible();
  await clickWhereItSits(page, coordinate);
  await expect(page).toHaveURL(new RegExp(`/log/${SEEDED_LEAD.logId.replaceAll(".", "\\.")}$`));
});

test("clicking a row's year opens the track", async ({ page }) => {
  await blockExternalRequests(page);
  await hydrate(page, "/tracks");

  const row = page.locator(".discovery-row", { has: page.locator(".discovery-row-year") }).first();
  const href = await row.locator(".discovery-row-link").getAttribute("href");

  await clickWhereItSits(page, row.locator(".discovery-row-year"));
  await expect(page).toHaveURL(new RegExp(`${(href ?? "").replaceAll(".", "\\.")}$`));
});

test("a row's cover and menu are operable from the keyboard", async ({ page }) => {
  await blockExternalRequests(page);
  await routePreviews(page, { seconds: 30 });
  await hydrate(page, `/search?q=${encodeURIComponent("Aurora")}`);

  const row = page.locator(".discovery-row").first();
  const cover = row.locator(".play-cover");

  await cover.focus();
  await page.keyboard.press("Enter");
  await expect(cover).toHaveAttribute("data-status", /^(loading|playing)$/);

  const menu = row.locator(".track-menu-trigger");

  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Similar tracks" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Similar tracks" })).toHaveCount(0);
  await expect(menu).toBeFocused();
});

test("every row menu is a 44px target, the archive row's included", async ({ page }) => {
  await blockExternalRequests(page);

  for (const path of ["/tracks", "/findings"]) {
    await hydrate(page, path);

    const triggers = page.locator(".track-menu-trigger, .track-row .track-action");
    const count = await triggers.count();

    expect(count, `${path} should render row menus`).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const box = await triggers.nth(index).boundingBox();

      expect(box?.width ?? 0, `${path} menu ${index} width`).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0, `${path} menu ${index} height`).toBeGreaterThanOrEqual(44);
    }
  }
});
