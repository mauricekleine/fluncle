// `/fresh` AS A FINITE WEEK (docs/planning/discovery-ux, DX-17…DX-20), walked by two people.
//
//   - Marcus at 1440×900: distinct releases at the top (one record is one entry, its tracks folding
//     out beneath it), week buckets with their counts, the end of the window said outright, and the
//     browser-local "new since your last visit" line on the way back.
//   - Priya at 390×844: one tap on "Play this week" and the week plays through the player.
//
// The seed's window (tests/e2e/seed.ts): the lead finding a day back and one catalogue single three
// days back land in this week; the two-track "Undertow Ledger" record sits twenty days back.
// Previews are answered with silence (`tests/e2e/player.ts`).

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { routePreviews } from "./player";
import { SEEDED_DESTINATION_NEIGHBOUR, SEEDED_DESTINATION_TRACK, SEEDED_LEAD } from "./seed";

const VISIT_KEY = "fluncle:fresh-visit";

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

test.describe("Marcus at 1440×900", () => {
  test.use({ viewport: { height: 900, width: 1440 } });

  test("reaches the end of the window through distinct releases, week by week", async ({
    page,
  }) => {
    const problems = watchForErrors(page);

    await blockExternalRequests(page);
    await hydrate(page, "/fresh");

    // The catalogue plate: the title alone and one factual line.
    await expect(page.getByRole("heading", { level: 1, name: "Fresh" })).toBeVisible();
    await expect(page.locator(".log-index-intro")).toHaveText(
      /^\d+ drum & bass releases? from the last 30 days\.$/,
    );

    // This week leads, with its count; the lead finding sits in it.
    const thisWeek = page.getByRole("region", { exact: true, name: "This week" });

    await expect(thisWeek).toBeVisible();
    await expect(thisWeek.locator(".fresh-week-count")).toHaveText("2 releases");
    await expect(thisWeek.getByText(SEEDED_LEAD.title, { exact: true })).toBeVisible();

    // The two-track record is ONE entry: one title, one count, its tracks folded away.
    const record = page.locator(".fresh-release").filter({
      has: page.getByRole("link", { name: new RegExp(`^${SEEDED_DESTINATION_TRACK.title} by `) }),
    });

    await expect(record).toHaveCount(1);

    const toggle = record.getByRole("button", { name: "2 tracks" });

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(record.getByText(SEEDED_DESTINATION_NEIGHBOUR.title)).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    const folded = record.locator(".fresh-release-tracks .discovery-row");

    await expect(folded).toHaveCount(2);
    await expect(record.getByText(SEEDED_DESTINATION_NEIGHBOUR.title)).toBeVisible();

    // The end of the window, said outright.
    await expect(page.locator(".fresh-end")).toHaveText(
      "That's every release from the last 30 days. You're caught up.",
    );

    // Every week heading is an H2 under the page's H1, newest first.
    const weeks = page.locator(".fresh-week h2");

    await expect(weeks.first()).toHaveText("This week");

    expect(problems).toEqual([]);
  });

  test("sees what landed since the last visit, held in this browser alone", async ({ page }) => {
    await blockExternalRequests(page);

    // A first visit says nothing about the last one.
    await hydrate(page, "/fresh");
    await expect(page.locator(".fresh-since-visit")).toHaveText("");

    const stored = await page.evaluate(
      (key) => JSON.parse(window.localStorage.getItem(key) ?? "null") as { seen: string[] } | null,
      VISIT_KEY,
    );

    expect(stored?.seen.length).toBeGreaterThan(0);

    // A later sitting that had not seen the lead's release.
    await page.evaluate(
      ({ key, seen }) =>
        window.localStorage.setItem(
          key,
          JSON.stringify({ at: Date.now() - 2 * 60 * 60 * 1000, seen }),
        ),
      { key: VISIT_KEY, seen: (stored?.seen ?? []).slice(1) },
    );
    await hydrate(page, "/fresh");
    await expect(page.locator(".fresh-since-visit")).toHaveText(
      "1 new release since your last visit.",
    );
    await expect(page.locator(".fresh-week .fresh-new-mark")).toHaveText(["New"]);

    // The line leads to the mark it counts: the jump lands focus on the new release's link.
    await page.getByRole("button", { name: "Jump to the first new release" }).click();
    await expect(
      page.locator(".fresh-week li:has(.fresh-new-mark) .discovery-row-link"),
    ).toBeFocused();

    // Back inside the same sitting, the mark holds; nothing else became new.
    await hydrate(page, "/fresh");
    await expect(page.locator(".fresh-since-visit")).toHaveText(
      "1 new release since your last visit.",
    );
  });

  test("keeps the same weeks under each view, and every control names what it shows", async ({
    page,
  }) => {
    await blockExternalRequests(page);

    await hydrate(page, "/fresh?view=albums");
    await expect(page.locator(".fresh-release")).toHaveCount(1);
    await expect(page.locator(".fresh-week")).toHaveCount(1);
    await expect(page.locator(".fresh-end")).toHaveText(
      "That's every album and EP from the last 30 days. You're caught up.",
    );

    await hydrate(page, "/fresh?view=tracks");
    await expect(
      page.getByRole("region", { exact: true, name: "This week" }).locator(".fresh-week-count"),
    ).toHaveText("2 tracks");
    await expect(page.locator(".fresh-end")).toHaveText(
      "That's every track from the last 30 days. You're caught up.",
    );

    // Label-in-name (WCAG 2.5.3): a control's accessible name carries its visible text.
    await hydrate(page, "/fresh");
    const mismatches = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("main a[aria-label], main button[aria-label]")]
        .map((element) => ({
          label: (element.getAttribute("aria-label") ?? "").toLowerCase(),
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase(),
        }))
        .filter(({ label, text }) => text.length > 0 && !label.includes(text)),
    );

    expect(mismatches).toEqual([]);
  });
});

test.describe("Priya at 390×844", () => {
  test.use({ viewport: { height: 844, width: 390 } });

  test("starts this week with one tap and pauses it from the same control", async ({ page }) => {
    await blockExternalRequests(page);
    await routePreviews(page, { seconds: 30 });
    await hydrate(page, "/fresh");

    const player = page.getByRole("region", { name: "Player" });
    const playWeek = page.getByRole("button", { exact: true, name: "Play this week" });

    await playWeek.click();
    await expect(player).toBeVisible();
    await expect(player.locator(".player-position--inline")).toHaveText(/^1\/\d+$/);

    const pauseWeek = page.getByRole("button", { exact: true, name: "Pause this week" });

    await expect(pauseWeek).toBeVisible();
    await pauseWeek.click();
    await expect(playWeek).toBeVisible();
    await expect(player.getByRole("button", { exact: true, name: "Play" })).toBeVisible();
  });
});
