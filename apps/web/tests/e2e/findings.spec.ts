import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_FINDING_TITLES, SEEDED_MIXTAPE_TITLE, SEEDED_STORY_FINDING } from "./seed";

const HYDRATION_FINDING_TITLE = SEEDED_FINDING_TITLES[0];

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

test("the archive page SSRs the seeded findings, hydrates, and logs no errors", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  const rawHtml = await (await page.request.get("/findings")).text();
  for (const title of SEEDED_FINDING_TITLES) {
    expect(rawHtml, `SSR HTML should contain "${title}"`).toContain(title);
  }

  const response = await page.goto("/findings", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  for (const title of SEEDED_FINDING_TITLES) {
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  }
  await expect(page.getByText(SEEDED_MIXTAPE_TITLE, { exact: false }).first()).toBeVisible();

  const trigger = page
    .getByRole("button", { name: new RegExp(`^Actions for .*${HYDRATION_FINDING_TITLE}`) })
    .first();
  const spotifyItem = page.getByRole("menuitem", { name: "Spotify" }).first();

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(spotifyItem).toBeHidden({ timeout: 2000 });
    await trigger.click();
    await expect(spotifyItem).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the cover backdrop can paint: body stays transparent under the z:-2 pseudo-element", async ({
  page,
}) => {
  await blockExternalRequests(page);
  await page.goto("/findings");

  const paint = await page.evaluate(() => ({
    backdropImage: getComputedStyle(document.body, "::before").backgroundImage,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }));

  expect(paint.bodyBackground).toBe("rgba(0, 0, 0, 0)");
  expect(paint.backdropImage).toContain("fluncle-cover-no-text");
});

test("a finding with footage opens its story OVER the feed, never navigating away", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    const text = message.text();
    const isTheStubbedClip =
      text.includes(SEEDED_STORY_FINDING.videoUrl) ||
      text.includes("Failed to load resource") ||
      text.includes("MEDIA_ELEMENT_ERROR") ||
      text.includes("no supported source");

    if (message.type() === "error" && !isTheStubbedClip) {
      problems.push(`console.error: ${text}`);
    }
  });

  const direct = await page.request.get(`/findings?story=${SEEDED_STORY_FINDING.logId}`, {
    maxRedirects: 0,
  });
  expect(direct.status(), "/findings?story= should be served, never redirected").toBe(200);

  await page.goto("/findings", { waitUntil: "networkidle" });

  await expect(
    page.locator("html[data-discovery-listening]"),
    "root hydration should attach the router handler before the story link is clicked",
  ).toBeAttached({ timeout: 30_000 });

  const row = page.locator("li.track-row").filter({
    has: page.locator(`a.track-log-id-link[href="/log/${SEEDED_STORY_FINDING.logId}"]`),
  });

  await row.getByRole("button", { name: /^Actions for / }).click();

  const story = page.getByRole("menuitem", { name: "Watch the story" });
  await expect(story, "the seeded finding with footage should offer its story").toHaveCount(1);

  const dialog = page.locator('[role="dialog"][aria-label="Stories"]');
  const feed = page.locator("a.cover-story");

  await story.click();
  await expect(dialog).toBeVisible();

  await expect(feed).toBeAttached();

  expect(page.url()).toContain(`/log/${SEEDED_STORY_FINDING.logId}`);

  await page.keyboard.press("Escape");

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
