import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { type Page } from "playwright-core";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { launchBrowser, loadDevVars, newAdminPage } from "./admin";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/admin-labels-smoke";
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
  ruleId: "qa-labels-rule",
  ruled: "qa-labels-ruled",
  waiting: "qa-labels-waiting",
} as const;

const QA_NAMES = {
  ruled: "zz QA Partial Label",
  waiting: "zz QA Waiting Label",
} as const;

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

async function seedLabels(db: Client): Promise<void> {
  const now = new Date().toISOString();

  for (const [id, name, slug] of [
    [QA.waiting, QA_NAMES.waiting, "qa-labels-waiting"],
    [QA.ruled, QA_NAMES.ruled, "qa-labels-ruled"],
  ] as const) {
    await db.execute({
      args: [id, name, slug, now, now],
      sql: `insert or replace into labels (id, name, slug, seed_state, created_at, updated_at)
            values (?, ?, ?, 'undecided', ?, ?)`,
    });
  }

  await db.execute({
    args: [QA.ruleId, QA.ruled, now, now],
    sql: `insert or replace into artist_rules
            (id, label_id, artist_mbid, artist_name, verdict, source, created_at, updated_at)
          values (?, ?, '00000000-0000-4000-8000-00000000qa01', 'QA Allowed Act',
                  'allow', 'operator', ?, ?)`,
  });
}

async function cleanupLabels(db: Client): Promise<void> {
  await db.execute(`delete from artist_rules where id = '${QA.ruleId}'`);
  await db.execute(`delete from labels where id in ('${QA.waiting}', '${QA.ruled}')`);
}

async function sectionHeading(page: Page, title: string): Promise<string> {
  const heading = page.getByRole("heading", { level: 2 }).filter({ hasText: title }).first();

  return (await heading.count()) === 0 ? "" : ((await heading.textContent()) ?? "").trim();
}

function headingCount(heading: string): number | undefined {
  const match = /·\s*(\d+)\s*$/.exec(heading);

  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function sectionRows(page: Page, title: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: new RegExp(title) }) })
    .first()
    .locator("ul > li");
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

async function drive(browser: Awaited<ReturnType<typeof launchBrowser>>): Promise<void> {
  const desktop = await newAdminPage(browser, BASE_URL, { height: 900, width: 1440 });
  const page = desktop.page;
  watchErrors(page, "desktop");

  await page.goto(`${BASE_URL}/admin/labels`);
  await waitForHydration(page);

  expect(
    (await page.getByRole("heading", { level: 1, name: "Labels" }).count()) === 1,
    "the station renders",
  );

  const waiting = await sectionHeading(page, "Waiting on a ruling");
  const partial = await sectionHeading(page, "Seeding named artists");

  expect(waiting !== "", "the waiting section renders");
  expect(partial !== "", "the settled-partial section renders");

  const titles = await page.getByRole("heading", { level: 2 }).allTextContents();
  const waitingAt = titles.findIndex((title) => title.startsWith("Waiting on a ruling"));
  const partialAt = titles.findIndex((title) => title.startsWith("Seeding named artists"));

  expect(
    waitingAt >= 0 && partialAt > waitingAt,
    `the queue leads and the settled partials follow it (${waitingAt} → ${partialAt})`,
  );

  const intro = (await page.locator("section p").first().textContent()) ?? "";

  expect(
    intro.includes("crawl walked into them"),
    `the waiting intro names the crawl path (${intro.slice(0, 80)}…)`,
  );

  const subtitle = (await page.locator("header").first().textContent()) ?? "";
  const waitingCount = headingCount(waiting);
  const partialCount = headingCount(partial);

  expect(waitingCount !== undefined, `the waiting section leads with its total (${waiting})`);
  expect(partialCount !== undefined, `the settled section leads with its total (${partial})`);
  expect(
    waitingCount !== undefined && subtitle.includes(`${waitingCount} waiting on a ruling`),
    `the header counts the waiting set alone (${subtitle.trim()})`,
  );

  if (SEED) {
    const waitingRows = await sectionRows(page, "Waiting on a ruling").allTextContents();
    const partialRows = await sectionRows(page, "Seeding named artists").allTextContents();

    expect(
      waitingRows.some((row) => row.includes(QA_NAMES.waiting)),
      "the bare undecided label waits on a ruling",
    );
    expect(
      !waitingRows.some((row) => row.includes(QA_NAMES.ruled)),
      "the rule-carrying undecided label is NOT counted as waiting",
    );
    expect(
      partialRows.some((row) => row.includes(QA_NAMES.ruled)),
      "the rule-carrying undecided label sits in the settled section",
    );

    expect(
      partialRows.some((row) => row.includes(QA_NAMES.ruled) && row.includes("Only 1 artist")),
      "the settled row states how many artists it takes",
    );

    expect(
      (await page.getByRole("button", { name: `Artist rules for ${QA_NAMES.waiting}` }).count()) ===
        1,
      "a waiting row offers the artist-rule affordance behind its ⋮",
    );
  }

  await page.screenshot({ fullPage: true, path: join(OUT_DIR, "labels-desktop.png") });
  await desktop.context.close();

  const phone = await newAdminPage(browser, BASE_URL, { height: 844, width: 390 });
  watchErrors(phone.page, "phone");
  await phone.page.goto(`${BASE_URL}/admin/labels`);
  await phone.page.waitForLoadState("networkidle");

  expect(
    (await sectionHeading(phone.page, "Waiting on a ruling")) !== "" &&
      (await sectionHeading(phone.page, "Seeding named artists")) !== "",
    "both undecided sections render on the phone",
  );

  const overflow = await phone.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

  expect(overflow <= 1, `no horizontal overflow on the phone (${overflow}px)`);
  await phone.page.screenshot({ fullPage: true, path: join(OUT_DIR, "labels-phone.png") });
  await phone.context.close();
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const db = SEED ? seedClient() : undefined;

  if (db) {
    await seedLabels(db);
    console.log("seeded the two QA labels (SEED=1)");
  }

  const browser = await launchBrowser();

  try {
    await drive(browser);
  } finally {
    await browser.close();

    if (db) {
      await cleanupLabels(db);
      console.log("removed the seeded labels");
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);

    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }

    process.exit(1);
  }

  console.log(`\nlabels smoke green — screenshots in ${OUT_DIR}`);
}

await main();
