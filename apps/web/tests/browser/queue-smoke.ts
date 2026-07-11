// The attention-queue browser smoke (docs/admin-shell.md §Verifying): drives the
// `/admin` queue in a real Chrome as the operator, past hydration — the keyboard
// loop, an action fire, snooze, won't-do, the zero state, and the legacy
// ?stage/?mix redirect — at desktop and phone widths, screenshotting each stop.
// Run against a live dev server; `SEED=1` seeds the local dev DB with rows for
// every source around the run (two TikTok drafts, a cue-less take, a
// distributing mixtape; the drip-empty row is free) and removes them in a
// `finally`, so the run is self-contained:
//
//   BASE_URL=http://127.0.0.1:3000 OUT_DIR=/tmp/queue-smoke SEED=1 \
//     bun tests/browser/queue-smoke.ts
//
// Seeding refuses any non-local database URL. Snooze/won't-do prefs live in the
// browser context's localStorage, so a run leaves no operator state behind (the
// one action fired is a clipboard copy).
// NOTE: the working set REFILLS from the backlog, so a cleared row keeps the
// visible count constant until the backlog drains — assertions compare row
// identities, never bare counts. Exits non-zero on a failed expectation or any
// page error.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { type Locator, type Page } from "playwright-core";
import { launchBrowser, loadDevVars, newAdminPage } from "./admin";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/queue-smoke";
const SEED = process.env.SEED === "1";

const failures: string[] = [];

function watchErrors(page: Page, label: string): void {
  page.on("pageerror", (error) => failures.push(`[${label}] pageerror: ${error.message}`));
  page.on("console", (message) => {
    // Resource-load failures (a dev cover 404) aren't queue failures; real
    // console.error output is.
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      failures.push(`[${label}] console.error: ${message.text()}`);
    }
  });
}

function expect(condition: boolean, label: string): void {
  if (!condition) {
    failures.push(`expect failed: ${label}`);
  }
  console.log(`${condition ? "ok" : "FAIL"} — ${label}`);
}

/** The queue's own rows (never the sidebar's list items). */
function queueRows(page: Page): Locator {
  return page.locator('ul[aria-label="Attention queue"] > li');
}

/** The selected row's object title (first bold span of the gold-washed row). */
async function selectedTitle(page: Page): Promise<string> {
  return (
    (await page
      .locator('ul[aria-label="Attention queue"] > li[class*="bg-primary/10"] span.font-bold')
      .first()
      .textContent()) ?? ""
  ).trim();
}

// A row's identity in the DOM: its source label (the first sr-only span, from
// SOURCE_LABELS — "YouTube", "TikTok draft", "Mixtape", …) plus its title. A title
// ALONE is not an identity: one finding raises several rows (its YouTube-post row
// and its seeded TikTok-draft row carry the same title), so snoozing one leaves the
// sibling — and a title-only check reads that sibling as "still here" and fails a
// working snooze. Keyed on (source, title), the snoozed row is unambiguous.
async function rowIdentity(row: Locator): Promise<string> {
  const title = ((await row.locator("span.font-bold").first().textContent()) ?? "").trim();
  const source = ((await row.locator("span.sr-only").first().textContent()) ?? "").trim();
  return `${source} · ${title}`;
}

async function selectedRowId(page: Page): Promise<string> {
  return rowIdentity(
    page.locator('ul[aria-label="Attention queue"] > li[class*="bg-primary/10"]').first(),
  );
}

async function rowIds(page: Page): Promise<string[]> {
  const rows = queueRows(page);
  const count = await rows.count();
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    ids.push(await rowIdentity(rows.nth(index)));
  }
  return ids;
}

// Past-hydration gate. The DEFAULT selection (row 0) is server-rendered, so the
// gold wash existing proves nothing — hydration is proven the moment `j`
// actually MOVES the cursor (which needs ≥2 rows; the seeded set guarantees it).
async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  const deadline = Date.now() + 20_000;
  const start = await selectedTitle(page);

  for (;;) {
    await page.keyboard.press("j");
    await page.waitForTimeout(200);
    const current = await selectedTitle(page);
    if (current !== "" && current !== start) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        "hydration gate: the keyboard cursor never moved (React not live, or <2 queue rows — run with SEED=1)",
      );
    }
  }
}

