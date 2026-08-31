# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: apps/web/tests/e2e/write-paths.spec.ts >> the newsletter form reaches the subscribe contract and shows its verdict
- Location: apps/web/tests/e2e/write-paths.spec.ts:68:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "networkidle"

```

# Test source

```ts
  1   | // The ANONYMOUS PUBLIC WRITE PATHS — the two things a visitor with no account can
  2   | // send Fluncle: an address for the Friday newsletter, and a track for review.
  3   | //
  4   | // WHAT THIS SUITE CAN AND CANNOT PROVE, stated up front because it shapes every
  5   | // assertion below. Both write paths end at a THIRD PARTY:
  6   | //
  7   | //   - Newsletter subscribe ends at Resend (`addContactToSegment` — Resend is the
  8   | //     sole list-of-record; there is no local subscribers table to read back).
  9   | //   - Track submission cannot even START without Spotify: the dialog only offers a
  10  | //     "send" once a Spotify SEARCH has returned a candidate to pick.
  11  | //
  12  | // The dummy e2e env carries no Resend credentials and only fake Spotify ones, and
  13  | // `blockExternalRequests` stubs the BROWSER's requests, never the server's — so
  14  | // driving either happy path from here would mean the dev server firing at a real
  15  | // remote with junk credentials. This spec therefore covers the legs that are
  16  | // genuinely OURS and genuinely hermetic: the form hydrates, the request reaches our
  17  | // own contract, the contract's verdict comes back, and the dialog shows it. The
  18  | // happy paths belong to the integration suite (which mocks the remote), not here.
  19  | //
  20  | // RATE LIMIT. `POST /newsletter` is capped at 5 per hour PER IP by a real DB-backed
  21  | // limiter — and validation runs BEFORE the limiter, so the two rejections below cost
  22  | // this run nothing. Nothing in this file consumes a bucket slot; keep it that way, or
  23  | // the next spec to subscribe from this IP gets a 429 instead of its expected answer.
  24  |
  25  | import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
  26  | import { blockExternalRequests } from "./browser";
  27  |
  28  | // The browser's own network log for a deliberately-provoked rejection. Chromium
  29  | // writes one `console.error` per non-2xx fetch, so a spec that PROVES a 400 comes
  30  | // back cannot also assert an empty console. This is the narrowest possible
  31  | // allowance — one exact string, for the exact status the test itself asks for — and
  32  | // it never hides an application error: a page error still fails, and so does any
  33  | // other console line. Every other spec keeps the unfiltered gate.
  34  | const EXPECTED_REJECTION_LOG =
  35  |   "console.error: Failed to load resource: the server responded with a status of 400 (Bad Request)";
  36  |
  37  | /** Collect every console error + page error for a fail-on-any assertion at the end. */
  38  | function watchForErrors(page: Page): string[] {
  39  |   const problems: string[] = [];
  40  |
  41  |   page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  42  |   page.on("console", (message: ConsoleMessage) => {
  43  |     if (message.type() === "error") {
  44  |       problems.push(`console.error: ${message.text()}`);
  45  |     }
  46  |   });
  47  |
  48  |   return problems;
  49  | }
  50  |
  51  | /**
  52  |  * Open a home-page dialog whose trigger is a plain button, state-safely. The trigger
  53  |  * TOGGLES, so a naive click-and-check loop can alternate open/closed forever; each
  54  |  * attempt therefore resets to a known CLOSED state before clicking. Until React
  55  |  * hydrates the click is inert, which is exactly what the retry absorbs.
  56  |  */
  57  | async function openDialog(page: Page, trigger: string, heading: string): Promise<void> {
  58  |   const dialog = page.getByRole("dialog").filter({ hasText: heading });
  59  |
  60  |   await expect(async () => {
  61  |     await page.keyboard.press("Escape");
  62  |     await expect(dialog).toBeHidden({ timeout: 2000 });
  63  |     await page.getByRole("button", { name: trigger }).first().click();
  64  |     await expect(dialog).toBeVisible({ timeout: 3000 });
  65  |   }).toPass({ timeout: 60_000 });
  66  | }
  67  |
  68  | test("the newsletter form reaches the subscribe contract and shows its verdict", async ({
  69  |   page,
  70  | }) => {
  71  |   await blockExternalRequests(page);
  72  |
  73  |   const problems = watchForErrors(page);
  74  |
> 75  |   await page.goto("/", { waitUntil: "networkidle" });
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  76  |   await openDialog(page, "Newsletter", "The weekly newsletter");
  77  |
  78  |   // `a@b.c` is deliberate: the browser's own `type="email"` validation ACCEPTS it, so
  79  |   // the form actually submits, and the SERVER rejects it (`validateInput` requires at
  80  |   // least two characters after the final dot). That makes this a true round trip —
  81  |   // form → POST /newsletter → the contract's validation → the message on screen —
  82  |   // rather than a client-side guard that never leaves the page. It also costs no
  83  |   // rate-limit slot: validation runs ahead of the limiter.
  84  |   const emailField = page.getByLabel("Email", { exact: true });
  85  |
  86  |   await emailField.fill("a@b.c");
  87  |   await page.getByRole("button", { name: "Get on the list" }).click();
  88  |   await expect(page.getByText("Enter a valid email address.")).toBeVisible({ timeout: 15_000 });
  89  |
  90  |   // The spam gate, end to end. The honeypot is a real field in the DOM (visually
  91  |   // hidden, out of the tab order) that only a bot fills; filling it makes an
  92  |   // otherwise-perfect submission a 400, and the address never reaches the list. A
  93  |   // human's answer would have been "Welcome to the mothership".
  94  |   await page.locator("#newsletter-website").fill("definitely-a-bot");
  95  |   await emailField.fill(`e2e_${Date.now()}@example.invalid`);
  96  |   await page.getByRole("button", { name: "Get on the list" }).click();
  97  |   await expect(page.getByText("Invalid request")).toBeVisible({ timeout: 15_000 });
  98  |   await expect(page.getByText("Welcome to the mothership")).toHaveCount(0);
  99  |
  100 |   expect(
  101 |     problems.filter((problem) => problem !== EXPECTED_REJECTION_LOG),
  102 |     `expected a clean console apart from the provoked 400s, saw:\n${problems.join("\n")}`,
  103 |   ).toEqual([]);
  104 | });
  105 |
  106 | test("the submission dialog hydrates and refuses to search on nothing", async ({ page }) => {
  107 |   await blockExternalRequests(page);
  108 |
  109 |   const problems = watchForErrors(page);
  110 |
  111 |   await page.goto("/", { waitUntil: "networkidle" });
  112 |   await openDialog(page, "Submit a track", "Search Spotify, pick the match");
  113 |
  114 |   // The dialog opens on the SEARCH step and offers no way to send until a candidate
  115 |   // is picked — so this is as far as the UI exposes the submission path without a
  116 |   // live Spotify. An empty search is refused in the browser, before any request.
  117 |   await expect(page.getByRole("button", { name: "Send for review" })).toHaveCount(0);
  118 |   await page.getByRole("button", { name: "Search" }).click();
  119 |   await expect(page.getByText("Enter a Spotify URL or track search.")).toBeVisible({
  120 |     timeout: 15_000,
  121 |   });
  122 |
  123 |   expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
  124 | });
  125 |
```
