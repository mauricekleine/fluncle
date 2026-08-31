// SEARCH — the three halves of finding something in the archive.
//
// Fluncle's search is not one surface. It is a ⌘K COMMAND DIALOG (the accelerator,
// `components/search/search-command.tsx`), the `/search` PAGE (the persistent,
// linkable, server-rendered surface, `routes/search.tsx`), and the `/tracks` HUB
// (the whole list, narrowed by filter axes that live in the URL). This spec proves
// all three, in the `findings.spec.ts` shape: SSR, identity over seeded fixtures,
// hydration of a genuinely client-only control, and a clean console.
//
// ── WHAT `/search` IS FOR, AND WHAT THAT MAKES TESTABLE ──────────────────────
// A palette has no URL. So what it shows cannot be shared, cannot survive a cold
// reload, and cannot be walked back to. The page carries the WHOLE query state in
// `?q=` — one param, because the resolver takes one string — which turns every one
// of the four query kinds into a shareable, reload-safe path. The assertions below
// are that property, checked once per kind, plus the handoff that keeps the palette
// the fast way in rather than the only way in.
//
// ── THE TIER-4 RAIL ──────────────────────────────────────────────────────────
// The resolver has four tiers (docs/search.md): coordinate → exact entity → bare
// token (FTS5) → sonic → a small LLM that emits FILTERS. The fourth calls a real
// model, and `blockExternalRequests` stubs the BROWSER's requests, never the
// Worker's — so a tier-4 query used to make this suite non-hermetic, and the rail
// was "never write a query that reaches it".
//
// The rail is now held by the ENVIRONMENT instead, which is both stronger and
// smaller: `.dev.vars.e2e.tpl` carries NO `OPENROUTER_API_KEY`, so `translateQuery`
// short-circuits on "unprovisioned" and returns null before a socket is opened. A
// tier-4 query therefore degrades to full text and answers deterministically — the
// documented degradation contract, which is also the local-dev steady state. That
// is what lets the STRUCTURED query below be tested at all, rather than avoided.
//
// The tiers each query here exercises:
//   - a COORDINATE (`701.1.0A`) — tier 1, returns the finding or the "no finding
//     at that coordinate" empty, either way it returns;
//   - an EXACT ENTITY (`Nova Kestrel`) — tier 2, returns on a hit;
//   - a BARE TOKEN (`Aurora`, `zzzqqx`) — tier 3, returns even with zero rows,
//     which is what makes `zzzqqx` a deterministic way to reach the empty state;
//   - a SONIC phrase (`tracks that sound like Synthetic Aurora`) — tier 3½, a
//     regex and a `vector_distance_cos` scan over the seeded embeddings;
//   - a STRUCTURED sentence — tier 4, unprovisioned, degrading to full text.

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { blockExternalRequests } from "./browser";
import { SEEDED_FINDING_TITLES, SEEDED_SONIC_ANCHOR, SEEDED_SONIC_NEIGHBOUR } from "./seed";

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

  // (1) SSR — the way IN is server-rendered, so a no-JS reader still sees search exists. On the
  // front door that way in is the page's own seeding field (the colophon glyph stands down there,
  // since two doors to one action on one screen answer to one name); on every other public page it
  // is the colophon's quiet trigger. Both carry the same accessible name, so this assertion holds
  // wherever it is pointed.
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
  // its own heading — the thing searched for, offered as somewhere to go. EXACT, because
  // the non-exact form also matches any track ROW crediting the artist once the FTS tier
  // resolves — a race that has flaked this assertion twice (2026-07-29, 2026-07-31) as a
  // strict-mode violation when both options render.
  await typeQuery(page, SEEDED_ARTIST_NAME);
  await expect(page.getByRole("option", { exact: true, name: SEEDED_ARTIST_NAME })).toBeVisible();

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

