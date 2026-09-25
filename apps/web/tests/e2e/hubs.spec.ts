import { expect, test, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { routePreviews } from "./player";

async function hydrate(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
}

const HUBS = [
  { lane: "Labels A to Z", path: "/labels" },
  { lane: "Albums A to Z", path: "/albums" },
  { lane: "Artists A to Z", path: "/artists" },
] as const;

test.describe("hubs — desktop", () => {
  test.use({ viewport: { height: 900, width: 1440 } });

  for (const hub of HUBS) {
    test(`${hub.path}: opens on Most tracks, and the switch reaches A–Z and its lane`, async ({
      page,
    }) => {
      await blockExternalRequests(page);
      await hydrate(page, hub.path);

      const order = page.getByRole("group", { name: "Order" });

      await expect(order.getByRole("button", { pressed: true })).toHaveText("Most tracks");
      await expect(page.getByRole("navigation", { name: hub.lane })).toHaveCount(0);
      await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

      await order.getByRole("button", { name: "A–Z" }).click();
      await expect(page).toHaveURL(new RegExp(`${hub.path}\\?order=az$`));
      await expect(page.getByRole("navigation", { name: hub.lane })).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        "noindex, follow",
      );
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        new RegExp(`${hub.path}$`),
      );

      const footer = page.locator("#content").getByRole("navigation", { name: "The archive" });

      await expect(footer.getByRole("link")).toHaveText([
        "Tracks",
        "Artists",
        "Albums",
        "Labels",
        "Fresh",
      ]);
      await expect(footer.locator('[aria-current="page"]')).toHaveCount(1);
    });
  }

  test("/labels: the This month strip leads the default view and points on to Fresh", async ({
    page,
  }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/labels");

    const strip = page.getByRole("region", { name: "This month" });

    await expect(
      strip.getByRole("list", { name: "Labels with a record out this month" }),
    ).toHaveCount(1);
    await expect(strip.getByRole("link", { name: "All new releases" })).toHaveAttribute(
      "href",
      "/fresh",
    );

    await hydrate(page, "/labels?order=recent");
    await expect(page.getByRole("region", { name: "This month" })).toHaveCount(0);
    await hydrate(page, "/labels?order=az");
    await expect(page.getByRole("region", { name: "This month" })).toHaveCount(0);
  });

  test("a label tile plays its label: findings first, as one list in the player", async ({
    page,
  }) => {
    await blockExternalRequests(page);
    await routePreviews(page, { seconds: 30 });
    await hydrate(page, "/labels");

    const grid = page.getByRole("list", { name: "Labels" });
    const tile = grid.getByRole("listitem").first();
    const play = tile.getByRole("button", { name: /^Play / });

    await tile.hover();
    await play.click();

    const bar = page.getByRole("region", { name: "Player" });

    await expect(bar).toBeVisible();
    await expect(tile.getByRole("button", { name: /^Pause / })).toBeVisible();
    await expect(bar).toContainText(/1\/(?:[2-9]|\d{2,})/);
  });

  test("an album tile names its artist", async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/albums");

    await expect(
      page.getByRole("list", { name: "Albums" }).locator(".artist-grid-credit").first(),
    ).not.toBeEmpty();
  });

  test("/artists says what Compare sounds gives back before it is pressed", async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/artists");

    await expect(
      page.getByText("Pick two to six artists to see who sounds closest to them."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Compare sounds" })).toBeVisible();
  });
});

test.describe("hubs — phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { height: 844, width: 390 } });

  test("a tile's play control is always shown and thumb-sized", async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/albums");

    const play = page.getByRole("list", { name: "Albums" }).getByRole("button", { name: /^Play / });

    await expect(play.first()).toBeVisible();

    const box = await play.first().boundingBox();

    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
