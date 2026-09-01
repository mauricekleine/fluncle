#!/usr/bin/env bun
/**
 * The public discovery walk — the three journeys PRODUCT.md's funnel exists for, walked as a
 * stranger against a LIVE deployment (prod by default) at a desktop and a mobile width, with the
 * evidence an independent verifier needs retained per step: a full-page screenshot, the observed
 * destination, the page's canonical + robots directive, the outbound listening target, every
 * Simple Analytics request the step sent, and any console error.
 *
 *   bun run --cwd apps/web walk:discovery                 # prod, both widths
 *   WALK_BASE=http://127.0.0.1:3000 bun run walk:discovery # a local stack
 *
 * Output lands in the gitignored `apps/web/.dev/discovery-walk/`: one PNG per step, named
 * `<viewport>--<journey>--<nn>-<step>.png`, one `<viewport>.json` index (which records the commit
 * `/api/v1/health` reported, so the evidence names what it walked), and `summary.md`, the
 * journey-organised table of every step (`discovery-walk-summary.ts`). The DURABLE home is the
 * `discovery-walk` CI artifact: `.github/workflows/discovery-walk.yml` runs this on every pull
 * request and after every successful post-deploy probe, uploads the directory for 90 days, and
 * prints `summary.md` into the job summary — so a verifier reads the destinations without a
 * download and opens the screenshots without a checkout. The journeys:
 *
 *   1-zero-input-browse  front door → the lead finding's log entry → a sonic neighbour → Listen
 *   2-known-seed-sonic   ⌘K palette → /search (typed) → a clickable sonic example → a result → Listen
 *   3-entity-landing     /artist → a track → Listen; then a label, an album, a catalogue-only track
 *   4-hubs               Fresh, Findings, Tracks, Artists, Albums, Labels, Log
 *
 * This is DISTINCT from tests/e2e/discovery-journeys.spec.ts, which proves the same journeys
 * hermetically against synthetic fixtures on every CI run. This walk asserts nothing; it records
 * what the integrated product did with real current data, so a reader can judge it without a
 * repository. The browser never leaves the site: an outbound click's popup is recorded and closed.
 */
import { type Browser, chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderWalkSummary, type WalkIndex, type WalkStep } from "./discovery-walk-summary";

const BASE = (process.env.WALK_BASE ?? "https://www.fluncle.com").replace(/\/$/, "");
const OUT = process.env.WALK_OUT ?? join(import.meta.dirname, "../.dev/discovery-walk");

const VIEWPORTS = [
  { height: 900, name: "desktop-1440x900", width: 1440 },
  { height: 844, name: "mobile-390x844", width: 390 },
] as const;

/** The entities the entity-landing journey lands on. Real, current, and public. */
const LANDINGS = {
  album: "/album/bob-weave",
  artist: "/artist/netsky",
  catalogueOnlyTrack: "/track/mb_de7b909e-4c99-4c9d-8db6-ca46acd60484",
  label: "/label/hospital-records",
} as const;

const HUBS = [
  ["fresh", "/fresh"],
  ["findings", "/findings"],
  ["tracks hub", "/tracks"],
  ["artists hub", "/artists"],
  ["albums hub", "/albums"],
  ["labels hub", "/labels"],
  ["log index", "/log"],
] as const;

type Step = WalkStep;

const HYDRATED = "html[data-discovery-listening]";

function readHead(page: Page): Promise<Pick<Step, "canonical" | "robots" | "title">> {
  return page.evaluate(() => ({
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
    robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null,
    title: document.title,
  }));
}

/** The commit the deployment reports, so the retained evidence names what it walked. */
async function servedCommit(): Promise<string | null> {
  try {
    const response = await fetch(`${BASE}/api/v1/health`);
    const body = (await response.json()) as { sha?: unknown };

    return typeof body.sha === "string" ? body.sha : null;
  } catch {
    return null;
  }
}

