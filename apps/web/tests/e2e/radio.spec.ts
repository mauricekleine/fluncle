// RADIO — `/radio`, the one continuous run of Fluncle's findings.
//
// Proven in the `home.spec.ts` shape: SSR, identity over the seeded fixture,
// hydration of a genuinely client-only control, and a clean console.
//
// ── WHAT MAKES THIS SURFACE DIFFERENT ────────────────────────────────────────
// `/radio` has NO loader. What SSRs is the begin-gate (the title, the subtitle,
// and the "Begin" button); everything after it is client work — the first
// gesture resolves the server-authoritative slot, and the schedule clock drives
// the rest. So the gate is the SSR assertion and the gate's button is the
// hydration assertion: before React attaches, clicking it does nothing at all.
//
// ── WHY THE ASSERTION IS ON THE SEEDED SET, NOT ON A PICK ────────────────────
// The random read (`getRandomRadioTrack`) is `order by random()`, and the
// schedule read is a modulo over the eligible set at the current instant — so a
// spec that assumed a particular result would flake by construction. What is
// deterministic is ELIGIBILITY: `seed.ts` seeds exactly one finding carrying a
// square master + an observation + its length + a Log ID, so whatever the loop
// resolves to, it can only be that one. The assertion is on the eligible SET.
//
// ── THE MEDIA ────────────────────────────────────────────────────────────────
// The surface plays two remote artifacts (a Cloudflare Media Transformations
// crop of the square master, and the observation audio). `blockExternalRequests`
// stubs both, so neither can start — which is a state the product already owns:
// the entry gate has a bounded "tuning" hold and opens anyway when the stream
// never becomes ready, rather than trapping the listener on a loading screen.
// That is the path this spec drives, and it is why the reveal is given a
// generous timeout rather than an instant one.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_RADIO_FINDING } from "./seed";

// The gate's own copy — the SSR target (`routes/radio.tsx`).
const RADIO_TITLE = "Fluncle, observing";

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

test("radio SSRs its gate, resolves the eligible finding, and hydrates", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // (1) SSR — the gate is what a crawler (and a reader on a cold client bundle)
  // gets: the surface's name and the way in.
  const rawHtml = await (await page.request.get("/radio")).text();
  expect(rawHtml, "SSR HTML should carry the radio title").toContain(RADIO_TITLE);
  expect(rawHtml, "SSR HTML should carry the begin control").toContain("Begin");

  // (2) Identity, at the wire — the server-authoritative slot resolves to the one
  // radio-ELIGIBLE seeded finding. Asserting the schedule read directly pins the
  // eligibility predicate (square master + observation + duration + Log ID) that
  // the whole surface stands on, independently of the browser's media stack.
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

  // (3) Hydration — "Begin" is the client-only control this surface is built on:
  // it unlocks audio, resolves the slot, and unmounts itself. A pre-hydration
  // click no-ops silently, so retry until one sticks. This is NOT a toggle, so
  // the state-safe reset is the button's own presence: each attempt clicks only
  // while it is still there, and the attempt passes when the gate has moved on.
  const begin = page.getByRole("button", { name: "Begin" });

  await expect(async () => {
    if (await begin.isVisible()) {
      await begin.click();
    }

    await expect(begin).toBeHidden({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  // The gate gave way to the run: the now-playing block names the eligible
  // finding, and its controls came with it. Generous, because the media cannot
  // start under `blockExternalRequests` and the gate's bounded hold runs first.
  await expect(page.getByRole("heading", { name: SEEDED_RADIO_FINDING.title })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(SEEDED_RADIO_FINDING.logId)).toBeVisible();
  await expect(page.getByText(SEEDED_RADIO_FINDING.artist)).toBeVisible();

  // The surface's own controls hydrate too: the settings cog opens a popover of
  // local preferences. Another genuinely client-only control, retried state-safely
  // (Escape closes the popover, so every attempt is "closed → click → expect open").
  const cog = page.getByRole("button", { name: "Surface settings" });
  const soundSwitch = page.getByRole("switch", { name: "Sound" });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(soundSwitch).toBeHidden({ timeout: 2000 });
    await cog.click();
    await expect(soundSwitch).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  // (4) No console errors, no page errors — anything here is a real regression.
  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
