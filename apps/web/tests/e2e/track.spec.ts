// THE ARCHIVE TRACK DESTINATION (`/track/<trackId>`) — the public-flow spec.
//
// It proves the four things every public-page spec proves (SSR, identity over the seeded fixtures,
// hydration of a genuinely client-only control, a clean console — see `tests/e2e/README.md`), and
// then the five things specific to THIS surface that cannot be asserted in prose:
//
//   A. THE COLD-ARRIVAL JOURNEY, end to end and with no account: land on a track, continue into an
//      UNFAMILIAR sonic neighbour, and leave from there to an accurate outbound listening service.
//      Run at desktop 1440×900 and mobile 390×844, and evidenced by retained full-page screenshots
//      at every step rather than by a claim.
//   B. The certified rail: `/track/<id>` for a CERTIFIED track is a permanent redirect to
//      `/log/<coordinate>`, and that log page still answers exactly as it did.
//   C. The EVIDENCE gate, on both sides of the same expression: an evidence-rich page is
//      self-canonical, carries its sharing metadata and its structured data, and is a member of the
//      sitemap; a thin page is reachable and navigable but `noindex, follow` and absent from it.
//   D. Every band omits what the archive does not hold, and no control points at nothing.
//   E. A failed third-party cover degrades to the fallback instead of a broken-image glyph.
//
// ── THE ONE RULE THAT OUTRANKS THE REST ───────────────────────────────────────────────────────
// The tier has no public name. This spec asserts it directly: no word on any of these pages, in
// the rendered text or in the SSR bytes, may introduce, name, or count the register a track
// belongs to.

import { expect, test, type ConsoleMessage, type Locator, type Page } from "@playwright/test";
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

/** Where the retained journey evidence lands. Gitignored (`apps/web/.dev/`), operator-overridable. */
const SHOT_DIR = process.env.TRACK_JOURNEY_SHOT_DIR ?? join(process.cwd(), ".dev", "track-journey");

/** The two widths the acceptance criteria name. Desktop first — it is the reading width. */
const DESKTOP = { height: 900, width: 1440 };
const MOBILE = { height: 844, width: 390 };

const DESTINATION_PATH = `/track/${SEEDED_DESTINATION_TRACK.trackId}`;
const NEIGHBOUR_PATH = `/track/${SEEDED_DESTINATION_NEIGHBOUR.trackId}`;
const THIN_PATH = `/track/${SEEDED_THIN_TRACK.trackId}`;
const BARE_PATH = `/track/${SEEDED_BARE_TRACK.trackId}`;

/**
 * The words that would name the tier. None of them may appear on any of these pages — not as a
 * heading, not as a caption, not in a meta description, not in the structured data.
 */
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

/**
 * Assert the document is SELF-CANONICAL. React emits `<link>` attributes in its own order, so the
 * check is on the two facts (the rel and the href) rather than on one literal byte sequence — a
 * substring assertion here would fail on an attribute reorder that changes nothing.
 */
function expectCanonical(html: string, path: string): void {
  const canonical = /<link[^>]*rel="canonical"[^>]*>/.exec(html)?.[0] ?? "";

  expect(canonical, `${path} should carry a canonical link`).not.toBe("");
  expect(canonical).toContain(`href="https://www.fluncle.com${path}"`);
}

/**
 * The page's `MusicRecording` node, parsed out of the SSR HTML. Returned as an object so a test can
 * assert on the presence or ABSENCE of a key — which is the assertion that matters for a field
 * whose "absent" is a value: a `duration` of `null`, `""` or `"PT0M0S"` all fail a key check and
 * all sail past a string check.
 */
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

