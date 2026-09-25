import { describe, expect, it } from "vitest";
import { browserSentryScrubHooks, FILTERED, scrubSensitiveText } from "./sentry-scrub";

const TOKEN = "zzBrowserSideToken98765";

describe("browser Sentry scrub", () => {
  it("filters token-bearing params on the page url, breadcrumbs and events", () => {
    const event = browserSentryScrubHooks.beforeSend({
      breadcrumbs: [{ data: { from: `/label/x?follow=${TOKEN}&sort=recent`, to: "/label/x" } }],
      request: { url: `https://www.fluncle.com/follows?token=${TOKEN}` },
    });
    const breadcrumb = browserSentryScrubHooks.beforeBreadcrumb({
      data: { url: `/api/v1/follow-digest/unsubscribe?token=${TOKEN}` },
      message: `navigated to /follows?unsubscribe=${TOKEN}`,
    });

    expect(JSON.stringify(event)).not.toContain(TOKEN);
    expect(JSON.stringify(breadcrumb)).not.toContain(TOKEN);
  });

  it("keeps the rest of the url readable", () => {
    expect(scrubSensitiveText(`/label/x?sort=recent&follow=${TOKEN}#top`)).toBe(
      `/label/x?sort=recent&follow=${FILTERED}#top`,
    );
  });
});
