// The pilot public-flow spec: the home page (`/`).
//
// It proves the four things every public-page spec should prove, so a follow-up
// spec can copy this shape (see `tests/e2e/README.md`):
//   1. SSR — the server returns 200 AND the seeded findings are in the initial
//      HTML (what a crawler with no JavaScript sees; the whole point of SSRing the
//      feed, per the route comment in `src/routes/index.tsx`).
//   2. Identity — the page renders the SEEDED finding titles (assert on identity,
//      not counts, so the check does not rot as the fixture set grows).
//   3. Hydration — a genuinely client-only control responds to a click (a finding
//      row's links menu opens; a click before hydration no-ops, so we retry until
//      one sticks, mirroring the gate in `tests/browser/shell-smoke.ts`).
//   4. Cleanliness — zero console errors and zero page errors. We own the whole
//      environment, so there should be none; any is a real regression.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_FINDING_TITLES, SEEDED_MIXTAPE_TITLE } from "./seed";

// The hydration target: a FINDING's links menu (its menu always carries Spotify),
// not the mixtape's (whose menu carries Mixcloud/YouTube instead). Row triggers are
// labelled "Links for <artists> — <title>", so match on a seeded finding title.
const HYDRATION_FINDING_TITLE = SEEDED_FINDING_TITLES[0];

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

test("home page SSRs the seeded findings, hydrates, and logs no errors", async ({ page }) => {
  // Keep the run hermetic: a few product URLs (a mixtape row's cover) are hardcoded
  // to the absolute prod host and would 404 against synthetic fixtures. Stubbing any
  // non-local request isolates the suite without weakening the no-errors gate below.
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // (1) SSR — the raw server response, before any client JS runs, already carries
  // the findings. `page.request` does no rendering, so this is the crawler's view.
  const rawHtml = await (await page.request.get("/")).text();
  for (const title of SEEDED_FINDING_TITLES) {
    expect(rawHtml, `SSR HTML should contain "${title}"`).toContain(title);
  }

  // The navigation itself returns 200. `networkidle` lets the Vite DEV module
  // graph finish loading — the client bundle is compiled on demand here, so
  // hydration lands seconds after `load`.
  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  // (2) Identity — every seeded finding renders, plus the seeded mixtape (proving
  // the feed's finding + mixtape merge).
  for (const title of SEEDED_FINDING_TITLES) {
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  }
  await expect(page.getByText(SEEDED_MIXTAPE_TITLE, { exact: false }).first()).toBeVisible();

  // (3) Hydration — open a finding row's links menu. The trigger is a shadcn
  // DropdownMenu, inert until React hydrates, so a pre-hydration click does
  // nothing; the opened menu IS the proof of interactivity.
  //
  // The retry has to be state-safe: the trigger TOGGLES, so a naive click-and-check
  // loop can alternate open/closed forever. Each attempt therefore resets to a known
  // CLOSED state (Escape) before clicking, so every attempt is "closed → click →
  // expect open" and the first hydrated attempt passes.
  const trigger = page
    .getByRole("button", { name: new RegExp(`^Links for .*${HYDRATION_FINDING_TITLE}`) })
    .first();
  const spotifyItem = page.getByRole("menuitem", { name: "Spotify" }).first();

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(spotifyItem).toBeHidden({ timeout: 2000 });
    await trigger.click();
    await expect(spotifyItem).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  // (4) No console errors, no page errors — anything here is a real regression.
  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