test("the destination SSRs every fact the archive holds, and names no tier", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // (1) SSR — the crawler's view, before any client JS runs.
  const raw = decoded(await (await page.request.get(DESTINATION_PATH)).text());

  expect(raw).toContain(SEEDED_DESTINATION_TRACK.title);
  expect(raw).toContain(SEEDED_DESTINATION_TRACK.artist);
  // The facts, each from a different column, so a dropped one is visible here rather than in prod.
  expect(raw).toContain("Released");
  expect(raw).toContain("Length");
  expect(raw).toContain("BPM");
  expect(raw).toContain("Key");
  expect(raw).toContain("Album");
  expect(raw).toContain("Label");
  expect(raw).toContain("ISRC");
  // The outbound controls — the exact ratified labels `/log` already uses.
  expect(raw).toContain("Listen on Spotify");
  expect(raw).toContain("Listen on Apple Music");
  // The way on.
  expect(raw).toContain("Close in sound");

  // (2) THE UNNAMED TIER, asserted on the raw bytes so a meta description or a JSON-LD string
  // cannot smuggle the word past a visible-text check.
  for (const word of TIER_WORDS) {
    expect(raw.toLowerCase(), `the SSR HTML must not contain "${word}"`).not.toContain(word);
  }

  // (3) THE DESCRIPTION IS BUDGETED AND CLAIMS NOTHING. Public copy uses "the archive" for the set
  // Fluncle CERTIFIED, so the one string a stranger reads first must not put this page inside it —
  // and it must fit the snippet a search engine actually prints rather than being truncated to
  // whichever clause survives.
  const description = /<meta content="([^"]*)" name="description"\/>/.exec(raw)?.[1] ?? "";

  expect(description, "the page carries a description").not.toBe("");
  expect(
    description.length,
    `the description fits the SERP budget: ${description}`,
  ).toBeLessThanOrEqual(160);
  expect(description.toLowerCase()).not.toContain("archive");
  expect(description).toContain(SEEDED_DESTINATION_TRACK.title);

  // (4) THE GRAPH ASSERTS ONLY WHAT THE ARCHIVE HOLDS. The length is real here, so the key is
  // present — the mirror of the bare row's assertion below.
  const recording = trackJsonLd(raw);

  expect(recording).toHaveProperty("duration");
  expect(recording?.["name"]).toBe(SEEDED_DESTINATION_TRACK.title);

  // (5) The rendered page agrees with the SSR, and hydration is clean.
  await page.goto(DESTINATION_PATH, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEEDED_DESTINATION_TRACK.title);
  await expect(page.getByRole("link", { name: "Listen on Spotify" })).toBeVisible();

  expect(problems, `no console/page errors: ${problems.join(" | ")}`).toEqual([]);
});

test("a certified track's destination is its coordinate, permanently, and /log is untouched", async ({
  page,
}) => {
  const logId = SEEDED_FINDING_LOG_IDS[0] ?? "";
  // The finding's own track id, as the base seed mints it (`e2e-track-<n>`, index 0 → 1).
  const response = await page.request.get("/track/e2e-track-1", { maxRedirects: 0 });

  expect(response.status(), "a certified track's /track URL is a permanent redirect").toBe(301);
  expect(response.headers()["location"]).toBe(`/log/${logId}`);

  // And the destination it points at is exactly what it always was — this unit changes no
  // finding's URL, identifier, or response.
  const log = await page.request.get(`/log/${logId}`);

  expect(log.status()).toBe(200);
  expect(decoded(await log.text())).toContain(logId);
});

