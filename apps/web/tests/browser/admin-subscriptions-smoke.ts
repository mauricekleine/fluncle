// Browser proof for the Costs station CRUD (COST-02, docs/admin-shell.md
// §Verifying). `/admin/costs` is the operator's private cost ledger: the reads are
// admin-tier + in-process, but create/update/delete are OPERATOR-tier oRPC ops
// (`create/update/delete_subscription`) driven from the page by same-origin fetch
// with the admin cookie carrying the operator identity. This smoke drives the real
// dialog end-to-end so the whole write path — the operator cookie satisfying
// `operatorGuard`, the server validation, and the list refetch — can't silently
// regress:
//
//   1. Add a throwaway line (only the required Name / Vendor / Amount — the closed
//      Category / Cadence / Status selects keep their EMPTY_FORM defaults).
//   2. Assert it lands in the ledger with its formatted amount.
//   3. Edit the amount; assert the row reflects the new figure.
//   4. Delete it through the confirm dialog; assert it's gone (self-cleaning, so a
//      failed run leaves at most one clearly-named row in the LOCAL dev DB).
//
// Run against a local dev server seeded from the dev DB:
//   BASE_URL=http://127.0.0.1:3000 bun tests/browser/admin-subscriptions-smoke.ts
//
// Fails (non-zero exit) if a write is rejected (e.g. the cookie stops satisfying
// operatorGuard), a mutation doesn't reflect in the list, the row survives a delete,
// or any console/page error fires.

import { type Browser, type Page } from "playwright-core";
import { launchBrowser, loginAsAdmin } from "./admin";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const VIEWPORT = { height: 900, width: 1280 };

// A unique, self-identifying line so a run never collides with a prior one and a
// leftover (from a mid-run failure) is obvious in the ledger. `Date.now()` is fine —
// this is a plain bun script, not a deterministic workflow.
const MARKER = `smoke-${Date.now()}`;
const NAME = `CRUD Smoke ${MARKER}`;
const VENDOR = "Smoke Vendor";
const CREATE_AMOUNT = "12.00";
const EDIT_AMOUNT = "34.00";

async function withErrorGuard(page: Page, failures: string[]): Promise<void> {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      failures.push(`console error: ${msg.text().slice(0, 160)}`);
    }
  });
  page.on("pageerror", (err) => failures.push(`page error: ${err.message.slice(0, 160)}`));
}

async function main() {
  const failures: string[] = [];
  const browser: Browser = await launchBrowser({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await withErrorGuard(page, failures);
  await loginAsAdmin(page, BASE_URL);

  console.log(`COST-02 subscriptions CRUD smoke — ${BASE_URL}`);

  try {
    await page.goto(`${BASE_URL}/admin/costs`, { timeout: 30_000, waitUntil: "networkidle" });

    // ── CREATE ────────────────────────────────────────────────────────────────
    // The header "Add cost" button is the only one on the page until the dialog
    // opens (which adds a second "Add cost" as the submit).
    await page.getByRole("button", { name: "Add cost" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });

    await dialog.getByLabel("Name").fill(NAME);
    await dialog.getByLabel("Vendor").fill(VENDOR);
    await dialog.getByLabel("Amount").fill(CREATE_AMOUNT);
    await dialog.getByRole("button", { name: "Add cost" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });

    // The row is keyed by name + vendor; wait for it, then confirm the amount shows.
    const row = page.locator("li", { hasText: NAME });
    await row.waitFor({ state: "visible", timeout: 10_000 });
    if (!(await row.getByText(CREATE_AMOUNT).count())) {
      failures.push(`create: row present but ${CREATE_AMOUNT} not shown`);
    } else {
      console.log(`  create  "${NAME}" @ ${CREATE_AMOUNT} ✓`);
    }

    // ── EDIT ──────────────────────────────────────────────────────────────────
    await page.getByRole("button", { name: `Edit ${NAME}` }).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.waitFor({ state: "visible", timeout: 10_000 });
    await editDialog.getByLabel("Amount").fill(EDIT_AMOUNT);
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await editDialog.waitFor({ state: "hidden", timeout: 10_000 });

    const editedRow = page.locator("li", { hasText: NAME });
    await editedRow.getByText(EDIT_AMOUNT).waitFor({ state: "visible", timeout: 10_000 });
    console.log(`  edit    amount → ${EDIT_AMOUNT} ✓`);

    // ── DELETE ────────────────────────────────────────────────────────────────
    await page.getByRole("button", { name: `Delete ${NAME}` }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor({ state: "visible", timeout: 10_000 });
    await confirm.getByRole("button", { name: "Delete" }).click();

    await page.locator("li", { hasText: NAME }).waitFor({ state: "detached", timeout: 10_000 });
    console.log(`  delete  row removed ✓`);
  } catch (error) {
    failures.push(`drive: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  }

  await context.close();
  await browser.close();

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} failure(s):`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }
  console.log(
    "\n✓ /admin/costs create → edit → delete works end-to-end under the operator cookie.",
  );
}

await main();
