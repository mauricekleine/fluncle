import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { type Page } from "playwright-core";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { launchBrowser, loadDevVars, newAdminPage } from "./admin";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/admin-label-outliers-smoke";
const SEED = process.env.SEED === "1";

const failures: string[] = [];

function watchErrors(page: Page, label: string): void {
  page.on("pageerror", (error) => failures.push(`[${label}] pageerror: ${error.message}`));
  page.on("console", (message) => {
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

const QA = {
  album: "qa-outliers-album",
  artist: "qa-outliers-artist",
  label: "qa-outliers-label",
  single: "qa-outliers-single",
} as const;

const QA_NAMES = {
  album: "zz QA Merry Christmas",
  single: "zz QA Lonely Single",
} as const;

const ALBUM_UNIT = `album:${QA.album}:${QA.label}`;
const SINGLE_UNIT = `track:${QA.single}`;

function seedClient(): Client {
  loadDevVars();
  const url = process.env.TURSO_DATABASE_URL ?? "";

  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
    throw new Error("SEED=1 refuses a non-local TURSO_DATABASE_URL");
  }

  return createClient({
    authToken: process.env.TURSO_AUTH_TOKEN ?? "",
    concurrency: LOCAL_DB_CONCURRENCY,
    url,
  });
}

async function cleanup(db: Client): Promise<void> {
  await db.batch(
    [
      {
        args: [ALBUM_UNIT, SINGLE_UNIT],
        sql: "delete from label_outlier_dismissals where unit_id in (?, ?)",
      },
      {
        args: [ALBUM_UNIT, SINGLE_UNIT],
        sql: "delete from label_outliers where unit_id in (?, ?)",
      },
      { args: [QA.artist], sql: "delete from track_artists where artist_id = ?" },
      {
        args: [`${QA.album}-a`, `${QA.album}-b`, QA.single],
        sql: "delete from tracks where track_id in (?, ?, ?)",
      },
      { args: [QA.album], sql: "delete from albums where id = ?" },
      { args: [QA.artist], sql: "delete from artists where id = ?" },
      { args: [QA.label], sql: "delete from labels where id = ?" },
    ],
    "write",
  );
}

async function seed(db: Client): Promise<void> {
  await cleanup(db);
  const now = new Date().toISOString();
  const outlier = `insert into label_outliers
      (unit_id, album_id, single_track_id, label_id, artist_support, fingerprint, reference,
       reference_median, score, track_count, z, first_flagged_at, updated_at)
    values (?, ?, ?, ?, 0, ?, 'label', 0.87, ?, ?, ?, ?, ?)`;

  await db.batch(
    [
      {
        args: [QA.label, "zz QA Penny Black", "qa-outliers-penny-black", now, now],
        sql: `insert into labels (id, name, slug, seed_state, created_at, updated_at)
              values (?, ?, ?, 'enabled', ?, ?)`,
      },
      {
        args: [QA.album, QA_NAMES.album, "qa-outliers-merry-christmas", now, now],
        sql: `insert into albums (id, name, slug, created_at, updated_at, discogs_styles)
              values (?, ?, ?, ?, ?, '["Holiday"]')`,
      },
      {
        args: [QA.artist, "zz QA Crooner", "qa-outliers-crooner", now, now],
        sql: "insert into artists (id, name, slug, created_at, updated_at) values (?, ?, ?, ?, ?)",
      },
      ...[
        [`${QA.album}-a`, "zz QA White Christmas", QA.album],
        [`${QA.album}-b`, "zz QA Silent Night", QA.album],
        [QA.single, QA_NAMES.single, null],
      ].map(([trackId, title, albumId]) => ({
        args: [trackId ?? "", title ?? "", albumId ?? null, QA.label],
        sql: `insert into tracks (track_id, title, artists_json, duration_ms, album_id, label_id)
              values (?, ?, '["zz QA Crooner"]', 180000, ?, ?)`,
      })),
      {
        args: [`${QA.album}-a`, QA.artist, `${QA.album}-b`, QA.artist],
        sql: "insert into track_artists (track_id, artist_id, position) values (?, ?, 0), (?, ?, 0)",
      },
      {
        args: [ALBUM_UNIT, QA.album, null, QA.label, "qa-fp-album", 0.34, 2, -15.2, now, now],
        sql: outlier,
      },
      {
        args: [SINGLE_UNIT, null, QA.single, QA.label, "qa-fp-single", 0.51, 1, -6.4, now, now],
        sql: outlier,
      },
    ],
    "write",
  );
}

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");

  const sidebar = page.locator('[data-slot="sidebar"][data-state]').first();
  const before = await sidebar.getAttribute("data-state");
  const trigger = page.getByRole("button", { name: "Toggle Sidebar" }).first();
  const deadline = Date.now() + 15_000;

  while ((await sidebar.getAttribute("data-state")) === before) {
    if (Date.now() > deadline) {
      throw new Error("hydration gate: the sidebar toggle never became interactive");
    }

    await trigger.click();
    await page.waitForTimeout(250);
  }

  await trigger.click();
  await page.waitForTimeout(300);
}

function row(page: Page, name: string) {
  return page.locator("ul > li").filter({ hasText: name }).first();
}

async function drive(browser: Awaited<ReturnType<typeof launchBrowser>>): Promise<void> {
  const desktop = await newAdminPage(browser, BASE_URL, { height: 900, width: 1440 });
  const page = desktop.page;
  watchErrors(page, "desktop");

  await page.goto(`${BASE_URL}/admin/label-outliers`);
  await waitForHydration(page);

  expect(
    (await page.getByRole("heading", { level: 1, name: "Outliers" }).count()) === 1,
    "the station renders",
  );
  expect(
    (await page.locator('[aria-current="page"]').allTextContents()).join(" ").includes("Outliers"),
    "the sidebar lights the Outliers entry",
  );

  if (SEED) {
    const album = row(page, QA_NAMES.album);

    expect((await album.count()) === 1, "the seeded album sits on the review list");
    expect(
      (await album.getByRole("link", { name: QA_NAMES.album }).getAttribute("href")) ===
        "/album/qa-outliers-merry-christmas",
      "the album links to its public page",
    );
    expect(
      (await album.getByRole("link", { name: "zz QA Penny Black" }).getAttribute("href")) ===
        "/label/qa-outliers-penny-black",
      "the label links to its public page",
    );
    expect(
      (await album.getByRole("link", { name: "zz QA Silent Night" }).count()) === 1,
      "the album's tracks are listed as links",
    );
    expect(
      (await row(page, QA_NAMES.single).count()) === 1,
      "the seeded single sits on the review list",
    );

    await page.screenshot({ fullPage: true, path: join(OUT_DIR, "outliers-desktop.png") });

    await album.getByRole("checkbox").click();
    expect(
      (await page.getByText("1 selected").count()) === 1,
      "selecting a row raises the selection bar",
    );
    await page.screenshot({ fullPage: true, path: join(OUT_DIR, "outliers-selected.png") });
    await album.getByRole("checkbox").click();

    await album.getByRole("button", { name: "Looks fine" }).click();
    await page.waitForTimeout(1500);
    expect(
      (await row(page, QA_NAMES.album).count()) === 0,
      "marking it fine takes it off the review list",
    );

    await page.getByRole("button", { name: /Looks fine\s*\d/ }).click();
    await page.waitForTimeout(800);
    expect(
      (await row(page, QA_NAMES.album).count()) === 1,
      "the fine lens holds what was marked fine",
    );
    await page.screenshot({ fullPage: true, path: join(OUT_DIR, "outliers-fine.png") });

    await row(page, QA_NAMES.album).getByRole("button", { name: "Back on the list" }).click();
    await page.waitForTimeout(1500);
    expect(
      (await row(page, QA_NAMES.album).count()) === 0,
      "putting it back empties it from the fine lens",
    );
  }

  await desktop.context.close();

  const phone = await newAdminPage(browser, BASE_URL, { height: 844, width: 390 });
  watchErrors(phone.page, "phone");
  await phone.page.goto(`${BASE_URL}/admin/label-outliers`);
  await phone.page.waitForLoadState("networkidle");

  const overflow = await phone.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

  expect(overflow <= 1, `no horizontal overflow on the phone (${overflow}px)`);
  await phone.page.screenshot({ fullPage: true, path: join(OUT_DIR, "outliers-phone.png") });
  await phone.context.close();
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const db = SEED ? seedClient() : undefined;

  if (db) {
    await seed(db);
    console.log("seeded a QA album and single on the outlier list (SEED=1)");
  }

  const browser = await launchBrowser();

  try {
    await drive(browser);
  } finally {
    await browser.close();

    if (db) {
      await cleanup(db);
      console.log("removed the seeded outliers");
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);

    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }

    process.exit(1);
  }

  console.log(`\nlabel-outliers smoke green — screenshots in ${OUT_DIR}`);
}

await main();