// ── `/search` — THE PERSISTENT SURFACE ───────────────────────────────────────
//
// Everything below is one property, checked from every angle that can break it: the URL is the
// whole query state. If that holds, a result set survives a share, a cold reload, and the back
// button, for every kind of query the resolver can answer — and none of those is testable against
// a palette, because a palette has no URL to test.

/** Where the retained viewport evidence lands. Gitignored (`apps/web/.dev/`), operator-overridable. */
const SEARCH_SHOT_DIR = process.env.SEARCH_SHOT_DIR ?? join(process.cwd(), ".dev", "search");

/** The two widths the acceptance criteria name. Desktop first — it is the reading width. */
const DESKTOP = { height: 900, width: 1440 };
const MOBILE = { height: 844, width: 390 };

/**
 * THE FOUR QUERY KINDS, each with something that must be on the page when it answers.
 *
 * One per resolution tier, so "the URL carries the query state" is proven for the whole resolver
 * rather than for the easy tier. The STRUCTURED one reaches tier 4 and degrades (no key in the e2e
 * env, see this file's header), which is a real answer and the one production falls back to when
 * the vendor is down — so its expectation is the honesty line AND real rows, never an error.
 */
const QUERY_KINDS = [
  {
    expect: FIRST_FINDING_TITLE,
    kind: "text",
    query: "Aurora",
  },
  {
    expect: SEEDED_ARTIST_NAME,
    kind: "entity",
    query: SEEDED_ARTIST_NAME,
  },
  {
    expect: "Reading by name only right now.",
    kind: "structured",
    query: `${SEEDED_ARTIST_NAME} tracks in A minor`,
  },
  {
    expect: SEEDED_SONIC_NEIGHBOUR.title,
    kind: "sonic",
    query: `tracks that sound like ${SEEDED_SONIC_ANCHOR.title}`,
  },
] as const;

