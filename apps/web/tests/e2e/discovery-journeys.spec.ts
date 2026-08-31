// PUBLIC DISCOVERY JOURNEY EVENTS — retained evidence for the three journeys
// the instrumentation exists to see, at desktop and mobile widths.
//
// Each journey records the Simple Analytics event REQUESTS a probe would send
// (`installDiscoveryEventProbe` beacons queue.simpleanalyticscdn.com; the hermetic
// route stub fulfils them). JSON lands in the gitignored `apps/web/.dev/discovery-events/`
// and CI uploads it as the `discovery-events` artifact.
//
// A fourth test proves analytics-independence: with the probe OFF and the real tag
// stubbed empty by `blockExternalRequests`, the same clicks still navigate, no error
// surfaces, and no event request is required for the action to complete.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockExternalRequests,
  installDiscoveryEventProbe,
  type ObservedDiscoveryEvent,
} from "./browser";
import {
  SEEDED_GRAPH_ENTITIES,
  SEEDED_LEAD,
  SEEDED_SONIC_ANCHOR,
  SEEDED_SONIC_NEIGHBOUR,
} from "./seed";

const VIEWPORTS = [
  { height: 900, name: "desktop-1440x900", width: 1440 },
  { height: 844, name: "mobile-390x844", width: 390 },
] as const;

const EVIDENCE_DIR =
  process.env.DISCOVERY_EVENT_DIR ?? join(import.meta.dirname, "../../.dev/discovery-events");

const SONIC_QUERY = `tracks that sound like ${SEEDED_SONIC_ANCHOR.title}`;

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

function writeEvidence(viewport: string, journey: string, events: ObservedDiscoveryEvent[]): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, `${viewport}-${journey}.json`),
    `${JSON.stringify({ events, journey, viewport }, null, 2)}\n`,
  );
}

