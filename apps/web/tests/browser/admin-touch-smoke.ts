// Browser proof for the touch-comfortable admin (DIST-02, docs/admin-shell.md
// §Verifying). The operator triages the queue and pushes distribution from a
// phone; the workspace stays desktop-dense by default and only floors controls
// at the 44px touch target on a COARSE pointer (styles.css, scoped to
// .admin-workspace). This smoke pins that contract two ways so it can't
// silently regress:
//
//   1. On a touch context (iPhone viewport, hasTouch + isMobile → `pointer:
//      coarse`), every button-control on every admin surface is ≥44px, and no
//      surface bleeds horizontally.
//   2. On a mouse context (fine pointer, same viewport), the SAME controls stay
//      their dense sub-44px selves — proving the floor is touch-only and never
//      bloats the desktop UI.
//
// Run against a local dev server seeded from the dev DB:
//   BASE_URL=http://127.0.0.1:3000 bun tests/browser/admin-touch-smoke.ts
//
// Fails (non-zero exit) on any control under 44px on touch, any horizontal
// overflow, any console/page error, or if the mouse context shows NO dense
// controls (which would mean the floor leaked onto the desktop).

import { type Browser, type Page } from "playwright-core";
import { launchBrowser, loginAsAdmin } from "./admin";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const VIEWPORT = { height: 844, width: 390 }; // iPhone 12/13/14

// The admin surfaces the operator drives from a phone. Paths only — every one
// renders through the same .admin-workspace plate, so the floor must hold on all.
const SURFACES = [
  "/admin",
  "/admin/findings",
  "/admin/renders",
  "/admin/artists",
  "/admin/clips",
  "/admin/recordings",
  "/admin/mixtapes",
  "/admin/plans",
] as const;

const MIN_TOUCH = 44;

type Control = { w: number; h: number; text: string };

/** Every visible button-control (button element or a select-trigger) on the page. */
async function controlsOf(page: Page): Promise<Control[]> {
  return page.evaluate(() => {
    const out: Array<{ w: number; h: number; text: string }> = [];
    const nodes = document.querySelectorAll("button, [data-slot='select-trigger']");
    for (const el of Array.from(nodes)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        continue;
      }
      out.push({
        h: Math.round(r.height),
        text: (el.textContent ?? "").trim().slice(0, 24),
        w: Math.round(r.width),
      });
    }
    return out;
  });
}

async function horizontalBleed(page: Page): Promise<boolean> {
  const { clientW, scrollW } = await page.evaluate(() => ({
    clientW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
  }));
  return scrollW > clientW + 1;
}

async function withErrorGuard(page: Page, failures: string[]): Promise<void> {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      failures.push(`console error: ${msg.text().slice(0, 120)}`);
    }
  });
  page.on("pageerror", (err) => failures.push(`page error: ${err.message.slice(0, 120)}`));
}

/** Touch context: assert every control ≥44px and no bleed on every surface. */
async function checkTouch(browser: Browser, failures: string[]): Promise<void> {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: VIEWPORT });
  const page = await context.newPage();
  await withErrorGuard(page, failures);
  await loginAsAdmin(page, BASE_URL);

  for (const path of SURFACES) {
    await page.goto(`${BASE_URL}${path}`, { timeout: 30_000, waitUntil: "networkidle" });
    await page.waitForTimeout(600);

    if (await horizontalBleed(page)) {
      failures.push(`${path}: horizontal overflow at ${VIEWPORT.width}px`);
    }

    const controls = await controlsOf(page);
    const tiny = controls.filter((c) => c.h < MIN_TOUCH || c.w < MIN_TOUCH);
    if (tiny.length > 0) {
      const sample = tiny
        .slice(0, 6)
        .map((c) => `${c.w}x${c.h}"${c.text}"`)
        .join(", ");
      failures.push(
        `${path}: ${tiny.length}/${controls.length} controls under ${MIN_TOUCH}px — ${sample}`,
      );
    } else {
      console.log(`  touch  ${path.padEnd(20)} ${controls.length} controls, all ≥${MIN_TOUCH}px`);
    }
  }

  await context.close();
}

/** Mouse context: the floor must NOT apply — dense (<44px) controls must exist. */
async function checkMouseStaysDense(browser: Browser, failures: string[]): Promise<void> {
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  const page = await context.newPage();
  await loginAsAdmin(page, BASE_URL);
  await page.goto(`${BASE_URL}/admin`, { timeout: 30_000, waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  const controls = await controlsOf(page);
  const dense = controls.filter((c) => c.h < MIN_TOUCH);
  if (dense.length === 0) {
    failures.push(
      "mouse /admin: expected dense (<44px) controls on a fine pointer, found none — the touch floor leaked onto the desktop UI",
    );
  } else {
    console.log(
      `  mouse  /admin              ${dense.length}/${controls.length} controls stay dense (<${MIN_TOUCH}px) ✓`,
    );
  }

  await context.close();
}

async function main() {
  const failures: string[] = [];
  const browser = await launchBrowser({ headless: true });

  console.log(`DIST-02 touch smoke — ${BASE_URL} @ ${VIEWPORT.width}x${VIEWPORT.height}`);
  await checkTouch(browser, failures);
  await checkMouseStaysDense(browser, failures);

  await browser.close();

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} failure(s):`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }
  console.log("\n✓ admin is touch-comfortable on a coarse pointer and stays dense on a fine one.");
}

await main();
