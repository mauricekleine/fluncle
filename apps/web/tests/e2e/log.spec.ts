import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_GRAPH_ENTITIES, SEEDED_GRAPH_FINDING } from "./seed";

const LOG_PATH = `/log/${SEEDED_GRAPH_FINDING.logId}`;

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

function parseJsonLdBlocks(html: string): unknown[] {
  const blocks = [
    ...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
  ];

  return blocks.map((block) => JSON.parse(block[1] ?? "") as unknown);
}

test("a finding's log page SSRs its record and schema, hydrates, and logs no errors", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  const rawResponse = await page.request.get(LOG_PATH);
  expect(rawResponse.status()).toBe(200);

  const rawHtml = await rawResponse.text();

  for (const needle of [
    SEEDED_GRAPH_FINDING.logId,
    SEEDED_GRAPH_FINDING.title,
    SEEDED_GRAPH_FINDING.artist,
    SEEDED_GRAPH_ENTITIES.label.name,
  ]) {
    expect(rawHtml, `SSR HTML should contain "${needle}"`).toContain(needle);
  }

  const jsonLd = parseJsonLdBlocks(rawHtml);

  expect(jsonLd.length, "the log page should SSR at least one JSON-LD block").toBeGreaterThan(0);

  const types = jsonLd.map((block) =>
    typeof block === "object" && block !== null
      ? ((block as Record<string, unknown>)["@type"] ?? undefined)
      : undefined,
  );

  expect(types).toContain("MusicRecording");
  expect(types).toContain("BreadcrumbList");

  const recording = jsonLd.find((block): block is Record<string, unknown> =>
    typeof block === "object" && block !== null && "@type" in block
      ? (block as Record<string, unknown>)["@type"] === "MusicRecording"
      : false,
  );

  expect(recording?.["name"]).toBe(SEEDED_GRAPH_FINDING.title);

  const response = await page.goto(LOG_PATH, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEEDED_GRAPH_FINDING.logId);
  await expect(page.getByRole("heading", { name: SEEDED_GRAPH_FINDING.title })).toBeVisible();
  await expect(page.getByText(SEEDED_GRAPH_FINDING.artist, { exact: false }).first()).toBeVisible();

  for (const href of [
    `/artist/${SEEDED_GRAPH_ENTITIES.artist.slug}`,
    `/label/${SEEDED_GRAPH_ENTITIES.label.slug}`,
  ]) {
    await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
    expect((await page.request.get(href)).status(), `${href} should resolve`).toBe(200);
  }

  const trigger = page.getByRole("button", { name: "Newsletter" });
  const dialogTitle = page.getByRole("heading", { name: "The weekly newsletter" });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialogTitle).toBeHidden({ timeout: 2000 });
    await trigger.click();
    await expect(dialogTitle).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