async function walk(
  browser: Browser,
  viewport: (typeof VIEWPORTS)[number],
  served: string | null,
): Promise<WalkIndex> {
  const mobile = viewport.width < 600;
  const context = await browser.newContext({
    hasTouch: mobile,
    isMobile: mobile,
    viewport: { height: viewport.height, width: viewport.width },
  });
  const page = await context.newPage();
  const beacons: string[] = [];
  const errors: string[] = [];
  const popups: string[] = [];

  page.on("request", (request) => {
    if (request.url().includes("simpleanalytics")) {
      beacons.push(request.url());
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  context.on("page", (popup) => {
    popups.push(popup.url());
    void popup.close().catch(() => undefined);
  });

  const journeys: Record<string, Step[]> = {};
  let ordinal = 0;

  const settle = async (): Promise<void> => {
    await page.waitForLoadState("networkidle").catch(() => undefined);
    // A client-side navigation flips the URL before the new route renders; give the loader and
    // the head a moment, then wait for the network to go quiet again.
    await page.waitForTimeout(1500);
    await page.waitForLoadState("networkidle").catch(() => undefined);
  };

  const snap = async (
    journey: string,
    step: string,
    status: number | null = null,
    outbound: string | null = null,
  ): Promise<void> => {
    ordinal += 1;
    await settle();
    const slug = step.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const screenshot = `${viewport.name}--${journey}--${String(ordinal).padStart(2, "0")}-${slug}.png`;

    await page.screenshot({ fullPage: true, path: join(OUT, screenshot) });
    const entry: Step = {
      beacons: beacons.splice(0),
      errors: errors.splice(0),
      outbound,
      screenshot,
      status,
      step,
      url: page.url(),
      ...(await readHead(page)),
    };

    (journeys[journey] ??= []).push(entry);
    console.log(
      `${viewport.name} | ${journey} | ${step} → ${entry.url}${outbound ? ` | ${outbound}` : ""}`,
    );
  };

  const open = async (journey: string, step: string, path: string): Promise<void> => {
    const response = await page.goto(BASE + path, { waitUntil: "networkidle" });

    await page
      .locator(HYDRATED)
      .waitFor({ timeout: 30_000 })
      .catch(() => errors.push("hydration marker missing"));
    await snap(journey, step, response?.status() ?? null);
  };

  const followInto = async (journey: string, step: string, href: string): Promise<void> => {
    await page.locator(`main a[href="${href}"]`).first().click();
    await page.waitForURL((url) => url.pathname === href.split("?")[0], { timeout: 15_000 });
    await page.locator(HYDRATED).waitFor({ timeout: 30_000 });
    await snap(journey, step, null, href);
  };

  const firstHref = async (selector: string): Promise<string> => {
    const link = page.locator(selector).first();

    await link.waitFor({ timeout: 15_000 });

    return (await link.getAttribute("href")) ?? "";
  };

  /** The terminal action: the named listen control, else the log entry's Listen button. */
  const listenOutbound = async (journey: string): Promise<void> => {
    const named = page.getByRole("link", { name: /^Listen on (Spotify|Apple Music|Deezer)/ });
    const fallback = page.locator(".log-actions a[href*='open.spotify.com']");
    const listen = ((await named.count()) > 0 ? named : fallback).first();

    try {
      await listen.waitFor({ timeout: 15_000 });
    } catch {
      await snap(journey, "listen outbound (no listening source on this page)");
      return;
    }

    const href = await listen.getAttribute("href");

    await listen.scrollIntoViewIfNeeded();
    await listen.click();
    await page.waitForTimeout(1500);
    const opened = popups.splice(0);

    await snap(
      journey,
      "listen outbound",
      null,
      `${href} → popup: ${opened.join(", ") || "(none)"}`,
    );
  };

  // 1 — zero-input browse.
  const j1 = "1-zero-input-browse";

  await open(j1, "front door", "/");
  await page
    .getByRole("link", { name: /Read the log entry/ })
    .first()
    .click();
  await page.waitForURL(/\/log\//, { timeout: 15_000 });
  await page.locator(HYDRATED).waitFor({ timeout: 30_000 });
  await snap(j1, "lead log entry");
  await followInto(j1, "sonic neighbour", await firstHref('[data-discovery="similar"] a'));
  await listenOutbound(j1);

  // 2 — known seed → sonic neighbour, through the palette AND the persistent surface.
  const j2 = "2-known-seed-sonic";

  await open(j2, "front door", "/");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(800);
  await snap(j2, "cmd-k palette open");
  await page.keyboard.type("netsky");
  await page.waitForTimeout(1500);
  await snap(j2, "palette results");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/search\?q=/, { timeout: 15_000 });
  await snap(j2, "palette enter destination");
  await open(j2, "search zero state", "/search");
  await followInto(j2, "sonic example results", await firstHref('a[href*="sound%20like"]'));
  await followInto(
    j2,
    "opened result",
    await firstHref('main a[href^="/log/"], main a[href^="/track/"]'),
  );
  await listenOutbound(j2);

  // 3 — direct entity landing → continued discovery.
  const j3 = "3-entity-landing";

  await open(j3, "artist page", LANDINGS.artist);
  await followInto(
    j3,
    "opened track",
    await firstHref('main a[href^="/log/"], main a[href^="/track/"]'),
  );
  await listenOutbound(j3);
  await open(j3, "label page", LANDINGS.label);
  await open(j3, "album page", LANDINGS.album);
  await open(j3, "catalogue-only track", LANDINGS.catalogueOnlyTrack);
  await listenOutbound(j3);

  // 4 — the hubs.
  for (const [name, path] of HUBS) {
    await open("4-hubs", name, path);
  }

  const index: WalkIndex = { base: BASE, journeys, served, viewport };

  writeFileSync(join(OUT, `${viewport.name}.json`), `${JSON.stringify(index, null, 2)}\n`);
  await context.close();

  return index;
}

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const served = await servedCommit();
const indexes: WalkIndex[] = [];
let failed = false;

console.log(`discovery walk: ${BASE} serving commit ${served ?? "unknown"}`);

for (const viewport of VIEWPORTS) {
  try {
    indexes.push(await walk(browser, viewport, served));
  } catch (error) {
    failed = true;
    console.error(`${viewport.name} FAILED:`, error);
  }
}

await browser.close();
writeFileSync(join(OUT, "summary.md"), renderWalkSummary(indexes));
console.log(`DISCOVERY WALK: ${failed ? "FAILED" : "COMPLETE"} → ${OUT}`);
process.exit(failed ? 1 : 0);
