// Shared browser helpers for the public-flow E2E specs.

import { type Page } from "@playwright/test";
import { BASE_URL } from "./stack";

// A 1×1 transparent PNG — the stub body for any external image the app hardcodes
// to an absolute URL (see `blockExternalRequests`).
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Make a page HERMETIC: fulfil every request to a host OTHER than our local Vite
 * origin with a harmless stub, so a spec never depends on (or hits) a live remote.
 *
 * A few product URLs are hardcoded to the absolute prod host `siteUrl`
 * (`https://www.fluncle.com`) — the clearest being a mixtape row's cover, derived
 * from its Log ID (`mixtapeCoverUrl`). Against synthetic fixtures those 404 in prod,
 * which would (correctly) trip a spec's no-console-errors gate. Stubbing them keeps
 * the suite isolated and deterministic without weakening that gate: real
 * same-origin errors still surface. Call once, before the first navigation.
 */
export async function blockExternalRequests(page: Page): Promise<void> {
  const localOrigin = new URL(BASE_URL).origin;

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());

    if (url.origin === localOrigin) {
      await route.continue();
      return;
    }

    // A valid image so an <img> onto an external host resolves cleanly (no
    // console error); other external resources get an empty 200.
    if (route.request().resourceType() === "image") {
      await route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png", status: 200 });
      return;
    }

    await route.fulfill({ body: "", status: 200 });
  });
}
