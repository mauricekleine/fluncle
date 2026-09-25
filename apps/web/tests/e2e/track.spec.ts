import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { blockExternalRequests } from "./browser";
import {
  SEEDED_BARE_TRACK,
  SEEDED_DESTINATION_NEIGHBOUR,
  SEEDED_DESTINATION_TRACK,
  SEEDED_FINDING_LOG_IDS,
  SEEDED_THIN_TRACK,
} from "./seed";

const SHOT_DIR = process.env.TRACK_JOURNEY_SHOT_DIR ?? join(process.cwd(), ".dev", "track-journey");

const DESKTOP = { height: 900, width: 1440 };
const MOBILE = { height: 844, width: 390 };

const DESTINATION_PATH = `/track/${SEEDED_DESTINATION_TRACK.trackId}`;
const NEIGHBOUR_PATH = `/track/${SEEDED_DESTINATION_NEIGHBOUR.trackId}`;
const THIN_PATH = `/track/${SEEDED_THIN_TRACK.trackId}`;
const BARE_PATH = `/track/${SEEDED_BARE_TRACK.trackId}`;

const TIER_WORDS = [
  "catalogue",
  "uncertified",
  "un-certified",
  "unverified",
  "not certified",
  "unlogged",
];

function decoded(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

function expectCanonical(html: string, path: string): void {
  const canonical = /<link[^>]*rel="canonical"[^>]*>/.exec(html)?.[0] ?? "";

  expect(canonical, `${path} should carry a canonical link`).not.toBe("");
  expect(canonical).toContain(`href="https://www.fluncle.com${path}"`);
}

function trackJsonLd(html: string): Record<string, unknown> | undefined {
  for (const [, body] of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
    try {
      const parsed: unknown = JSON.parse(body.replaceAll("&#x27;", "'").replaceAll("&amp;", "&"));

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>)["@type"] === "MusicRecording"
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

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

test("the destination SSRs every fact the archive holds, and names no tier", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  const raw = decoded(await (await page.request.get(DESTINATION_PATH)).text());

  expect(raw).toContain(SEEDED_DESTINATION_TRACK.title);
  expect(raw).toContain(SEEDED_DESTINATION_TRACK.artist);

  expect(raw).toContain("Released");
  expect(raw).toContain("Length");
  expect(raw).toContain("BPM");
  expect(raw).toContain("Key");
  expect(raw).toContain("Album");
  expect(raw).toContain("Label");
  expect(raw).toContain("ISRC");

  expect(raw).toContain("Listen on Spotify");
  expect(raw).toContain("Listen on Apple Music");

  expect(raw).not.toContain("Close in sound");

  for (const word of TIER_WORDS) {
    expect(raw.toLowerCase(), `the SSR HTML must not contain "${word}"`).not.toContain(word);
  }

  const description = /<meta content="([^"]*)" name="description"\/>/.exec(raw)?.[1] ?? "";

  expect(description, "the page carries a description").not.toBe("");
  expect(
    description.length,
    `the description fits the SERP budget: ${description}`,
  ).toBeLessThanOrEqual(160);
  expect(description.toLowerCase()).not.toContain("archive");
  expect(description).toContain(SEEDED_DESTINATION_TRACK.title);

  const recording = trackJsonLd(raw);

  expect(recording).toHaveProperty("duration");
  expect(recording?.["name"]).toBe(SEEDED_DESTINATION_TRACK.title);

  await page.goto(DESTINATION_PATH, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEEDED_DESTINATION_TRACK.title);
  await expect(page.getByRole("link", { name: "Listen on Spotify" })).toBeVisible();

  expect(problems, `no console/page errors: ${problems.join(" | ")}`).toEqual([]);
});

test("a certified track's destination is its coordinate, permanently, and /log is untouched", async ({
  page,
}) => {
  const logId = SEEDED_FINDING_LOG_IDS[0] ?? "";

  const response = await page.request.get("/track/e2e-track-1", { maxRedirects: 0 });

  expect(response.status(), "a certified track's /track URL is a permanent redirect").toBe(301);
  expect(response.headers()["location"]).toBe(`/log/${logId}`);

  const log = await page.request.get(`/log/${logId}`);

  expect(log.status()).toBe(200);
  expect(decoded(await log.text())).toContain(logId);
});

test("the evidence gate drives BOTH the page's directive and the sitemap, from one expression", async ({
  page,
}) => {
  const rich = decoded(await (await page.request.get(DESTINATION_PATH)).text());

  expectCanonical(rich, DESTINATION_PATH);
  expect(rich).toContain('property="og:title"');
  expect(rich).toContain('property="og:image"');
  expect(rich).toContain('name="twitter:card"');
  expect(rich).toContain('"@type":"MusicRecording"');
  expect(rich).toContain('"@type":"BreadcrumbList"');

  expect(rich).not.toContain("fluncle-log-id");
  expect(rich, "an evidence-rich page is submitted for indexing").not.toContain("noindex");

  const thinResponse = await page.request.get(THIN_PATH);

  expect(thinResponse.status(), "a thin page still answers 200").toBe(200);

  const thin = decoded(await thinResponse.text());

  expect(thin).toContain(SEEDED_THIN_TRACK.title);
  expect(thin).toContain('content="noindex, follow"');
  expectCanonical(thin, THIN_PATH);

  expect(thin).not.toContain("Listen on Apple Music");

  const sitemap = await (await page.request.get("/sitemap/tracks-1.xml")).text();

  expect(sitemap).toContain(`<loc>https://www.fluncle.com${DESTINATION_PATH}</loc>`);
  expect(sitemap).not.toContain(`<loc>https://www.fluncle.com${THIN_PATH}</loc>`);

  expect(sitemap).not.toContain("/track/e2e-track-1");

  const index = await (await page.request.get("/sitemap.xml")).text();

  expect(index).toContain("<loc>https://www.fluncle.com/sitemap/tracks-1.xml</loc>");
});

