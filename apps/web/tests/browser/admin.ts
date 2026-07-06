// Browser-verification fixtures for the admin workspace (docs/admin-shell.md
// §Verifying). Every UI agent driving /admin in a real browser starts here:
// launch the system Chrome via playwright-core, mint the REAL admin grant from
// the local dev secret, and drive past hydration.
//
// The grant is minted by the production signing path itself — `signGrant()`
// (admin-auth.ts → signState, HMAC-SHA256 with ADMIN_SESSION_SECRET) — never a
// reimplementation, so the fixture can't drift from what `isAdminRequest`
// verifies. The secret comes from `apps/web/.dev.vars` (per docs/local-database.md
// a worktree copies main's file), loaded into process.env exactly like the dev
// server's own dotenv load.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { signGrant } from "../../src/lib/server/admin-auth";
import { ADMIN_COOKIE_NAME } from "../../src/lib/server/env";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Load `.dev.vars` into process.env (idempotent; mirrors env.ts's dev load). */
export function loadDevVars(): void {
  const devVars = join(webRoot, ".dev.vars");

  if (!existsSync(devVars)) {
    throw new Error(
      "apps/web/.dev.vars not found — copy it from the main checkout (docs/local-database.md).",
    );
  }

  config({ path: devVars });
}

/** Mint a real admin grant cookie value with the production signing path. */
export async function mintAdminGrant(): Promise<string> {
  loadDevVars();

  return signGrant();
}

/**
 * Authenticate a page as the operator: sets the signed admin grant cookie on
 * the page's browser context, with the same attributes the login callback
 * uses. Call once before the first `page.goto`; every /admin/* and
 * /api/admin/* request in the context carries the grant from then on.
 */
export async function loginAsAdmin(page: Page, baseUrl: string): Promise<void> {
  const { hostname } = new URL(baseUrl);

  await page.context().addCookies([
    {
      domain: hostname,
      httpOnly: true,
      name: ADMIN_COOKIE_NAME,
      path: "/",
      sameSite: "Lax",
      value: await mintAdminGrant(),
    },
  ]);
}

/**
 * Launch the system Chrome (no bundled-browser download; playwright-core +
 * channel "chrome" is the repo's browser-verification pattern). Headless by
 * default; pass headless: false to watch a run.
 */
export async function launchBrowser(options: { headless?: boolean } = {}): Promise<Browser> {
  return chromium.launch({ channel: "chrome", headless: options.headless ?? true });
}

/** A page pre-authenticated as the operator, at the given viewport. */
export async function newAdminPage(
  browser: Browser,
  baseUrl: string,
  viewport: { height: number; width: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  await loginAsAdmin(page, baseUrl);

  return { context, page };
}
