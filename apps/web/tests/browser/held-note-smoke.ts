import { createClient } from "@libsql/client";
import { type Page } from "playwright-core";
import { LOCAL_DB_CONCURRENCY } from "../../src/lib/database-concurrency";
import { launchBrowser, loadDevVars, newAdminPage } from "./admin";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = process.env.OUT_DIR ?? "/tmp/held-note";
const SEED = process.env.SEED === "1";

const TARGET = "004.6.0Q";
const ECHOING_NOTE = "Deep roller from 2016 that keeps pulling me back under every single time.";

loadDevVars();

const dbUrl = process.env.TURSO_DATABASE_URL ?? "";
const token = process.env.FLUNCLE_API_TOKEN ?? "";

if (SEED && !/127\.0\.0\.1|localhost/.test(dbUrl)) {
  throw new Error(`SEED=1 refuses a non-local database (${dbUrl}). It mutates notes.`);
}

const db = createClient({ concurrency: LOCAL_DB_CONCURRENCY, url: dbUrl });
let restoreNote: null | string = null;

async function seedHeldRejection(): Promise<void> {
  const before = await db.execute({
    args: [TARGET],
    sql: "select note from findings where log_id = ?",
  });
  restoreNote = (before.rows[0]?.note as null | string) ?? null;

  await db.execute({ args: [TARGET], sql: "update findings set note = null where log_id = ?" });

  const response = await fetch(`${BASE}/api/v1/admin/tracks/${TARGET}/note`, {
    body: JSON.stringify({ note: ECHOING_NOTE }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "POST",
  });

  if (response.status !== 422) {
    throw new Error(
      `expected the echo gate to reject (422), got ${response.status}. The seed note no longer echoes its neighbourhood — pick a fresh lift.`,
    );
  }

  console.log("seed: the live echo gate rejected the note (422) and HELD it");
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  shot: ${name}.png`);
}

const browser = await launchBrowser();
const { page } = await newAdminPage(browser, BASE, { height: 1000, width: 1440 });

const errors: string[] = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
    errors.push(`console: ${message.text()}`);
  }
});
page.on("response", (response) => {
  if (response.status() >= 400 && response.url().startsWith(BASE)) {
    errors.push(`http ${response.status()}: ${response.url()}`);
  }
});

try {
  if (SEED) {
    await seedHeldRejection();
  }

  console.log("\n[1] /admin — the queue carries the held note");
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });

  const row = page.locator('li:has-text("Held note")').first();

  if (!(await row.isVisible().catch(() => false))) {
    console.log("  (new row → in the backlog; opening [Show all])");
    const showAll = page.getByRole("button", { name: /Show all/i });
    await showAll.waitFor({ state: "visible", timeout: 20_000 });
    await showAll.click();
  }

  await row.waitFor({ state: "visible", timeout: 20_000 });
  console.log("  row:", (await row.innerText()).replace(/\n+/g, " | "));
  await row.scrollIntoViewIfNeeded();
  await shot(page, "1-queue-row");

  console.log("\n[2] 'Read it' → the finding's note dialog");

  await row.getByRole("button", { name: "Read it" }).click();
  await page.waitForURL(/\/admin\/findings\?.*note=/, { timeout: 20_000 });
  console.log("  url:", page.url());

  console.log("\n[3] the evidence, side by side");
  const panel = page.locator('section:has-text("The echo gate held this back")');
  await panel.waitFor({ state: "visible", timeout: 20_000 });
  console.log(
    (await panel.innerText())
      .split("\n")
      .filter(Boolean)
      .map((line) => `    ${line}`)
      .join("\n"),
  );

  const marks = await panel.locator("mark").allInnerTexts();
  console.log("  marked runs:", JSON.stringify(marks));

  if (marks.length < 2) {
    throw new Error("expected the lifted phrase marked in BOTH the held note and the neighbour's");
  }

  await shot(page, "2-held-note-dialog");

  console.log("\n[4] 'Keep it' — the operator overrules the gate");
  await panel.getByRole("button", { name: "Keep it" }).click();
  await panel.waitFor({ state: "detached", timeout: 20_000 });
  console.log("  the rejection is resolved and the line is written");
  await shot(page, "3-accepted");

  console.log("\n[5] /log — the accepted note is public");
  await page.goto(`${BASE}/log/${TARGET}`, { waitUntil: "networkidle" });
  const landed = (await page.locator("body").innerText()).includes(ECHOING_NOTE);
  console.log("  the accepted note renders on the public log page:", landed);

  if (!landed) {
    throw new Error("the accepted note did not reach the public /log page");
  }

  await shot(page, "4-public-log");

  console.log("\n[6] /admin — the row is gone");
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1_000);
  const remaining = await page.locator('li:has-text("Held note")').count();
  console.log("  held-note rows remaining:", remaining);
  await shot(page, "5-queue-clear");

  if (errors.length > 0) {
    throw new Error(`console/page errors: ${errors.join("; ")}`);
  }

  console.log("\nHELD-NOTE SMOKE: ok (no console or page errors)");
} finally {
  if (SEED) {
    await db.execute({
      args: [restoreNote, TARGET],
      sql: "update findings set note = ? where log_id = ?",
    });
    await db.execute({
      args: [TARGET],
      sql: `delete from note_rejections
            where track_id in (select track_id from findings where log_id = ?)`,
    });
    console.log("seed: restored");
  }

  await browser.close();
}