test("the whole query state lives in the URL, for every kind of query", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  for (const { expect: expected, kind, query } of QUERY_KINDS) {
    const url = `/search?q=${encodeURIComponent(query)}`;

    // (1) SSR — the ANSWER is in the server HTML, not fetched after hydration. This is what makes
    // the surface shareable to a crawler and readable with JS off, and it is the difference from
    // the palette rather than a nicety.
    const rawHtml = await (await page.request.get(url)).text();
    expect(rawHtml, `${kind}: the SSR HTML should already carry the answer`).toContain(expected);

    // (2) A COLD LOAD of that URL renders the same answer — no client state, no prior navigation.
    const response = await page.goto(url, { waitUntil: "networkidle" });
    expect(response?.status(), `${kind}: a shared URL must load`).toBe(200);
    await expect(page.getByText(expected).first()).toBeVisible();

    // (3) The field is seeded FROM the URL, so what the reader sees typed is what produced the
    // answer under it — a page whose field and results disagree cannot be trusted or corrected.
    await expect(page.locator("#search-page-q")).toHaveValue(query);

    // (4) A RELOAD is identical. The loader re-reads `?q=` through `validateSearch`; nothing is
    // held in component state, so nothing is lost.
    await page.reload({ waitUntil: "networkidle" });
    await expect(page).toHaveURL(
      new RegExp(`q=${encodeURIComponent(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    await expect(page.getByText(expected).first()).toBeVisible();
  }

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("a coordinate resolves on the page WITHOUT bouncing the URL away", async ({ page }) => {
  await blockExternalRequests(page);

  // The palette may follow a coordinate's `redirect`; it has no URL to preserve. A persistent
  // surface must not — bouncing would make this link un-shareable and turn the back button into a
  // trap (back to the search, forward to the redirect, forever). The finding comes back as the
  // first ROW instead, and the row itself is the link.
  await page.goto(`/search?q=${FIRST_FINDING_COORDINATE}`, { waitUntil: "networkidle" });

  await expect(page).toHaveURL(new RegExp(`/search\\?q=${FIRST_FINDING_COORDINATE}$`));
  await expect(page.getByRole("link", { name: new RegExp(FIRST_FINDING_TITLE) })).toBeVisible();
  await expect(page.getByText(FIRST_FINDING_COORDINATE).first()).toBeVisible();
});

test("back and forward walk the searches a reader actually made", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  await page.goto("/search", { waitUntil: "networkidle" });

  const field = page.locator("#search-page-q");

  // GATE ON HYDRATION FIRST, and this one is load-bearing rather than boilerplate. The form is a
  // real `<form method="get">`, so a submit BEFORE React attaches is a full-document navigation —
  // which puts a document entry in the history and hands the back step to Chromium's classic form
  // restoration, where the field is restored to whatever was last typed instead of the URL's query.
  // That is the browser's own convention and not something to fight; it is simply not the path this
  // test is about. The palette is client-only, so opening it proves React has attached, after which
  // every submit below is a pushState and the history is the router's.
  //
  // The palette is located by its DIALOG, not by its placeholder: this page's own field carries the
  // same placeholder (one action, one phrasing), so a placeholder locator matches a control that is
  // always visible and could never report the dialog as closed.
  const palette = page.getByRole("dialog");

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden({ timeout: 2000 });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  // Submitting commits ONE history entry per query — the field is deliberately not
  // debounce-navigated, because a navigate per keystroke would bury the back button under the
  // letters of a word nobody meant to search for.
  await field.fill("Aurora");
  await field.press("Enter");
  await expect(page).toHaveURL(/q=Aurora/);
  await expect(page.getByText(FIRST_FINDING_TITLE).first()).toBeVisible();

  await field.fill(SEEDED_ARTIST_NAME);
  await field.press("Enter");
  await expect(page).toHaveURL(/Kestrel/);
  // WAIT FOR THE SECOND ANSWER before stepping back, and not out of politeness: the URL commits as
  // soon as the navigation starts, while the loader is still in flight, so a back step taken on the
  // URL alone cancels a load that never rendered — and then "back" has nothing to undo, the field
  // still holds what was typed, and the test measures its own race rather than the surface.
  await expect(page.getByRole("link", { exact: true, name: SEEDED_ARTIST_NAME })).toBeVisible();

  // BACK returns the first search whole: the URL, the field, and the rows under it.
  await page.goBack();
  await expect(page).toHaveURL(/q=Aurora/);
  await expect(field).toHaveValue("Aurora");
  await expect(page.getByText(FIRST_FINDING_TITLE).first()).toBeVisible();

  // FORWARD returns the second one, just as whole.
  await page.goForward();
  await expect(page).toHaveURL(/Kestrel/);
  await expect(page.getByRole("link", { exact: true, name: SEEDED_ARTIST_NAME })).toBeVisible();
  await expect(field).toHaveValue(SEEDED_ARTIST_NAME);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("⌘K stays the accelerator on every public page and HANDS OFF to the surface", async ({
  page,
}) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // A deep page, not the front door: the point of the shortcut is that it is one keystroke from
  // ANY public surface, and the colophon glyph is the door that rides every one of them.
  await page.goto("/log", { waitUntil: "networkidle" });

  const dialogInput = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  // The listener lives on the provider in the public chrome, so the keystroke works here.
  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialogInput).toBeHidden({ timeout: 2000 });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialogInput).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  await dialogInput.fill("Aurora");

  // The palette still answers, fast, in place — it is NOT replaced by the page.
  await expect(page.getByRole("option", { name: new RegExp(FIRST_FINDING_TITLE) })).toBeVisible();

  // And the last row of the answer is the door to the persistent surface, carrying the query the
  // reader already typed.
  const handoff = page.getByRole("option", { name: "Open this search as a page" });
  await expect(handoff).toBeVisible();
  await handoff.click();

  await expect(page).toHaveURL(/\/search\?q=Aurora$/);
  await expect(page.locator("#search-page-q")).toHaveValue("Aurora");
  await expect(page.getByText(FIRST_FINDING_TITLE).first()).toBeVisible();

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the handoff is offered even when the palette found nothing", async ({ page }) => {
  await blockExternalRequests(page);

  await page.goto("/log", { waitUntil: "networkidle" });

  const dialogInput = page.getByPlaceholder("A name, a coordinate, or the sound of it…");

  await expect(async () => {
    await page.keyboard.press("Escape");
    await expect(dialogInput).toBeHidden({ timeout: 2000 });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialogInput).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  await dialogInput.fill(NO_MATCH_TOKEN);

  // A miss in a palette is precisely when a reader wants the surface that can explain itself and
  // hold the query in a URL — so the empty line and the door are shown together.
  await expect(page.getByText("Nothing out here.")).toBeVisible();
  await expect(page.getByRole("option", { name: "Open this search as a page" })).toBeVisible();
});

test("the zero state teaches with real, followable example queries", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // (1) SSR — the examples are anchors in the server HTML, so a crawler follows them into the
  // archive. That is the whole reason they are links rather than buttons that fill a field.
  const rawHtml = await (await page.request.get("/search")).text();
  expect(rawHtml).toContain("Nothing typed yet.");
  expect(rawHtml).toContain('href="/search?q=netsky"');

  await page.goto("/search", { waitUntil: "networkidle" });

  const examples = page.locator(".search-page-examples a");
  await expect(examples).toHaveCount(4);

  // Following one lands on the surface with that exact query committed to the URL. (Against the
  // synthetic fixtures the archive holds no Netsky; the guarantee that each example returns rows
  // against the LIVE archive is `SEARCH_EXAMPLES`' one-owner contract, docs/search.md.)
  await examples.first().click();
  await expect(page).toHaveURL(/\/search\?q=netsky$/);
  await expect(page.locator("#search-page-q")).toHaveValue("netsky");

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the empty states name what happened and offer a way back", async ({ page }) => {
  await blockExternalRequests(page);

  const problems = watchForErrors(page);

  // A name the archive does not hold. Named WITH the query, so the reader can see what was asked.
  await page.goto(`/search?q=${NO_MATCH_TOKEN}`, { waitUntil: "networkidle" });
  await expect(page.getByText(`Nothing out here for “${NO_MATCH_TOKEN}”.`)).toBeVisible();

  // The way back is a real link, and it works.
  const wayBack = page.getByRole("link", { name: "dig through every track I hold" });
  await expect(wayBack).toBeVisible();

  // And the four examples are offered again, so the reader is never left at a dead end.
  await expect(page.locator(".search-page-examples a")).toHaveCount(4);

  // A COORDINATE that names no finding is a different fact, and is said differently — collapsing
  // the two would throw away the only useful thing the resolver learned.
  await page.goto("/search?q=999.9.9Z", { waitUntil: "networkidle" });
  await expect(page.getByText("No finding at that coordinate.")).toBeVisible();
  await expect(page.getByText("Nothing out here for")).toBeHidden();

  await wayBack.click();
  await expect(page).toHaveURL(/\/tracks$/);

  expect(problems, `expected a clean console, saw:\n${problems.join("\n")}`).toEqual([]);
});

test("the surface is fully keyboard-operable with a visible focus indicator", async ({ page }) => {
  await blockExternalRequests(page);
  await page.goto(`/search?q=${encodeURIComponent("Aurora")}`, { waitUntil: "networkidle" });

  // Every control the PAGE owns must be reachable by Tab, and must paint a real ring when it is.
  // (The chrome's own controls are covered by the other public specs.)
  const targets = [".search-page-input", ".search-page-submit", ".search-page-row"];
  const found = new Set<string>();

  for (let step = 0; step < 150 && found.size < targets.length; step += 1) {
    await page.keyboard.press("Tab");

    const matched = await page.evaluate(
      (selectors) =>
        selectors.filter((selector) => document.activeElement?.matches(selector) === true),
      targets,
    );

    for (const selector of matched) {
      found.add(selector);

      // The canon focus affordance is an Eclipse-Gold ring, so a focused control must paint a real
      // outline (or a ring drawn as a box-shadow) — never `none`. The input hands its own ring to
      // the field wrapper it sits in, so that case reads the wrapper.
      const visible = await page.evaluate((inputSelector) => {
        const active = document.activeElement;

        if (!active) {
          return { outlineStyle: "none", outlineWidth: "0px", shadow: "none" };
        }

        const painted =
          active.matches(inputSelector) && active.parentElement ? active.parentElement : active;
        const style = getComputedStyle(painted);

        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          shadow: style.boxShadow,
        };
      }, ".search-page-input");

      const hasRing =
        (visible.outlineStyle !== "none" && Number.parseFloat(visible.outlineWidth) > 0) ||
        visible.shadow !== "none";

      expect(
        hasRing,
        `${selector} must paint a visible focus indicator, saw ${JSON.stringify(visible)}`,
      ).toBe(true);
    }
  }

  expect(
    [...found].sort(),
    `every control must be reachable by Tab; missing ${targets
      .filter((target) => !found.has(target))
      .join(", ")}`,
  ).toEqual([...targets].sort());

  // And the keyboard OPERATES it: typing into the field and pressing Enter runs the search, with
  // no pointer anywhere near it.
  await page.locator(".search-page-input").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(SEEDED_ARTIST_NAME);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/Kestrel/);
});

test.describe("reduced motion", () => {
  test("every transition on the surface is genuinely absent under prefers-reduced-motion", async ({
    page,
  }) => {
    await blockExternalRequests(page);
    // Emulated on the PAGE rather than declared as a fixture option, so the preference is set by
    // this test and cannot be silently lost to fixture layering.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/search?q=${encodeURIComponent("Aurora")}`, { waitUntil: "networkidle" });

    const reduced = await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    expect(reduced, "the context should be running with reduced motion").toBe(true);

    // COMPUTED style, not the presence of a media query in the sheet: this is the assertion a gate
    // placed above the rule it means to neutralize would fail.
    const moving = await page.evaluate(() => {
      const selectors = [
        ".search-page-field",
        ".search-page-input",
        ".search-page-submit",
        ".search-example",
        ".search-page-row",
        ".search-cover",
      ];
      const offenders: string[] = [];

      for (const selector of selectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          const style = getComputedStyle(element);
          const duration = [style.transitionDuration, style.animationDuration].join(" ");

          if (/[1-9]/.test(duration)) {
            offenders.push(
              `${selector} → transition ${style.transitionDuration}, animation ${style.animationDuration}`,
            );
          }
        }
      }

      return offenders;
    });

    expect(moving, `these still move under reduce:\n${moving.join("\n")}`).toEqual([]);

    // The ambient cosmos drift on the backdrop is gated the other way (`no-preference`), so it must
    // be off here too.
    const backdrop = await page.evaluate(
      () => getComputedStyle(document.body, "::before").animationName,
    );
    expect(backdrop, "the cosmos drift must not run under reduce").toBe("none");
  });
});

