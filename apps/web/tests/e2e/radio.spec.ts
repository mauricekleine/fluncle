import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_RADIO_FINDING } from "./seed";

const RADIO_TITLE = "Fluncle, observing";

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

test("radio SSRs its gate, resolves the eligible finding, and hydrates", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  const rawHtml = await (await page.request.get("/radio")).text();
  expect(rawHtml, "SSR HTML should carry the radio title").toContain(RADIO_TITLE);
  expect(rawHtml, "SSR HTML should carry the begin control").toContain("Begin");

  const slotResponse = await page.request.get("/api/v1/radio/now-playing");
  expect(slotResponse.status()).toBe(200);

  const slot = (await slotResponse.json()) as {
    nowPlaying: { currentTrack: { logId: string; title: string }; trackCount: number };
  };
  expect(slot.nowPlaying.currentTrack.title).toBe(SEEDED_RADIO_FINDING.title);
  expect(slot.nowPlaying.currentTrack.logId).toBe(SEEDED_RADIO_FINDING.logId);
  expect(slot.nowPlaying.trackCount).toBe(1);

  const response = await page.goto("/radio", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { name: RADIO_TITLE })).toBeVisible();

  const begin = page.getByRole("button", { name: "Begin" });

  await expect(async () => {
    if (await begin.isVisible()) {
      await begin.click();
    }

    await expect(begin).toBeHidden({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  await expect(page.getByRole("heading", { name: SEEDED_RADIO_FINDING.title })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(SEEDED_RADIO_FINDING.logId)).toBeVisible();
  await expect(page.getByText(SEEDED_RADIO_FINDING.artist)).toBeVisible();

  const cog = page.getByRole("button", { name: "Surface settings" });
  const soundSwitch = page.getByRole("switch", { name: "Sound" });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(soundSwitch).toBeHidden({ timeout: 2000 });
    await cog.click();
    await expect(soundSwitch).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
