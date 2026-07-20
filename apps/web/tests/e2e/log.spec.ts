// The READER spec: one finding's `/log/<logId>` page.
//
// This is the single most-linked public page Fluncle has — the permanent record at a
// coordinate, what a shared link, a crawler, and an AI agent all land on. It proves the four
// things every public-page spec proves (see `tests/e2e/README.md` and `home.spec.ts`, the
// reference shape), plus one this page owns:
//   1. SSR — the raw server response already carries the coordinate, the title, the artist,
//      and the graph links (the crawler's view, before a byte of client JS runs).
//   2. Identity — the SEEDED finding's title/artist/label, never counts, never marketing copy.
//   3. Hydration — the newsletter dialog (a shadcn Dialog, inert until React hydrates) opens.
//   4. Cleanliness — zero console errors, zero page errors.
//   5. STRUCTURED DATA — the page's `<script type="application/ld+json">` blocks are present
//      in the SSR HTML and every one of them parses. This page's schema is load-bearing for
//      search + AI discovery, so a block that stops rendering (or stops being valid JSON) is a
//      silent loss of exactly the thing the log page exists for.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_GRAPH_ENTITIES, SEEDED_GRAPH_FINDING } from "./seed";

const LOG_PATH = `/log/${SEEDED_GRAPH_FINDING.logId}`;

/** Collect every console error + page error for a fail-on-any assertion at the end. */
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

/** Every JSON-LD payload in a served HTML document, parsed. Throws if one is not valid JSON. */
function parseJsonLdBlocks(html: string): unknown[] {
  const blocks = [
    ...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g),
  ];

  // The payload is escaped on the way out (`serializeJsonLd`, the stored-XSS guard), but with
  // `\uXXXX` JSON escapes rather than HTML entities — precisely so the block stays valid JSON in
  // a <script> context. So a consumer parses it verbatim, and so do we: parsing the raw text IS
  // the assertion that a crawler can read this page's structured data.
  return blocks.map((block) => JSON.parse(block[1] ?? "") as unknown);
}

test("a finding's log page SSRs its record and schema, hydrates, and logs no errors", async ({
  page,
}) => {
  // Hermetic first: some product URLs are hardcoded to the absolute prod host and would 404
  // against synthetic fixtures, tripping the no-errors gate below for the wrong reason.
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // (1) SSR — the raw server response, no rendering. Everything a crawler needs is already here.
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

  // (5) Structured data — present in the SERVER HTML (a crawler never runs the client), and
  // every block parses. The finding's MusicRecording and the BreadcrumbList are the two this
  // page always emits; assert on their @type rather than on how many blocks there are, so the
  // check does not rot when a third (the VideoObject) starts riding along.
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

  // The navigation itself. `networkidle` lets the Vite DEV module graph finish — the client
  // bundle compiles on demand here, so hydration lands seconds after `load`.
  const response = await page.goto(LOG_PATH, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  // (2) Identity — the coordinate is the page's H1, and the finding's own facts render under it.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEEDED_GRAPH_FINDING.logId);
  await expect(page.getByRole("heading", { name: SEEDED_GRAPH_FINDING.title })).toBeVisible();
  await expect(page.getByText(SEEDED_GRAPH_FINDING.artist, { exact: false }).first()).toBeVisible();

  // The graph edges this finding carries — the artist and the label it was pressed on — are real
  // links, and they RESOLVE. A dead cross-link is the failure mode the graph exists to avoid.
  for (const href of [
    `/artist/${SEEDED_GRAPH_ENTITIES.artist.slug}`,
    `/label/${SEEDED_GRAPH_ENTITIES.label.slug}`,
  ]) {
    await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
    expect((await page.request.get(href)).status(), `${href} should resolve`).toBe(200);
  }

  // (3) Hydration — the newsletter dialog in the trail handoff. It is a shadcn Dialog, inert
  // until React hydrates, so a pre-hydration click does nothing; the open dialog IS the proof.
  //
  // The retry is state-safe: the trigger toggles, so each attempt resets to a known CLOSED state
  // (Escape) first, making every attempt "closed → click → expect open".
  const trigger = page.getByRole("button", { name: "Newsletter" });
  const dialogTitle = page.getByRole("heading", { name: "The weekly newsletter" });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialogTitle).toBeHidden({ timeout: 2000 });
    await trigger.click();
    await expect(dialogTitle).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  // (4) No console errors, no page errors — anything here is a real regression.
  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
