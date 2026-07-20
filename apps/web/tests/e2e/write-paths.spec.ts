// The ANONYMOUS PUBLIC WRITE PATHS — the two things a visitor with no account can
// send Fluncle: an address for the Friday newsletter, and a track for review.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE, stated up front because it shapes every
// assertion below. Both write paths end at a THIRD PARTY:
//
//   - Newsletter subscribe ends at Resend (`addContactToSegment` — Resend is the
//     sole list-of-record; there is no local subscribers table to read back).
//   - Track submission cannot even START without Spotify: the dialog only offers a
//     "send" once a Spotify SEARCH has returned a candidate to pick.
//
// The dummy e2e env carries no Resend credentials and only fake Spotify ones, and
// `blockExternalRequests` stubs the BROWSER's requests, never the server's — so
// driving either happy path from here would mean the dev server firing at a real
// remote with junk credentials. This spec therefore covers the legs that are
// genuinely OURS and genuinely hermetic: the form hydrates, the request reaches our
// own contract, the contract's verdict comes back, and the dialog shows it. The
// happy paths belong to the integration suite (which mocks the remote), not here.
//
// RATE LIMIT. `POST /newsletter` is capped at 5 per hour PER IP by a real DB-backed
// limiter — and validation runs BEFORE the limiter, so the two rejections below cost
// this run nothing. Nothing in this file consumes a bucket slot; keep it that way, or
// the next spec to subscribe from this IP gets a 429 instead of its expected answer.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";

// The browser's own network log for a deliberately-provoked rejection. Chromium
// writes one `console.error` per non-2xx fetch, so a spec that PROVES a 400 comes
// back cannot also assert an empty console. This is the narrowest possible
// allowance — one exact string, for the exact status the test itself asks for — and
// it never hides an application error: a page error still fails, and so does any
// other console line. Every other spec keeps the unfiltered gate.
const EXPECTED_REJECTION_LOG =
  "console.error: Failed to load resource: the server responded with a status of 400 (Bad Request)";

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

/**
 * Open a home-page dialog whose trigger is a plain button, state-safely. The trigger
 * TOGGLES, so a naive click-and-check loop can alternate open/closed forever; each
 * attempt therefore resets to a known CLOSED state before clicking. Until React
 * hydrates the click is inert, which is exactly what the retry absorbs.
 */
async function openDialog(page: Page, trigger: string, heading: string): Promise<void> {
  const dialog = page.getByRole("dialog").filter({ hasText: heading });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 2000 });
    await page.getByRole("button", { name: trigger }).first().click();
    await expect(dialog).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
}

test("the newsletter form reaches the subscribe contract and shows its verdict", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await openDialog(page, "Newsletter", "The weekly newsletter");

  // `a@b.c` is deliberate: the browser's own `type="email"` validation ACCEPTS it, so
  // the form actually submits, and the SERVER rejects it (`validateInput` requires at
  // least two characters after the final dot). That makes this a true round trip —
  // form → POST /newsletter → the contract's validation → the message on screen —
  // rather than a client-side guard that never leaves the page. It also costs no
  // rate-limit slot: validation runs ahead of the limiter.
  const emailField = page.getByLabel("Email", { exact: true });

  await emailField.fill("a@b.c");
  await page.getByRole("button", { name: "Get on the list" }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible({ timeout: 15_000 });

  // The spam gate, end to end. The honeypot is a real field in the DOM (visually
  // hidden, out of the tab order) that only a bot fills; filling it makes an
  // otherwise-perfect submission a 400, and the address never reaches the list. A
  // human's answer would have been "Welcome to the mothership".
  await page.locator("#newsletter-website").fill("definitely-a-bot");
  await emailField.fill(`e2e_${Date.now()}@example.invalid`);
  await page.getByRole("button", { name: "Get on the list" }).click();
  await expect(page.getByText("Invalid request")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Welcome to the mothership")).toHaveCount(0);

  expect(
    problems.filter((problem) => problem !== EXPECTED_REJECTION_LOG),
    `expected a clean console apart from the provoked 400s, saw:\n${problems.join("\n")}`,
  ).toEqual([]);
});

test("the submission dialog hydrates and refuses to search on nothing", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await openDialog(page, "Submit a track", "Search Spotify, pick the match");

  // The dialog opens on the SEARCH step and offers no way to send until a candidate
  // is picked — so this is as far as the UI exposes the submission path without a
  // live Spotify. An empty search is refused in the browser, before any request.
  await expect(page.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Enter a Spotify URL or track search.")).toBeVisible({
    timeout: 15_000,
  });

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
