import { type Page } from "@playwright/test";
import { BASE_URL } from "./stack";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export async function blockExternalRequests(page: Page): Promise<void> {
  const localOrigin = new URL(BASE_URL).origin;

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());

    if (url.origin === localOrigin) {
      await route.continue();
      return;
    }

    if (route.request().resourceType() === "image") {
      await route.fulfill({ body: ONE_PIXEL_PNG, contentType: "image/png", status: 200 });
      return;
    }

    await route.fulfill({ body: "", status: 200 });
  });
}

export type ObservedDiscoveryEvent = {
  event: string;
  kind?: string;
  service?: string;
  url: string;
};

export async function installDiscoveryEventProbe(page: Page): Promise<{
  events: ObservedDiscoveryEvent[];
}> {
  const events: ObservedDiscoveryEvent[] = [];

  await page.addInitScript(() => {
    const recorded = ((window as Window & { __discoveryEvents?: unknown[] }).__discoveryEvents =
      []);

    (
      window as Window & { sa_event?: (name: string, metadata?: Record<string, string>) => void }
    ).sa_event = (name: string, metadata?: Record<string, string>) => {
      recorded.push({ event: name, metadata });

      const url = new URL("https://queue.simpleanalyticscdn.com/simple.gif");

      url.searchParams.set("event", name);

      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          url.searchParams.set(key, String(value));
        }
      }

      navigator.sendBeacon(url.toString());
    };
  });

  page.on("request", (request) => {
    const url = request.url();

    if (!url.includes("queue.simpleanalyticscdn.com")) {
      return;
    }

    const parsed = new URL(url);
    const kind = parsed.searchParams.get("kind") ?? undefined;
    const service = parsed.searchParams.get("service") ?? undefined;

    events.push({
      event: parsed.searchParams.get("event") ?? "",
      ...(kind ? { kind } : {}),
      ...(service ? { service } : {}),
      url,
    });
  });

  return { events };
}