test("every line of text clears WCAG AA against what is actually behind it", async ({ page }) => {
  await blockExternalRequests(page);
  await page.goto(`/search?q=${encodeURIComponent("Aurora")}`, { waitUntil: "networkidle" });

  // The composite is computed the way an automated checker computes it: walk each text node's
  // ancestors, alpha-composite their background colours down onto the document's own base, and take
  // the WCAG contrast ratio against the resolved foreground. Same method as `front-door.spec.ts`,
  // pointed at this surface's own plate.
  const failures = await page.evaluate(() => {
    type Rgba = { a: number; b: number; g: number; r: number };

    function parse(color: string): Rgba {
      const match = /rgba?\(([^)]+)\)/.exec(color);

      if (!match?.[1]) {
        return { a: 0, b: 0, g: 0, r: 0 };
      }

      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));

      return { a: parts[3] ?? 1, b: parts[2] ?? 0, g: parts[1] ?? 0, r: parts[0] ?? 0 };
    }

    function over(top: Rgba, bottom: Rgba): Rgba {
      const a = top.a + bottom.a * (1 - top.a);

      if (a === 0) {
        return { a: 0, b: 0, g: 0, r: 0 };
      }

      const blend = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;

      return { a, b: blend(top.b, bottom.b), g: blend(top.g, bottom.g), r: blend(top.r, bottom.r) };
    }

    function luminance({ b, g, r }: Rgba): number {
      const channel = (value: number): number => {
        const scaled = value / 255;

        return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };

      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    }

    function ratio(fg: Rgba, bg: Rgba): number {
      const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);

      return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
    }

    const base = parse(getComputedStyle(document.documentElement).backgroundColor);
    const problems: string[] = [];
    const root = document.querySelector(".search-page");

    if (!root) {
      return ["no .search-page on the document"];
    }

    for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      const own = Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
      );

      if (!own || element.offsetParent === null) {
        continue;
      }

      const style = getComputedStyle(element);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseFloat(style.fontWeight);
      // WCAG "large text": ≥24px, or ≥18.66px at bold. Large text clears at 3:1, the rest 4.5:1.
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const floor = large ? 3 : 4.5;

      let background: Rgba = { a: 0, b: 0, g: 0, r: 0 };
      let node: Element | null = element;

      while (node) {
        background = over(background, parse(getComputedStyle(node).backgroundColor));

        if (background.a >= 0.999) {
          break;
        }

        node = node.parentElement;
      }

      const composited = over(background, { ...base, a: 1 });
      const measured = ratio(parse(style.color), composited);

      if (measured < floor) {
        problems.push(
          `${element.className || element.tagName} "${(element.textContent ?? "").trim().slice(0, 40)}" — ${measured.toFixed(2)}:1, needs ${floor}:1`,
        );
      }
    }

    return problems;
  });

  expect(failures, `these lines fail WCAG AA:\n${failures.join("\n")}`).toEqual([]);
});

