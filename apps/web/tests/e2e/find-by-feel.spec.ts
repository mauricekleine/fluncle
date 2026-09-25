import { expect, test, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { routePreviews } from "./player";
import {
  SEEDED_BARE_TRACK,
  SEEDED_FINDING_TITLES,
  SEEDED_LEAD_CENTROID_TRACK,
  SEEDED_STYLE,
} from "./seed";

async function hydrate(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
}

function watchForErrors(page: Page): string[] {
  const problems: string[] = [];

  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(`console.error: ${message.text()}`);
    }
  });

  return problems;
}

test.describe("Jade, 390×844", () => {
  test.use({ viewport: { height: 844, width: 390 } });

  test("finds something that sounds like liquid without typing, and plays it", async ({ page }) => {
    await blockExternalRequests(page);
    await routePreviews(page, { seconds: 30 });
    const problems = watchForErrors(page);

    await hydrate(page, "/");
    await page
      .getByRole("list", { name: /pick a sound/ })
      .getByRole("link", { name: "Liquid" })
      .click();

    await expect(page).toHaveURL(new RegExp(`/tracks\\?sound=${SEEDED_STYLE.slug}$`));
    await expect(page.locator(".log-index-intro")).toHaveText(
      "Drum & bass tracks, closest to Liquid first.",
    );
    await expect(page.locator(".tracks-hub-matchline")).toContainText("tracks, going by");
    await expect(page.getByRole("link", { name: "Liquid" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    const rows = page.getByRole("list", { name: "Tracks" }).locator("li");

    await expect(rows.first()).toContainText(SEEDED_STYLE.rankedTitles[0] ?? "");
    await expect(rows.nth(1)).toContainText(SEEDED_STYLE.rankedTitles[1] ?? "");

    await rows
      .first()
      .getByRole("button", { name: /^Play the preview of / })
      .click();
    await expect(page.getByRole("region", { name: "Player" })).toContainText(
      SEEDED_STYLE.rankedTitles[0] ?? "",
    );

    await page.getByRole("link", { name: "Liquid, clear sound" }).click();
    await expect(page).toHaveURL(/\/tracks$/);
    expect(problems).toEqual([]);
  });

  test("follows Similar tracks twice and walks back up the trail", async ({ page }) => {
    await blockExternalRequests(page);
    await routePreviews(page, { seconds: 30 });

    await hydrate(page, `/tracks?sound=${SEEDED_STYLE.slug}`);

    const firstRow = page.getByRole("list", { name: "Tracks" }).locator("li").first();

    await firstRow.getByRole("button", { name: /^Actions for / }).click();
    await page.getByRole("menuitem", { name: "Similar tracks" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/search\\?like=${SEEDED_STYLE.rankedTrackIds[0] ?? ""}$`),
    );
    await expect(page.locator(".search-page-matchline")).toContainText(
      SEEDED_STYLE.rankedTitles[0] ?? "",
    );

    const results = page.locator(".search-page-tracks li");

    await results
      .first()
      .getByRole("button", { name: /^Play the preview of / })
      .click();

    const player = page.getByRole("region", { name: "Player" });
    const trail = player.getByRole("navigation", { name: "Similar tracks trail" });

    await expect(trail.getByRole("link")).toHaveCount(1);

    await player.getByRole("button", { name: /^Actions for / }).click();
    await page.getByRole("menuitem", { name: "Similar tracks" }).click();
    await expect(page).toHaveURL(/\/search\?like=/);
    await page
      .locator(".search-page-tracks li")
      .first()
      .getByRole("button", { name: /^Play the preview of / })
      .click();
    await expect(trail.locator("li")).toHaveCount(2);

    const visibleSeeds = trail.getByRole("link");

    await expect(visibleSeeds).toHaveCount(1);
    await visibleSeeds.click();
    await expect(page).toHaveURL(
      new RegExp(`/search\\?like=${SEEDED_STYLE.rankedTrackIds[0] ?? ""}$`),
    );
  });

  test("the player keeps its Close on screen at the end of a list, with the trail above it", async ({
    page,
  }) => {
    await blockExternalRequests(page);
    await routePreviews(page, { seconds: 0.5 });
    await hydrate(page, `/tracks?sound=${SEEDED_STYLE.slug}`);

    const firstRow = page.getByRole("list", { name: "Tracks" }).locator("li").first();

    await firstRow.getByRole("button", { name: /^Actions for / }).click();
    await page.getByRole("menuitem", { name: "Similar tracks" }).click();
    await expect(page).toHaveURL(/\/search\?like=/);

    await page
      .locator(".search-page-tracks li")
      .filter({ has: page.locator("[data-discovery-play]") })
      .last()
      .locator("[data-discovery-play]")
      .click();

    const player = page.getByRole("region", { name: "Player" });

    await expect(player.getByRole("button", { name: "Keep going" })).toBeVisible();

    const close = await player.getByRole("button", { name: "Close the player" }).boundingBox();
    const bar = await player.boundingBox();
    const trail = await player
      .getByRole("navigation", { name: "Similar tracks trail" })
      .boundingBox();

    expect((close?.x ?? 999) + (close?.width ?? 0)).toBeLessThanOrEqual(390);
    expect((trail?.y ?? 0) + (trail?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) + 1);
  });

  test("a row's title link is a full target, not a 19px line", async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/tracks");

    const box = await page.locator(".discovery-row-link").first().boundingBox();

    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  });

  test("a track with no sound hides Similar tracks; one with only its artist's sound says so", async ({
    page,
  }) => {
    await blockExternalRequests(page);

    await hydrate(page, "/tracks");

    const bare = page
      .getByRole("list", { name: "Tracks" })
      .locator("li")
      .filter({ hasText: SEEDED_BARE_TRACK.title });

    await bare.getByRole("button", { name: /^Actions for / }).click();
    await expect(page.getByRole("menuitem", { name: "Similar tracks" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await hydrate(page, `/search?like=${SEEDED_LEAD_CENTROID_TRACK.trackId}`);
    await expect(page.locator(".search-note").first()).toContainText("so I went by");
    await expect(page.locator(".search-page-tracks li").first()).toBeVisible();
  });
});

test.describe("Tom, 1440×900", () => {
  test.use({ viewport: { height: 900, width: 1440 } });

  test("a half-remembered title resolves while typing, one history entry per burst", async ({
    page,
  }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/search");

    const before = await page.evaluate(() => history.length);
    const field = page.getByRole("searchbox", { name: "Search the archive" });
    const title = SEEDED_FINDING_TITLES[0] ?? "";

    await field.click();
    await field.pressSequentially(title.slice(0, 12), { delay: 40 });

    await expect(page).toHaveURL(/\/search\?q=/);
    await expect(page.locator(".search-page-tracks").filter({ hasText: title })).toHaveCount(1);
    await expect(field).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(before + 1);

    await page.goBack();
    await expect(page).toHaveURL(/\/search$/);
  });

  test("a keystroke still settling never lands on top of a clicked example", async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/search");

    const field = page.getByRole("searchbox", { name: "Search the archive" });

    await field.click();
    await field.pressSequentially("li", { delay: 20 });
    await page.getByRole("link", { name: "netsky" }).first().click();
    await expect(page).toHaveURL(/\/search\?q=netsky$/);
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(/\/search\?q=netsky$/);
  });

  test("a sentence shows its words at once and is read as a sentence on Enter", async ({
    page,
  }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/search");

    const field = page.getByRole("searchbox", { name: "Search the archive" });
    const matchline = page.locator(".search-page-matchline");

    await field.fill("tracks in A minor above 170 bpm");
    await expect(matchline).toContainText("Press Enter");

    await field.press("Enter");
    await expect(matchline).not.toContainText("Press Enter");
  });

  test("a style word answers by sound, and hands off to the whole ranked list", async ({
    page,
  }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/search?q=liquid");

    await expect(page.locator(".search-page-matchline")).toContainText("tracks closest to Liquid.");
    await expect(page.locator(".search-note").first()).toContainText("Going by");
    const tracks = page.locator(".search-page-tracks").first().locator("li");

    await expect(tracks.first()).toContainText(SEEDED_STYLE.rankedTitles[0] ?? "");
    await expect(tracks.nth(1)).toContainText(SEEDED_STYLE.rankedTitles[1] ?? "");

    await page.getByRole("link", { name: "See all tracks closest to Liquid" }).click();
    await expect(page).toHaveURL(new RegExp(`/tracks\\?sound=${SEEDED_STYLE.slug}$`));
  });

  test("a miss still hands you a sound, and says nothing only once", async ({ page }) => {
    await blockExternalRequests(page);
    await hydrate(page, "/search?q=chilled%20liquid%20zzqx%20174");

    await expect(
      page.getByText(/^Reading by name only right now, and nothing came up/),
    ).toHaveCount(1);
    await expect(page.getByText(/Nothing out here/)).toHaveCount(0);
    await expect(page.getByText("Closest sound I’ve got:")).toBeVisible();
    await expect(
      page.locator(".search-page-state").getByRole("link", { name: "Liquid" }),
    ).toBeVisible();
  });

  test("an old galaxy filter link lands on that galaxy's own page", async ({ page }) => {
    await blockExternalRequests(page);

    const response = await page.goto("/tracks?galaxy=lunar", { waitUntil: "domcontentloaded" });

    expect(response?.url()).toMatch(/\/galaxies\/lunar$/);
  });
});
