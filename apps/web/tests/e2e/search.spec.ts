// SEARCH — the two halves of finding something in the archive.
//
// Fluncle's search is not one surface. It is a ⌘K COMMAND DIALOG (the free-text
// resolver, `components/search/search-command.tsx`) and the `/tracks` HUB (the
// whole list, narrowed by filter axes that live in the URL). This spec proves
// both, in the `home.spec.ts` shape: SSR, identity over seeded fixtures,
// hydration of a genuinely client-only control, and a clean console.
//
// ── THE ONE RAIL THIS SPEC IS BUILT AROUND ───────────────────────────────────
// The resolver has four tiers (docs/search.md): coordinate → exact entity →
// bare token (FTS5) → a small LLM that emits FILTERS. **Tier 4 must never run
// here.** `.dev.vars.e2e.tpl` carries a deliberately-fake `OPENROUTER_API_KEY`,
// so `translateQuery` does not short-circuit on "unprovisioned" — it would issue
// a REAL fetch to openrouter.ai from the Worker, which `blockExternalRequests`
// cannot see (it stubs the BROWSER's requests, never the server's). A tier-4
// query would therefore make this suite non-hermetic and flaky.
//
// So every query below is chosen to be answered by a tier that returns
// unconditionally, before the model is ever reached (`server/search.ts`):
//   - a COORDINATE (`701.1.0A`) — tier 1 returns the finding or the "no finding
//     at that coordinate" empty, either way it returns;
//   - an EXACT ENTITY (`Nova Kestrel`) — tier 2 returns on a hit;
//   - a BARE TOKEN, i.e. a query that tokenizes to exactly ONE word — tier 3
//     `if (isBareToken(q)) { … return … }` returns even with zero rows. That is
//     what makes `zzzqqx` a safe way to reach the dialog's empty state: it is a
//     MISS inside a deterministic tier, not a fall-through to the model.
// A multi-word query that names no entity (say "quiet tracks from last year")
// would fall through to tier 4 — that is the wrong query for this spec.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { blockExternalRequests } from "./browser";
import { SEEDED_FINDING_TITLES } from "./seed";

// The graph entity seeded in `seed.ts` and wired to the first finding — the
// exact-entity (tier 2) target, and the label filter's value on the hub.
const SEEDED_ARTIST_NAME = "Nova Kestrel";
const SEEDED_LABEL_NAME = "Driftwave Audio";

// The first finding: "Synthetic Aurora" at 701.1.0A. `Aurora` is a bare token
// that FTS5 indexed from its title (tier 3); the coordinate names it (tier 1).
const FIRST_FINDING_TITLE = SEEDED_FINDING_TITLES[0];
const FIRST_FINDING_COORDINATE = "701.1.0A";

// A single word no fixture contains. One token ⇒ tier 3 answers with zero rows.
const NO_MATCH_TOKEN = "zzzqqx";

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

/** Retype the dialog's query from scratch — each tier assertion starts clean. */
async function typeQuery(page: Page, query: string): Promise<void> {
  const input = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  await input.fill("");
  await input.fill(query);
}

