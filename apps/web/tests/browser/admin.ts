import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { signGrant } from "../../src/lib/server/admin-auth";
import { ADMIN_COOKIE_NAME } from "../../src/lib/server/env";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadDevVars(): void {
  const devVars = join(webRoot, ".dev.vars");

  if (!existsSync(devVars)) {
    throw new Error(
      "apps/web/.dev.vars not found — copy it from the main checkout (docs/local-database.md).",
    );
  }

  config({ path: devVars });
}

async function mintAdminGrant(): Promise<string> {
  loadDevVars();

  return signGrant();
}

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

export async function launchBrowser(options: { headless?: boolean } = {}): Promise<Browser> {
  return chromium.launch({ channel: "chrome", headless: options.headless ?? true });
}

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