test("the surface reads at both widths, and the evidence is retained", async ({ page }) => {
  await blockExternalRequests(page);

  mkdirSync(SEARCH_SHOT_DIR, { recursive: true });

  for (const [name, viewport] of [
    ["desktop-1440x900", DESKTOP],
    ["mobile-390x844", MOBILE],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto(`/search?q=${encodeURIComponent("Aurora")}`, { waitUntil: "networkidle" });

    // The field, the count, and the results all render with height — a control that collapsed to
    // zero at one width is not "responsive", it is missing.
    for (const selector of [".search-page-form", ".search-page-matchline", ".search-page-rows"]) {
      const part = page.locator(selector).first();
      await expect(part, `${selector} should render at ${name}`).toBeVisible();
      const box = await part.boundingBox();
      expect(box?.height ?? 0, `${selector} should have height at ${name}`).toBeGreaterThan(0);
    }

    // Nothing bleeds sideways. The mobile width is where a field beside a submit button breaks.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `no horizontal bleed at ${name}`).toBeLessThanOrEqual(1);

    // The submit target is thumb-sized at both widths (the WCAG 2.5.8 24px floor, cleared well).
    const submit = await page.locator(".search-page-submit").boundingBox();
    expect(
      submit?.height ?? 0,
      `the submit control should be a real target at ${name}`,
    ).toBeGreaterThanOrEqual(40);

    await page.screenshot({ fullPage: true, path: join(SEARCH_SHOT_DIR, `${name}.png`) });
  }

  // And the zero state reads at the narrow width too — it is the first thing a stranger sees.
  await page.setViewportSize(MOBILE);
  await page.goto("/search", { waitUntil: "networkidle" });
  await expect(page.locator(".search-page-examples a").first()).toBeVisible();
  await page.screenshot({ fullPage: true, path: join(SEARCH_SHOT_DIR, "mobile-390x844-zero.png") });
});
