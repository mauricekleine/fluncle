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

const SECRET = "zzEncodedSecret4242";

function percentEncodeAll(value: string): string {
  return [...value].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
}

function encodeTimes(value: string, times: number): string {
  let out = value;

  for (let index = 0; index < times; index += 1) {
    out = encodeURIComponent(out);
  }

  return out;
}

const NAME_VARIANTS = (name: string): string[] => [
  name,
  name.toUpperCase(),
  `%${name.charCodeAt(0).toString(16)}${name.slice(1)}`,
  percentEncodeAll(name),
  encodeTimes(percentEncodeAll(name), 1),
  encodeTimes(percentEncodeAll(name), 2),
];

const HOSTS = ["https://www.fluncle.com", ""];

describe("encoded credentials never survive the scrub", () => {
  it("recognises every encoding of a sensitive parameter name", () => {
    for (const name of ["token", "follow", "unsubscribe", "code", "state", "intent"]) {
      for (const variant of NAME_VARIANTS(name)) {
        for (const host of HOSTS) {
          const url = `${host}/label/x?sort=recent&${variant}=${SECRET}`;

          expect(scrubSensitiveText(url), url).not.toContain(SECRET);
        }
      }
    }
  });

  it("scrubs URLs nested inside parameter values at any encoding depth", () => {
    for (let depth = 1; depth <= 4; depth += 1) {
      const nested = encodeTimes(`/api/auth/reset-password/${SECRET}?x=1`, depth);
      const viaNext = `https://www.fluncle.com/go?next=${nested}`;
      const viaToken = `https://www.fluncle.com/go?next=${encodeTimes(`/x?token=${SECRET}`, depth)}`;

      expect(scrubSensitiveText(viaNext), viaNext).not.toContain(SECRET);
      expect(scrubSensitiveText(viaToken), viaToken).not.toContain(SECRET);
    }
  });

  it("strips the whole query from the known credential routes", () => {
    const routes = [
      `/api/auth/magic-link/verify?${percentEncodeAll("token")}=${SECRET}&callbackURL=%2F`,
      `/api/auth/magic-link/verify?nonsense=${SECRET}`,
      `/api/auth/reset-password/${SECRET}?callbackURL=%2Freset-password`,
      `${encodeTimes(`/reset-password/${SECRET}`, 2)}`,
      `/api/v1/admin/spotify/auth/callback?c%6fde=${SECRET}&st%61te=x`,
      `/api/admin/youtube/auth/callback?anything=${SECRET}`,
      `/follows?${encodeTimes("token", 1)}=${SECRET}`,
      `/follows?whatever=${SECRET}`,
      `/api/v1/follow-digest/unsubscribe?t=${SECRET}`,
    ];

    for (const route of routes) {
      for (const host of HOSTS) {
        expect(scrubSensitiveText(`${host}${route}`), route).not.toContain(SECRET);
      }
    }
  });

  it("scrubs a bare query string and object-form query fields with encoded names", () => {
    const event = browserSentryScrubHooks.beforeSend({
      request: {
        headers: {
          referer: `https://www.fluncle.com/api/auth/magic-link/verify?%74oken=${SECRET}`,
        },
        query_string: { "%74oken": SECRET, [encodeTimes("follow", 1)]: SECRET },
        url: `https://www.fluncle.com/label/x?${percentEncodeAll("token")}=${SECRET}`,
      },
    });
    const pairs = browserSentryScrubHooks.beforeSend({
      request: { query_string: [["%2574oken", SECRET]] },
    });
    const bare = scrubSensitiveText(`%74oken=${SECRET}&sort=recent`);

    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(JSON.stringify(pairs)).not.toContain(SECRET);
    expect(bare).not.toContain(SECRET);
    expect(bare).toContain("sort=recent");
  });

  it("scrubs navigation, fetch and xhr breadcrumbs and free text", () => {
    const crumbs = [
      { category: "navigation", data: { from: `/follows?%74oken=${SECRET}`, to: "/" } },
      { category: "fetch", data: { url: `/api/v1/follow-digest/follows?t%6fken=${SECRET}` } },
      {
        category: "xhr",
        data: { url: `https://www.fluncle.com/x?next=${encodeTimes(`/y?token=${SECRET}`, 3)}` },
      },
      { message: `GET https://www.fluncle.com/api/auth/magic-link/verify?%74oken=${SECRET} 302` },
    ];

    for (const crumb of crumbs) {
      expect(JSON.stringify(browserSentryScrubHooks.beforeBreadcrumb(crumb))).not.toContain(SECRET);
    }
  });

  it("leaves ordinary urls readable", () => {
    expect(scrubSensitiveText("https://www.fluncle.com/label/x?sort=recent&page=2")).toBe(
      "https://www.fluncle.com/label/x?sort=recent&page=2",
    );
    expect(scrubSensitiveText("plain words, no url")).toBe("plain words, no url");
  });
});

describe("scrub property: random encodings and nestings", () => {
  function seeded(seed: number): () => number {
    let state = seed;

    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

      return state / 2_147_483_648;
    };
  }

  it("never lets a credential through across 2,000 generated urls", () => {
    const random = seeded(20_260_925);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const names = ["token", "follow", "unsubscribe", "intent", "code", "state", "callbackURL"];
    const paths = ["/label/x", "/artist/y", "/", "/go", "/api/v1/tracks"];

    for (let index = 0; index < 2000; index += 1) {
      const secret = `zzProp${index}Secret`;
      const name = pick(NAME_VARIANTS(pick(names)));
      let url = `${pick(paths)}?a=1&${name}=${secret}&b=2`;

      for (let depth = Math.floor(random() * 3); depth > 0; depth -= 1) {
        url = `${pick(paths)}?next=${encodeTimes(url, 1 + Math.floor(random() * 2))}`;
      }

      const host = pick(HOSTS);
      const framed = pick([`${host}${url}`, `GET ${host}${url} 200`, `"${host}${url}"`]);

      expect(scrubSensitiveText(framed), framed).not.toContain(secret);
    }
  });
});
