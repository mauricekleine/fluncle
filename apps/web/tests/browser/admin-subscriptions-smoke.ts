import { type Browser, type Page } from "playwright-core";
import { launchBrowser, loginAsAdmin } from "./admin";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const VIEWPORT = { height: 900, width: 1280 };

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

    await page.getByRole("button", { name: "Add cost" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });

    await dialog.getByLabel("Name").fill(NAME);
    await dialog.getByLabel("Vendor").fill(VENDOR);
    await dialog.getByLabel("Amount").fill(CREATE_AMOUNT);
    await dialog.getByRole("button", { name: "Add cost" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });

    const row = page.locator("li", { hasText: NAME });
    await row.waitFor({ state: "visible", timeout: 10_000 });
    if (!(await row.getByText(CREATE_AMOUNT).count())) {
      failures.push(`create: row present but ${CREATE_AMOUNT} not shown`);
    } else {
      console.log(`  create  "${NAME}" @ ${CREATE_AMOUNT} ✓`);
    }

    await page.getByRole("button", { name: `Edit ${NAME}` }).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.waitFor({ state: "visible", timeout: 10_000 });
    await editDialog.getByLabel("Amount").fill(EDIT_AMOUNT);
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await editDialog.waitFor({ state: "hidden", timeout: 10_000 });

    const editedRow = page.locator("li", { hasText: NAME });
    await editedRow.getByText(EDIT_AMOUNT).waitFor({ state: "visible", timeout: 10_000 });
    console.log(`  edit    amount → ${EDIT_AMOUNT} ✓`);

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