test("search dialog resolves the deterministic tiers over the seeded archive", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // (1) SSR — the way IN is server-rendered: the trigger sits in the public
  // chrome on every page, so a no-JS reader still sees search exists.
  const rawHtml = await (await page.request.get("/")).text();
  expect(rawHtml, "SSR HTML should carry the search trigger").toContain("Search the archive");

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  // (3) Hydration — the dialog is entirely client-side: the trigger's onClick and
  // the ⌘K listener are both React-attached, so a pre-hydration click no-ops. The
  // retry is state-safe (Escape resets to CLOSED before each attempt), because
  // a naive click-and-check loop against a toggle can alternate forever.
  const trigger = page.getByRole("button", { name: "Search the archive" });
  const input = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden({ timeout: 2000 });
    await trigger.click();
    await expect(input).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  // (2) Identity — each tier, asserted on the SEEDED fixture it must return.

  // Tier 3, the bare token: one word, resolved by FTS5 over the derived index
  // (`scripts/ensure-search-index.ts` runs inside `db:migrate` at stack boot, and
  // its triggers pick up every row the seed inserts afterwards).
  await typeQuery(page, "Aurora");
  await expect(page.getByRole("option", { name: new RegExp(FIRST_FINDING_TITLE) })).toBeVisible();

  // Tier 2, the exact entity: the seeded artist comes back as a JUMP TARGET under
  // its own heading — the thing searched for, offered as somewhere to go.
  await typeQuery(page, SEEDED_ARTIST_NAME);
  await expect(page.getByRole("option", { name: SEEDED_ARTIST_NAME })).toBeVisible();

  // Tier 1, the coordinate: it names exactly one finding, and comes back AS that
  // finding (a row), never as a rendering of the URL it is about to visit.
  await typeQuery(page, FIRST_FINDING_COORDINATE);
  await expect(page.getByRole("option", { name: new RegExp(FIRST_FINDING_TITLE) })).toBeVisible();

  // The empty state, reached through a deterministic MISS (a bare token that
  // matches nothing), never through the model.
  await typeQuery(page, NO_MATCH_TOKEN);
  await expect(page.getByText("Nothing out here.")).toBeVisible();

  // (4) No console errors, no page errors — anything here is a real regression.
  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("tracks hub SSRs the archive and round-trips its filters through the URL", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // (1) SSR — `/tracks` pages server-side on purpose: nothing loads on scroll, so
  // a crawler that runs no JS walks the whole list. Every seeded finding is in
  // the initial HTML.
  const rawHtml = await (await page.request.get("/tracks")).text();
  for (const title of SEEDED_FINDING_TITLES) {
    expect(rawHtml, `SSR HTML should contain "${title}"`).toContain(title);
  }

  const response = await page.goto("/tracks", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  // (2) Identity — the rendered hub carries the seeded findings.
  for (const title of SEEDED_FINDING_TITLES) {
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  }

  // (3) Hydration + the URL round-trip. The filter pills are base-ui controls that
  // AUTO-APPLY: changing one navigates, so the URL — not component state — is the
  // single source of truth. A key filter is the honest empty case here (no fixture
  // carries a key), which makes one interaction prove three things at once: the
  // control is live, the axis lands in the URL, and the hub speaks its empty state.
  const keyPill = page.getByRole("combobox", { name: "Key: Any key" });

  await expect(async () => {
    await page.keyboard.press("Escape");
    await keyPill.click();
    await expect(page.getByRole("option", { exact: true, name: "A minor" })).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 30_000 });

  await page.getByRole("option", { exact: true, name: "A minor" }).click();

  await expect(page).toHaveURL(/[?&]key=A\+minor/);
  await expect(page.getByText("No tracks match those filters.")).toBeVisible();

  // The round trip: a reload re-reads the axis from the URL through
  // `validateSearch`, so the filter survives — the pill still reads it, and the
  // narrowed (here: empty) list is the same one.
  await page.reload({ waitUntil: "networkidle" });
  await expect(page).toHaveURL(/[?&]key=A\+minor/);
  await expect(page.getByRole("combobox", { name: "Key: A minor" })).toBeVisible();
  await expect(page.getByText("No tracks match those filters.")).toBeVisible();

  // And a filter that DOES match round-trips the same way, straight off the URL —
  // the SSR half of `validateSearch`. Every seeded finding is on this label.
  await page.goto(`/tracks?label=${encodeURIComponent(SEEDED_LABEL_NAME)}`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByRole("combobox", { name: `Label: ${SEEDED_LABEL_NAME}` })).toBeVisible();
  for (const title of SEEDED_FINDING_TITLES) {
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  }

  // (4) No console errors, no page errors.
  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});
