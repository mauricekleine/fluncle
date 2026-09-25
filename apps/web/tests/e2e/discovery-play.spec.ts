// THE DISCOVERY LOOP, AS TWO PEOPLE WALK IT (docs/planning/discovery-ux personas), at 390×844.
//
//   - Jade, from the front door: hears three different tracks inside a minute without leaving the
//     page, follows the lead into "Similar tracks", and sends a track to Spotify.
//   - Priya: starts a list with one tap, lets it advance on its own, then pauses it from the player
//     on a different page.
//
// The preview relay is answered with silence (`tests/e2e/player.ts`), so the queue advances on the
// clip's real `ended`, in a real browser, past hydration.

import { expect, test, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { routePreviews } from "./player";
import { SEEDED_LEAD } from "./seed";

test.use({ viewport: { height: 844, width: 390 } });

async function hydrate(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
}

test("Jade hears three tracks from the front door inside a minute, without leaving it", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const requested = await routePreviews(page, { seconds: 30 });

  await hydrate(page, "/");

  const started = Date.now();
  const player = page.getByRole("region", { name: "Player" });

  // One: the lead plays where it sits.
  await page
    .getByRole("button", { name: /^Play the preview of / })
    .first()
    .click();
  await expect(player).toContainText(SEEDED_LEAD.title);

  // Two and three: tiles in the findings band, each its own cover. The band can hold the lead
  // too (it is the newest noted finding), so each press picks a tile that is not already sounding.
  const idleTiles = page.locator('#fd-findings [data-discovery-play][data-status="idle"]');

  await expect(idleTiles.first()).toBeVisible();

  for (let press = 0; press < 2; press += 1) {
    const tile = idleTiles.first();
    const label = await tile.getAttribute("aria-label");

    await tile.click();
    await expect(
      page.locator(
        `#fd-findings [data-discovery-play][aria-label="${label?.replace("Play", "Pause")}"]`,
      ),
    ).toHaveAttribute("data-status", /^(loading|playing)$/);
  }

  // A control reads "loading" the moment it is pressed, a beat before its clip is requested, so
  // the count is polled rather than read once.
  await expect.poll(() => new Set(requested).size).toBeGreaterThanOrEqual(3);
  expect(Date.now() - started).toBeLessThan(60_000);
  await expect(page).toHaveURL(/\/$/);

  // Something that sounds like it: the player's ⋮ carries the playing track's actions.
  await player.getByRole("button", { name: /^Actions for / }).click();

  const spotify = page.getByRole("menuitem", { name: "Listen on Spotify" });

  await expect(spotify).toHaveAttribute("href", /open\.spotify\.com/);

  const popup = page.waitForEvent("popup");

  await spotify.click();
  await (await popup).close();

  await player.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Similar tracks" }).click();
  await expect(page).toHaveURL(/\/search\?like=e2e-track-/);
  // The sonic view names its seed once, in the matchline.
  await expect(page.locator(".search-page-matchline")).toContainText("close to");
  await expect(page.getByText("Reading by name only right now.", { exact: false })).toHaveCount(0);
  await expect(page.locator(".search-page-tracks .discovery-row-link").first()).toBeVisible();
  // The player comes along into the results.
  await expect(player).toBeVisible();
});

test("Priya starts a list with one tap, lets it run, and pauses it from another page", async ({
  page,
}) => {
  await blockExternalRequests(page);
  await routePreviews(page, { seconds: 1.5 });
  await hydrate(page, "/tracks");

  const player = page.getByRole("region", { name: "Player" });

  await page.locator("[data-discovery-play]").first().click();
  await expect(player).toBeVisible();

  const position = player.locator(".player-position--inline");

  await expect(position).toHaveText(/^1\/\d+$/);
  // The list runs on by itself: nobody touches anything between these.
  await expect(position).toHaveText(/^3\/\d+$/, { timeout: 15_000 });

  // A different page, by client navigation: the sound and its control come along.
  await page.getByRole("banner").getByRole("link", { name: "Fluncle home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(player).toBeVisible();

  await player.getByRole("button", { exact: true, name: "Pause" }).click();
  await expect(player.getByRole("button", { exact: true, name: "Play" })).toBeVisible();
});