function beaconUrl(event: string, metadata?: Record<string, string>): string {
  const url = new URL("https://queue.simpleanalyticscdn.com/simple.gif");

  url.searchParams.set("event", event);

  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

async function recordedEvents(
  page: Page,
  probe: { events: ObservedDiscoveryEvent[] },
): Promise<ObservedDiscoveryEvent[]> {
  const fromWindow = await page.evaluate(() => {
    const held = (
      window as Window & {
        __discoveryEvents?: { event: string; metadata?: Record<string, string> }[];
      }
    ).__discoveryEvents;

    return held ?? [];
  });

  if (fromWindow.length > 0) {
    return fromWindow.map((entry) => ({
      event: entry.event,
      url: beaconUrl(entry.event, entry.metadata),
      ...(entry.metadata?.kind ? { kind: entry.metadata.kind } : {}),
      ...(entry.metadata?.service ? { service: entry.metadata.service } : {}),
    }));
  }

  return probe.events;
}

async function hydrate(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached({ timeout: 30_000 });
}

async function listenOutbound(page: Page): Promise<void> {
  const listen = page.locator(".log-actions a[href*='open.spotify.com']").first();

  await expect(listen).toBeVisible({ timeout: 15_000 });

  const popupPromise = page.waitForEvent("popup").catch(() => undefined);

  await listen.click();
  const popup = await popupPromise;

  await popup?.close().catch(() => undefined);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} discovery journeys`, () => {
    test.use({ viewport: { height: viewport.height, width: viewport.width } });

    test("zero-input browse to track to related discovery to outbound listen", async ({ page }) => {
      await blockExternalRequests(page);

      const probe = await installDiscoveryEventProbe(page);
      const problems = watchForErrors(page);

      await hydrate(page, "/");
      await page.getByRole("link", { name: /Read the log entry/ }).click();
      await expect(page).toHaveURL(new RegExp(`/log/${SEEDED_LEAD.logId}`), { timeout: 15_000 });
      await expect(page.locator("html[data-discovery-listening]")).toBeAttached();

      const neighbour = page.locator('[data-discovery="similar"] a').first();

      await expect(neighbour).toBeVisible({ timeout: 15_000 });
      await neighbour.click();
      await expect(page).toHaveURL(/\/log\//);
      expect(page.url()).not.toContain(SEEDED_LEAD.logId);
      await expect(page.locator("html[data-discovery-listening]")).toBeAttached();

      await listenOutbound(page);

      const events = await recordedEvents(page, probe);

      expect(
        events.map((event) => event.event),
        `observed ${JSON.stringify(events)}`,
      ).toEqual(["discovery_open", "discovery_similar", "discovery_outbound"]);
      expect(events[0]?.kind).toBe("finding");
      expect(events[1]?.kind).toBe("finding");
      expect(events[2]?.service).toBe("spotify");

      writeEvidence(viewport.name, "zero-input-browse", events);
      expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
    });

    test("known seed to sonic neighbour to outbound listen", async ({ page }) => {
      await blockExternalRequests(page);

      const probe = await installDiscoveryEventProbe(page);
      const problems = watchForErrors(page);

      await hydrate(page, "/search");
      const field = page.getByRole("searchbox", { name: "Search the archive" });

      await field.fill(SONIC_QUERY);
      await field.press("Enter");
      await expect(page).toHaveURL(/q=/);
      await expect(page.locator("html[data-discovery-listening]")).toBeAttached();
      await expect(
        page.getByText(SEEDED_SONIC_NEIGHBOUR.title, { exact: false }).first(),
      ).toBeVisible();

      await page
        .getByRole("link")
        .filter({ hasText: SEEDED_SONIC_NEIGHBOUR.title })
        .first()
        .click();
      await expect(page).toHaveURL(/\/log\//);
      await expect(page.locator("html[data-discovery-listening]")).toBeAttached();

      await listenOutbound(page);

      const events = await recordedEvents(page, probe);

      expect(
        events.map((event) => event.event),
        `observed ${JSON.stringify(events)}`,
      ).toEqual(["discovery_search", "discovery_open", "discovery_outbound"]);
      expect(events[0]?.kind).toBe("sonic");
      expect(events[1]?.kind).toBe("finding");
      expect(events[2]?.service).toBe("spotify");

      writeEvidence(viewport.name, "known-seed-sonic", events);
      expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
    });

    test("direct entity landing to continued discovery", async ({ page }) => {
      await blockExternalRequests(page);

      const probe = await installDiscoveryEventProbe(page);
      const problems = watchForErrors(page);

      await hydrate(page, `/artist/${SEEDED_GRAPH_ENTITIES.artist.slug}`);
      await page.getByRole("link").filter({ hasText: SEEDED_SONIC_ANCHOR.title }).first().click();
      await expect(page).toHaveURL(/\/log\//);

      const events = await recordedEvents(page, probe);

      expect(
        events.map((event) => event.event),
        `observed ${JSON.stringify(events)}`,
      ).toEqual(["discovery_open"]);
      expect(events[0]?.kind).toBe("finding");

      writeEvidence(viewport.name, "entity-landing", events);
      expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
    });
  });
}

test("discovery actions complete when Simple Analytics is absent", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);
  const saRequests: string[] = [];

  page.on("request", (request) => {
    if (request.url().includes("simpleanalytics")) {
      saRequests.push(request.url());
    }
  });

  await hydrate(page, "/");
  await page.getByRole("link", { name: /Read the log entry/ }).click();
  await expect(page).toHaveURL(new RegExp(`/log/${SEEDED_LEAD.logId}`), { timeout: 15_000 });
  await expect(page.locator("html[data-discovery-listening]")).toBeAttached();

  const neighbour = page.locator('[data-discovery="similar"] a').first();

  await expect(neighbour).toBeVisible({ timeout: 15_000 });
  await neighbour.click();
  await expect(page).toHaveURL(/\/log\//);

  await listenOutbound(page);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
  expect(page.url()).toMatch(/\/log\//);
  expect(saRequests.every((url) => !url.includes("event="))).toBe(true);
});