// ── Seeding (SEED=1): rows for every source, local dev DB only ───────────────

const QA_IDS = {
  cue: "qa-queue-cue-1",
  draftFresh: "qa-queue-draft-fresh",
  draftStale: "qa-queue-draft-stale",
  mixtape: "qa-queue-mixtape",
  mixtapeLeg: "qa-queue-mix-yt",
  promoted: "qa-queue-promoted",
  submission: "qa-queue-submission",
  take: "qa-queue-take",
} as const;

function seedClient(): Client {
  loadDevVars();
  const url = process.env.TURSO_DATABASE_URL ?? "";
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
    throw new Error("SEED=1 refuses a non-local TURSO_DATABASE_URL");
  }
  return createClient({ authToken: process.env.TURSO_AUTH_TOKEN ?? "", url });
}

/** Seed one row per source: a fresh + a bounced TikTok draft (on the two newest
 * dressed findings without a TikTok post), a cue-less take, and a distributing
 * mixtape missing its Mixcloud leg. Unposted findings + the empty drip come free. */
async function seedQueueRows(db: Client): Promise<void> {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const candidates = (
    await db.execute(
      `select track_id from tracks
       where video_url is not null and log_id is not null
         and track_id not in (select track_id from social_posts where platform = 'tiktok')
       order by added_at desc limit 2`,
    )
  ).rows as unknown as { track_id: string }[];

  for (const [index, row] of candidates.entries()) {
    const fresh = index === 0;
    const at = iso(now - (fresh ? 2 : 30) * 3_600_000);
    await db.execute({
      args: [fresh ? QA_IDS.draftFresh : QA_IDS.draftStale, row.track_id, at, at],
      sql: `insert into social_posts (id, track_id, platform, status, created_at, updated_at)
            values (?, ?, 'tiktok', 'draft', ?, ?)
            on conflict(track_id, platform) do update set status = excluded.status, updated_at = excluded.updated_at`,
    });
  }

  await db.execute({
    args: [QA_IDS.take, iso(now - 6 * 86_400_000), iso(now - 6 * 86_400_000)],
    sql: `insert or replace into recordings (id, title, r2_key, created_at, updated_at, version)
          values (?, 'QA rolling take', 'recordings/qa-queue-take/set.mp4', ?, ?, 1)`,
  });
  await db.execute({
    args: [QA_IDS.promoted, iso(now - 4 * 86_400_000), iso(now - 4 * 86_400_000)],
    sql: `insert or replace into recordings (id, title, r2_key, created_at, updated_at, version)
          values (?, 'QA promoted take', 'recordings/qa-queue-promoted/set.mp4', ?, ?, 1)`,
  });
  await db.execute({
    args: [QA_IDS.cue, QA_IDS.promoted, iso(now), iso(now)],
    sql: `insert or replace into recording_cues (id, recording_id, position, title_text, artists_text, created_at, updated_at)
          values (?, ?, 1, 'Opener', 'QA', ?, ?)`,
  });
  await db.execute({
    args: [
      QA_IDS.mixtape,
      QA_IDS.promoted,
      iso(now - 2 * 86_400_000),
      iso(now - 2 * 86_400_000),
      iso(now - 2 * 86_400_000),
    ],
    sql: `insert or replace into mixtapes (id, title, status, log_id, sequence_number, recording_id, added_at, created_at, updated_at)
          values (?, 'Fluncle Drum & Bass Mixtape 99', 'distributing', '099.F.99', 999, ?, ?, ?, ?)`,
  });
  await db.execute({
    args: [
      QA_IDS.mixtapeLeg,
      QA_IDS.mixtape,
      iso(now - 86_400_000),
      iso(now - 86_400_000),
      iso(now - 86_400_000),
    ],
    sql: `insert into mixtape_social_posts (id, mixtape_id, platform, status, url, published_at, created_at, updated_at)
          values (?, ?, 'youtube', 'published', 'https://youtu.be/qa', ?, ?, ?)
          on conflict(mixtape_id, platform) do nothing`,
  });
  // A pending crew submission — the submission queue source, carrying a pre-chew
  // triage verdict so the row's advisory line renders.
  await db.execute({
    args: [QA_IDS.submission, iso(now - 3 * 3_600_000)],
    sql: `insert or replace into submissions
            (id, spotify_track_id, spotify_url, title, artists_json, source, status,
             created_at, submitter_hash, triage_verdict)
          values (?, '0000000000000000000000', 'https://open.spotify.com/track/0000000000000000000000',
             'QA Rolling Submission', '["QA Selector"]', 'web', 'pending', ?, 'qa-hash',
             'looks like a find — not yet logged')`,
  });
}

