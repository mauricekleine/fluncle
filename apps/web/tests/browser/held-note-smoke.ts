// THE HELD-NOTE LOOP, driven end to end in a real browser as the operator.
//
// The echo gate refuses to STORE an auto-note that echoes a sonic neighbour. #502 shipped
// that refusal SILENT — the model's line was destroyed — which left the gate unsupervisable:
// nobody could read what was binned, judge whether the gate was right, or prove its
// thresholds wrong. This smoke drives the fix, past hydration:
//
//   1. /admin — the attention queue carries the held-note row
//   2. its primary action deep-links into the finding's note dialog
//   3. the dialog shows the note the model wrote AND the neighbour it echoed, with the
//      lifted run marked in BOTH, and the score beside the threshold it was judged against
//   4. "Keep it" — the operator overrules the gate; the line is written to the finding
//   5. /log/<id> — the accepted note is live on the public page
//   6. /admin — the row is gone
//
// It needs a HELD rejection to exist in the local dev DB. `SEED=1` makes one the honest way:
// it blanks a seeded finding's note and drives the REAL `note_track` endpoint with a line
// that genuinely lifts a phrase from that finding's real MuQ neighbour, so the rejection
// under test is one the live gate actually made. It restores the note in a `finally`, and
// refuses to run against a non-local database.
//
//   BASE_URL=http://127.0.0.1:3000 OUT_DIR=/tmp/held-note SEED=1 bun tests/browser/held-note-smoke.ts

import { createClient } from "@libsql/client";
import { type Page } from "playwright-core";
import { launchBrowser, loadDevVars, newAdminPage } from "./admin";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = process.env.OUT_DIR ?? "/tmp/held-note";
const SEED = process.env.SEED === "1";

// The finding the seed exercises, and the neighbour whose note it will lift from. Both are
// in the standard dev seed; the lift is measured by the live gate, never asserted here.
const TARGET = "004.6.0Q";
const ECHOING_NOTE = "Deep roller from 2016 that keeps pulling me back under every single time.";

loadDevVars();

const dbUrl = process.env.TURSO_DATABASE_URL ?? "";
const token = process.env.FLUNCLE_API_TOKEN ?? "";

if (SEED && !/127\.0\.0\.1|localhost/.test(dbUrl)) {
  throw new Error(`SEED=1 refuses a non-local database (${dbUrl}). It mutates notes.`);
}

const db = createClient({ url: dbUrl });
let restoreNote: null | string = null;

async function seedHeldRejection(): Promise<void> {
  const before = await db.execute({
    args: [TARGET],
    sql: "select note from findings where log_id = ?",
  });
  restoreNote = (before.rows[0]?.note as null | string) ?? null;

  // Blank it so the auto-note path is live for this finding (it fills an EMPTY note only).
  await db.execute({ args: [TARGET], sql: "update findings set note = null where log_id = ?" });

  // Drive the REAL endpoint. The gate does the rejecting; we only supply a line that echoes.
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
  // "Failed to load resource" is the console's echo of the same cross-origin CDN 400 above;
  // the same-origin response gate is the real net.
  if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
    errors.push(`console: ${message.text()}`);
  }
});
page.on("response", (response) => {
  // OUR origin only. A dev `/log` page still points its poster/video at the PRODUCTION
  // `found.fluncle.com` CDN, whose Media-Transformations renditions 400 from localhost — a
  // pre-existing environmental artifact of dev, reproducible on any untouched finding, and
  // nothing this smoke is testing. Gating on same-origin keeps the smoke honest about the
  // app without wiring it to a third-party CDN's behaviour.
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

  // A FRESH row is the queue's newest, and the ratified order is oldest-first — so it starts
  // in the backlog behind [Show all] and ages into the working set like every other row.
  // (Its anchor is the FIRST hold, never the latest bounce, so a repeatedly-bouncing note
  // still ages in instead of resetting to the bottom forever.) The operator's immediate
  // signal is the digest's dispatch line — "a note the echo gate held back" — which the CLI
  // and the Raycast menu bar render off the same snapshot (pinned in attention.test.ts).
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
  // Clicking proves hydration: the row's primary action is a live control, not SSR paint.
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
  // The lifted run is marked in BOTH notes — the pair is the point, not the verdict.
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
    // Put the seeded finding back the way we found it, and clear the rejection we made.
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