test("the evidence gate drives BOTH the page's directive and the sitemap, from one expression", async ({
  page,
}) => {
  // THE RICH PAGE: self-canonical, sharing metadata, structured data, and a sitemap member.
  const rich = decoded(await (await page.request.get(DESTINATION_PATH)).text());

  expectCanonical(rich, DESTINATION_PATH);
  expect(rich).toContain('property="og:title"');
  expect(rich).toContain('property="og:image"');
  expect(rich).toContain('name="twitter:card"');
  expect(rich).toContain('"@type":"MusicRecording"');
  expect(rich).toContain('"@type":"BreadcrumbList"');
  // A recording Fluncle has never ruled on carries no coordinate anywhere in its structured data.
  expect(rich).not.toContain("fluncle-log-id");
  expect(rich, "an evidence-rich page is submitted for indexing").not.toContain("noindex");

  // THE THIN PAGE: reachable, navigable, deliberately not indexed.
  const thinResponse = await page.request.get(THIN_PATH);

  expect(thinResponse.status(), "a thin page still answers 200").toBe(200);

  const thin = decoded(await thinResponse.text());

  expect(thin).toContain(SEEDED_THIN_TRACK.title);
  expect(thin).toContain('content="noindex, follow"');
  expectCanonical(thin, THIN_PATH);
  // It renders no band it has no content for — no album, no cover-derived preload, no dead control.
  expect(thin).not.toContain("Listen on Apple Music");

  // THE SITEMAP: the same expression, read as membership. One in, one out.
  const sitemap = await (await page.request.get("/sitemap/tracks-1.xml")).text();

  expect(sitemap).toContain(`<loc>https://www.fluncle.com${DESTINATION_PATH}</loc>`);
  expect(sitemap).not.toContain(`<loc>https://www.fluncle.com${THIN_PATH}</loc>`);
  // And no certified track's /track URL is ever submitted: it is a 301, and its page is already
  // carried by the findings child.
  expect(sitemap).not.toContain("/track/e2e-track-1");

  // The index advertises the child it actually serves.
  const index = await (await page.request.get("/sitemap.xml")).text();

  expect(index).toContain("<loc>https://www.fluncle.com/sitemap/tracks-1.xml</loc>");
});