async function cleanupQueueRows(db: Client): Promise<void> {
  await db.execute(
    `delete from social_posts where id in ('${QA_IDS.draftFresh}', '${QA_IDS.draftStale}')`,
  );
  await db.execute(`delete from mixtape_social_posts where id = '${QA_IDS.mixtapeLeg}'`);
  await db.execute(`delete from mixtapes where id = '${QA_IDS.mixtape}'`);
  await db.execute(`delete from recording_cues where id = '${QA_IDS.cue}'`);
  await db.execute(`delete from recordings where id in ('${QA_IDS.promoted}', '${QA_IDS.take}')`);
  await db.execute(`delete from submissions where id = '${QA_IDS.submission}'`);
}

async function drive(browser: Awaited<ReturnType<typeof launchBrowser>>): Promise<void> {
  // ── Desktop: the loop ───────────────────────────────────────────────────────
  const desktop = await newAdminPage(browser, BASE_URL, { height: 900, width: 1440 });
  await desktop.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: BASE_URL,
  });
  const page = desktop.page;
  watchErrors(page, "desktop");

  await page.goto(`${BASE_URL}/admin`);
  await waitForHydration(page);

  expect(
    (await queueRows(page).count()) >= 3,
    `queue rows present (${await queueRows(page).count()})`,
  );
  await page.screenshot({ fullPage: true, path: join(OUT_DIR, "queue-desktop.png") });

  // The keyboard cursor: exactly one gold selection, and j moves it.
  const firstSelected = await selectedTitle(page);
  await page.keyboard.press("j");
  await page.waitForTimeout(150);
  expect((await page.locator('li[class*="bg-primary/10"]').count()) === 1, "one selected row");
  expect((await selectedTitle(page)) !== firstSelected, "j advanced the cursor");
  await page.keyboard.press("k");
  await page.waitForTimeout(150);

  // Fire the primary on a copy-caption row: non-mutating, clipboard only.
  const copyButton = page.getByRole("button", { name: "Copy caption" }).first();
  await copyButton.click();
  await page
    .getByRole("button", { name: "Copied" })
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .then(
      () => expect(true, "copy caption fired (Copied)"),
      () => expect(false, "copy caption fired (Copied)"),
    );
  const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  expect(clipboard.length > 0, "the caption reached the clipboard");

  // Snooze the selected row (s → the +3h slot): that ROW leaves the active list
  // (the working set refills behind it, so counts stay put — identities move).
  // Keyed on (source, title): the same finding also raises a sibling row with the
  // same title, so a title-only check would read the sibling as "still here".
  const toSnooze = await selectedRowId(page);
  await page.keyboard.press("s");
  await page.getByRole("button", { name: "+3h" }).click();
  await page.waitForTimeout(500);
  expect(!(await rowIds(page)).includes(toSnooze), `snoozed row left the list (${toSnooze})`);

  // Won't-do the selected row (x) — permanent, with the Undo toast.
  const toDismiss = await selectedRowId(page);
  await page.keyboard.press("x");
  await page.waitForTimeout(500);
  expect(!(await rowIds(page)).includes(toDismiss), `won't-do row left the list (${toDismiss})`);
  expect((await page.getByRole("button", { name: "Undo" }).count()) > 0, "won't-do offered Undo");

  // [Show all] reveals the backlog + the snoozed and dismissed rows.
  await page.getByRole("button", { name: "Show all" }).click();
  await page.waitForTimeout(500);
  expect(page.url().includes("all=true"), "show-all deep-links ?all");
  expect((await page.getByRole("button", { name: "Unsnooze" }).count()) > 0, "snoozed row shown");
  expect((await page.getByRole("button", { name: "Restore" }).count()) > 0, "dismissed row shown");
  await page.screenshot({ fullPage: true, path: join(OUT_DIR, "queue-show-all.png") });
  await page.getByRole("button", { name: "Show less" }).click();
  await page.waitForTimeout(400);

  // Clear the working set (x through every row) — zero must celebrate.
  const deadline = Date.now() + 60_000;
  while ((await queueRows(page).count()) > 0 && Date.now() < deadline) {
    await page.keyboard.press("x");
    await page.waitForTimeout(350);
  }
  expect((await queueRows(page).count()) === 0, "the queue drained to zero");
  await page
    .getByText("clear", { exact: true })
    .waitFor({ state: "visible", timeout: 5000 })
    .then(
      () => expect(true, "zero state celebrates (clear)"),
      () => expect(false, "zero state celebrates (clear)"),
    );
  await page.waitForTimeout(400);
  await page.screenshot({ fullPage: true, path: join(OUT_DIR, "queue-zero.png") });

  // ── The legacy board deep-links survive ────────────────────────────────────
  // `/admin` owned the findings board before the queue, so its old ?stage/?mix
  // bookmarks redirect to the board at /admin/findings. The `needs-tagging` stage
  // retired with vibe-tagging, so the board validates that legacy value back to
  // `all` (the mix filter carries over) — the point is a legacy link lands somewhere
  // sane, not that a dead stage survives.
  await page.goto(`${BASE_URL}/admin?stage=needs-tagging&mix=open`);
  await page.waitForLoadState("networkidle");
  await page
    .waitForURL(
      (url) => url.pathname === "/admin/findings" && url.searchParams.get("stage") === "all",
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  expect(
    page.url().includes("/admin/findings") &&
      page.url().includes("stage=all") &&
      page.url().includes("mix=open"),
    `?stage/?mix redirect to the board (${page.url()})`,
  );
  expect(
    (await page.getByRole("heading", { level: 1, name: "Findings" }).count()) === 1,
    "the board lives at /admin/findings",
  );

  await desktop.context.close();

  // ── Phone: fresh context (no prefs), rows back, layout intact ──────────────
  const phone = await newAdminPage(browser, BASE_URL, { height: 844, width: 390 });
  watchErrors(phone.page, "phone");
  await phone.page.goto(`${BASE_URL}/admin`);
  await phone.page.waitForLoadState("networkidle");
  expect(
    (await queueRows(phone.page).count()) >= 3,
    `phone rows present (${await queueRows(phone.page).count()})`,
  );
  const overflow = await phone.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow <= 1, `no horizontal overflow on the phone (${overflow}px)`);
  await phone.page.screenshot({ fullPage: true, path: join(OUT_DIR, "queue-phone.png") });
  await phone.context.close();
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // Seed the local dev DB around the whole run; the `finally` guarantees the
  // shared dev database is left exactly as found, even on a failing drive.
  const db = SEED ? seedClient() : undefined;
  if (db) {
    await seedQueueRows(db);
    console.log("seeded queue rows (SEED=1)");
  }

  const browser = await launchBrowser();
  try {
    await drive(browser);
  } finally {
    await browser.close();
    if (db) {
      await cleanupQueueRows(db);
      console.log("removed the seeded rows");
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log(`\nqueue smoke green — screenshots in ${OUT_DIR}`);
}

await main();