test("the archive links INTO the destination rather than straight back out", async ({ page }) => {
  await blockExternalRequests(page);

  await page.goto("/tracks", { waitUntil: "networkidle" });

  const row = page.locator(`a[href="${DESTINATION_PATH}"]`).first();

  await expect(row).toBeVisible();

  await page.goto("/album/undertow-ledger", { waitUntil: "networkidle" });
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
  await expect(page.locator(`a[href="${DESTINATION_PATH}"]`).first()).toBeVisible();
  await page
    .getByRole("button", { name: `Actions for Ashen Relay — ${SEEDED_DESTINATION_TRACK.title}` })
    .click();
  await expect(page.getByRole("menuitem", { name: "Listen on Spotify" })).toHaveAttribute(
    "href",
    /open\.spotify\.com/,
  );
});

test.describe("the cold-arrival journey", () => {
  test.beforeAll(() => {
    mkdirSync(SHOT_DIR, { recursive: true });
  });

  for (const [name, viewport] of [
    ["desktop-1440x900", DESKTOP],
    ["mobile-390x844", MOBILE],
  ] as const) {
    test(`completes at ${name} with no account`, async ({ page }) => {
      await blockExternalRequests(page);

      const problems = watchForErrors(page);

      await page.setViewportSize(viewport);

      await page.goto(DESTINATION_PATH, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        SEEDED_DESTINATION_TRACK.title,
      );

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `no horizontal bleed at ${name}`).toBeLessThanOrEqual(1);
      await page.screenshot({ fullPage: true, path: join(SHOT_DIR, `${name}-1-arrive.png`) });

      await expect(page.locator('[data-discovery="similar"]')).toHaveCount(0);
      await page.getByRole("link", { exact: true, name: "All tracks" }).click();
      await page.waitForURL("**/tracks");

      const neighbour = page.locator(`a[href="${NEIGHBOUR_PATH}"]`).first();

      await expect(
        neighbour,
        "the all-tracks index offers the unlit row as a continuing path",
      ).toBeVisible();
      await neighbour.click();
      await page.waitForURL(`**${NEIGHBOUR_PATH}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        SEEDED_DESTINATION_NEIGHBOUR.title,
      );
      await page.screenshot({ fullPage: true, path: join(SHOT_DIR, `${name}-2-index-route.png`) });

      const out = page.getByRole("link", { name: "Listen on Spotify" });

      await expect(out).toBeVisible();
      await expect(out).toHaveAttribute(
        "href",
        `https://open.spotify.com/track/${SEEDED_DESTINATION_NEIGHBOUR.trackId}`,
      );
      await expect(out).toHaveAttribute("target", "_blank");
      await page.screenshot({ fullPage: true, path: join(SHOT_DIR, `${name}-3-leave.png`) });

      expect(problems, `no console/page errors: ${problems.join(" | ")}`).toEqual([]);
    });
  }
});

test("a failed cover degrades to the mark instead of a broken-image glyph", async ({ page }) => {
  await blockExternalRequests(page);
  await page.route(SEEDED_DESTINATION_TRACK.coverUrl, (route) =>
    route.fulfill({ body: "", status: 404 }),
  );

  const problems: string[] = [];

  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    const text = message.text();
    const isTheFailedCover =
      text.includes("Failed to load resource") || text.includes(SEEDED_DESTINATION_TRACK.coverUrl);

    if (message.type() === "error" && !isTheFailedCover) {
      problems.push(`console.error: ${text}`);
    }
  });

  await page.goto(DESTINATION_PATH, { waitUntil: "networkidle" });

  await expect(page.locator(".track-masthead-cover.track-artwork-fallback")).toBeVisible();
  await expect(page.locator(`img[src="${SEEDED_DESTINATION_TRACK.coverUrl}"]`)).toHaveCount(0);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEEDED_DESTINATION_TRACK.title);
  await expect(page.getByRole("link", { name: "Listen on Spotify" })).toBeVisible();

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("a page with nowhere to send you promises nothing, in the markup or the snippet", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);
  const response = await page.request.get(BARE_PATH);

  expect(response.status(), "a bare row still answers 200").toBe(200);

  const raw = decoded(await response.text());

  expect(raw).toContain(SEEDED_BARE_TRACK.title);
  expect(raw).toContain(SEEDED_BARE_TRACK.artist);

  expect(raw).not.toContain("<dt>Length</dt>");

  const recording = trackJsonLd(raw);

  expect(recording, "the page emits a MusicRecording node").toBeDefined();
  expect(recording).not.toHaveProperty("duration");

  expect(raw).not.toContain("Listen on Spotify");
  expect(raw).not.toContain("Listen on Apple Music");
  expect(raw).not.toContain("Play the preview");
  expect(raw).not.toContain("Close in sound");

  const description = /<meta content="([^"]*)" name="description"\/>/.exec(raw)?.[1] ?? "";

  expect(description).toContain(SEEDED_BARE_TRACK.title);
  expect(description).not.toContain("Where to hear it");
  expect(description).not.toContain("closest to it in sound");

  expect(raw).toContain('content="noindex, follow"');

  await page.goto(BARE_PATH, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEEDED_BARE_TRACK.title);

  expect(problems, `no console/page errors: ${problems.join(" | ")}`).toEqual([]);
});

test("an unknown id 404s in the catalogue register, never on a coordinate", async ({ page }) => {
  await blockExternalRequests(page);
  await page.goto("/track/no-such-track-id", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("No track at this address");

  await expect(page.getByText("All tracks", { exact: true })).toBeVisible();

  await expect(page.locator("main")).not.toContainText("coordinate");
});