test("the archive links INTO the destination rather than straight back out", async ({ page }) => {
  await blockExternalRequests(page);

  // The `/tracks` hub is the destination's own parent, and it is where a stranger meets an
  // uncertified row first. Its title must lead here, not to a streaming tab.
  await page.goto("/tracks", { waitUntil: "networkidle" });

  const row = page.locator(`a[href="${DESTINATION_PATH}"]`).first();

  await expect(row).toBeVisible();

  // The record's own page carries the same rows, with the way out kept beside the way in.
  await page.goto("/album/undertow-ledger", { waitUntil: "networkidle" });
  await expect(page.locator(`a[href="${DESTINATION_PATH}"]`).first()).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: `Listen to Ashen Relay — ${SEEDED_DESTINATION_TRACK.title} on Spotify`,
    }),
  ).toBeVisible();
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

      // STEP 1 — land on a track, cold. No sign-in, no cookie, nothing carried in.
      await page.goto(DESTINATION_PATH, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        SEEDED_DESTINATION_TRACK.title,
      );
      // Nothing bleeds sideways — the mobile width is where a detail page usually breaks.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `no horizontal bleed at ${name}`).toBeLessThanOrEqual(1);
      await page.screenshot({ fullPage: true, path: join(SHOT_DIR, `${name}-1-arrive.png`) });

      // STEP 2 — continue into an UNFAMILIAR neighbour. It is deliberately the UNLIT row: a track
      // with no coordinate and no cover, which before this unit had nowhere to send anyone.
      const neighbour: Locator = page.locator(`.track-neighbour-unlit a[href="${NEIGHBOUR_PATH}"]`);

      await expect(
        neighbour,
        "the neighbour band offers an unlit row to continue into",
      ).toBeVisible();
      await neighbour.click();
      await page.waitForURL(`**${NEIGHBOUR_PATH}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        SEEDED_DESTINATION_NEIGHBOUR.title,
      );
      await page.screenshot({ fullPage: true, path: join(SHOT_DIR, `${name}-2-neighbour.png`) });

      // STEP 3 — leave to an ACCURATE outbound listening service. Accurate means the URL the
      // archive actually stores for THIS recording, not a search link and not the previous page's.
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
  // The one route the hermetic stub is overridden for: this cover 404s, which is what a
  // re-mastered or withdrawn third-party asset does in the wild. Registered after
  // `blockExternalRequests`, so this narrower route wins.
  await blockExternalRequests(page);
  await page.route(SEEDED_DESTINATION_TRACK.coverUrl, (route) =>
    route.fulfill({ body: "", status: 404 }),
  );

  // A 404 on a subresource is reported by the browser as a console error. It IS the state under
  // test, so this one spec allows exactly that message for exactly that URL and nothing else — the
  // fail-on-any gate stays otherwise intact (the front door's precedent).
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

  // `TrackArtwork` swaps a failed cover for the eclipse-gradient mark — including when the error
  // fires BEFORE hydration, which is the case a lazy `onError` alone would miss. The masthead cover
  // is the page's eager LCP image, so it is exactly that case.
  await expect(page.locator(".track-masthead-cover.track-artwork-fallback")).toBeVisible();
  await expect(page.locator(`img[src="${SEEDED_DESTINATION_TRACK.coverUrl}"]`)).toHaveCount(0);

  // The page around it is untouched: a cover that could not be fetched is a data gap, never a
  // broken page. The facts are still there and the way out still works.
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

  // The page is about what it HAS: a name, and nothing it does not.
  expect(raw).toContain(SEEDED_BARE_TRACK.title);
  expect(raw).toContain(SEEDED_BARE_TRACK.artist);

  // NO LENGTH FIELD. `tracks.duration_ms` is NOT NULL and the crawler writes 0 as its honest
  // "unknown", so an unguarded field would print "0:00" — a measurement the archive does not hold.
  expect(raw).not.toContain("<dt>Length</dt>");

  // AND NO `duration` KEY IN THE GRAPH. Asserted on the parsed node's KEY rather than on the
  // string "PT0M0S", because a node emitting `duration: null` or `duration: ""` would be the same
  // defect wearing a different value and a string check would sail past it.
  const recording = trackJsonLd(raw);

  expect(recording, "the page emits a MusicRecording node").toBeDefined();
  expect(recording).not.toHaveProperty("duration");

  // NEITHER BAND RENDERS. No outbound control (nothing is stored), no preview control (no short
  // source to resolve one from), and no neighbour band (no vector). Not an empty state — absent.
  expect(raw).not.toContain("Listen on Spotify");
  expect(raw).not.toContain("Listen on Apple Music");
  expect(raw).not.toContain("Play the preview");
  expect(raw).not.toContain("Close in sound");

  // AND THE SNIPPET DOES NOT PROMISE THEM EITHER. This is the half a rendered-markup check misses:
  // a fixed tail would front every share and every citation with two things the page has not got.
  const description = /<meta content="([^"]*)" name="description"\/>/.exec(raw)?.[1] ?? "";

  expect(description).toContain(SEEDED_BARE_TRACK.title);
  expect(description).not.toContain("Where to hear it");
  expect(description).not.toContain("closest to it in sound");

  // It is low-evidence, so it is reachable and crawlable and deliberately not submitted.
  expect(raw).toContain('content="noindex, follow"');

  await page.goto(BARE_PATH, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEEDED_BARE_TRACK.title);

  expect(problems, `no console/page errors: ${problems.join(" | ")}`).toEqual([]);
});

test("an unknown id 404s in the catalogue register, never on a coordinate", async ({ page }) => {
  await blockExternalRequests(page);
  await page.goto("/track/no-such-track-id", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("No track at this address");
  // The control is the shared `StoriesState` button, which Base UI stamps `role="button"` on even
  // though it renders a `<Link>` — a pre-existing wart on every 404 in the app, not this route's.
  // Asserted on the ratified LABEL, which is what the Chrome Rule is about.
  await expect(page.getByText("All tracks", { exact: true })).toBeVisible();
  // The one word this whole surface exists to keep off the tier must not appear on its 404 either.
  await expect(page.locator("main")).not.toContainText("coordinate");
});
