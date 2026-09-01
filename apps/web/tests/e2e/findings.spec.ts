// The archive page (`/findings`) — the cover-led feed of every certified finding.
//
// It proves the four things every public-page spec should prove, so a follow-up
// spec can copy this shape (see `tests/e2e/README.md`):
//   1. SSR — the server returns 200 AND the seeded findings are in the initial
//      HTML (what a crawler with no JavaScript sees; the whole point of SSRing the
//      feed, per the route comment in `src/routes/findings.tsx`).
//   2. Identity — the page renders the SEEDED finding titles (assert on identity,
//      not counts, so the check does not rot as the fixture set grows).
//   3. Hydration — a genuinely client-only control responds to a click (a finding
//      row's links menu opens; a click before hydration no-ops, so we retry until
//      one sticks, mirroring the gate in `tests/browser/shell-smoke.ts`).
//   4. Cleanliness — zero console errors and zero page errors. We own the whole
//      environment, so there should be none; any is a real regression.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_FINDING_TITLES, SEEDED_MIXTAPE_TITLE, SEEDED_STORY_FINDING } from "./seed";

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

test("the archive page SSRs the seeded findings, hydrates, and logs no errors", async ({
  page,
}) => {
  // Keep the run hermetic: a few product URLs (a mixtape row's cover) are hardcoded
  // to the absolute prod host and would 404 against synthetic fixtures. Stubbing any
  // non-local request isolates the suite without weakening the no-errors gate below.
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // (1) SSR — the raw server response, before any client JS runs, already carries
  // the findings. `page.request` does no rendering, so this is the crawler's view.
  const rawHtml = await (await page.request.get("/findings")).text();
  for (const title of SEEDED_FINDING_TITLES) {
    expect(rawHtml, `SSR HTML should contain "${title}"`).toContain(title);
  }

  // The navigation itself returns 200. `networkidle` lets the Vite DEV module
  // graph finish loading — the client bundle is compiled on demand here, so
  // hydration lands seconds after `load`.
  const response = await page.goto("/findings", { waitUntil: "networkidle" });
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

test("the cover backdrop can paint: body stays transparent under the z:-2 pseudo-element", async ({
  page,
}) => {
  // The regression this pins: an opaque body background paints ABOVE a negative
  // z-index fixed child in the root stacking context, erasing the sitewide cover
  // backdrop while every rule still "applies" in devtools (2026-07-27; the
  // Fumadocs preflight's body background won the cascade once #920 scoped
  // Scalar's sheet away). See the paint contract beside `body::before` in
  // src/styles.css.
  await blockExternalRequests(page);
  await page.goto("/findings");

  const paint = await page.evaluate(() => ({
    backdropImage: getComputedStyle(document.body, "::before").backgroundImage,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }));

  expect(paint.bodyBackground).toBe("rgba(0, 0, 0, 0)");
  expect(paint.backdropImage).toContain("fluncle-cover-no-text");
});

test("a finding with footage opens its story OVER the feed, never navigating away", async ({
  page,
}) => {
  // The Stories affordance on this page has two openers — the cover ring and a row's
  // artwork (`TrackRow`, whose only consumer is this route) — and both are gated on a
  // finding carrying `video_url`, which `SEEDED_STORY_FINDING` is the fixture for.
  //
  // The regression this pins: the opener must target `/findings`, the route that owns
  // the `?story=` param and mounts the dialog. `/` is the front door and takes no
  // params — a `?story=` there is answered by a 301 to the standalone `/log/<id>`
  // page, so an opener pointed at `/` still "works" in the sense of resolving while
  // silently replacing the dialog-over-the-feed with a full navigation away from it.
  // Asserting the dialog is open AND the feed is still mounted behind it is what
  // separates the two; a status code cannot.
  await blockExternalRequests(page);

  // The story clip is stubbed with an empty 200 (it is an external host), so the
  // <video> reports a media-load failure. That is the stub talking, not the page, so
  // this ONE spec allows exactly that and nothing else — every other error still fails.
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    const text = message.text();
    const isTheStubbedClip =
      text.includes(SEEDED_STORY_FINDING.videoUrl) ||
      text.includes("Failed to load resource") ||
      text.includes("MEDIA_ELEMENT_ERROR") ||
      text.includes("no supported source");

    if (message.type() === "error" && !isTheStubbedClip) {
      problems.push(`console.error: ${text}`);
    }
  });

  // A direct load of the dialog's own URL is a 200 on this route, with no redirect
  // hop — the mirror of `/?story=`'s 301 that front-door.spec.ts pins.
  const direct = await page.request.get(`/findings?story=${SEEDED_STORY_FINDING.logId}`, {
    maxRedirects: 0,
  });
  expect(direct.status(), "/findings?story= should be served, never redirected").toBe(200);

  await page.goto("/findings", { waitUntil: "networkidle" });

  // TrackRow is progressively enhanced: before React hydrates, its masked Link is
  // a real `/log/<id>` anchor. Clicking it early therefore leaves this route and
  // cannot be retried safely. DiscoveryListener sets this root marker in an effect,
  // after the router's delegated click handler has been committed.
  await expect(
    page.locator("html[data-discovery-listening]"),
    "root hydration should attach the router handler before the story link is clicked",
  ).toBeAttached({ timeout: 30_000 });

  // The fixture reaches the component: the row's artwork really is a play link.
  const play = page.locator("a.track-play");
  await expect(play, "the seeded finding with footage should render a play link").toHaveCount(1);

  const dialog = page.locator('[role="dialog"][aria-label="Stories"]');
  const feed = page.locator("a.cover-story");

  await play.click();
  await expect(dialog).toBeVisible();

  // OVER the feed, not instead of it: the archive page is still mounted behind the
  // dialog. An opener pointed at `/` would have redirected to the standalone log
  // page, taking the feed with it.
  await expect(feed).toBeAttached();
  // And the URL wears the mask the opener declares, so a refresh or a share lands on
  // the standalone plate.
  expect(page.url()).toContain(`/log/${SEEDED_STORY_FINDING.logId}`);

  await page.keyboard.press("Escape");

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
