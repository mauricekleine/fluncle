import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENFORCED_CSP,
  REPORT_ONLY_CSP,
  securityHeadersFor,
  withSecurityHeaders,
} from "./security-headers";

// The security-header POLICY, unit-pinned. What server.ts does with it — that every
// dispatched response actually passes through this layer, cache hit included — is proven
// end to end in src/server.test.ts.
//
// Every test here states BOTH halves the change has to satisfy: the header is present
// where it protects something, and ABSENT where it would break a legitimate flow (a
// framed oEmbed card, an http:// dev request, a non-document reply).

function html(headers: Record<string, string> = {}): Response {
  return new Response("<!doctype html><html></html>", {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function headerMap(request: Request, response: Response): Record<string, string> {
  return Object.fromEntries(securityHeadersFor(request, response));
}

const httpsGet = (url = "https://www.fluncle.com/log/abc") => new Request(url);

describe("securityHeadersFor", () => {
  it("puts nosniff on EVERY response, whatever the content type", () => {
    const types = [
      "application/json",
      "application/xml",
      "image/png",
      "text/plain",
      "video/mp4",
      "text/html; charset=utf-8",
    ];

    for (const type of types) {
      const headers = headerMap(
        httpsGet("https://www.fluncle.com/api/v1/tracks"),
        new Response("body", { headers: { "content-type": type } }),
      );

      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    }
  });

  it("puts nosniff on a response with NO content-type at all (a redirect, a 204)", () => {
    const headers = headerMap(
      httpsGet(),
      new Response(null, { headers: { location: "/log/xyz" }, status: 301 }),
    );

    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    // Not an HTML document, so no document-scoped header rides along.
    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["Referrer-Policy"]).toBeUndefined();
  });

  it("gives an HTML document the referrer, HSTS, framing and report-only policies", () => {
    const headers = headerMap(httpsGet(), html());

    expect(headers).toEqual({
      "Content-Security-Policy": "frame-ancestors 'self'",
      "Content-Security-Policy-Report-Only": REPORT_ONLY_CSP,
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security": "max-age=31536000",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("gives a NON-document reply nosniff and nothing else", () => {
    // A JSON contract reply, a feed, an OG image, a media proxy: no referrer to leak and
    // no frame to protect, so the document-scoped headers must not be layered on.
    const headers = headerMap(
      httpsGet("https://www.fluncle.com/api/v1/search?q=ab"),
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );

    expect(headers).toEqual({ "X-Content-Type-Options": "nosniff" });
  });

  it("ships the full content policy REPORT-ONLY — the enforcing header carries framing only", () => {
    // The deliberate rollout choice: nothing but `frame-ancestors` is enforced, so a
    // directive that turns out to be too tight cannot break a page.
    expect(ENFORCED_CSP).toBe("frame-ancestors 'self'");
    expect(ENFORCED_CSP).not.toContain("script-src");
    expect(ENFORCED_CSP).not.toContain("default-src");

    // …and the honest policy names the hosts the app actually loads, plus the three
    // directives that harden the page even with inline script allowed.
    expect(REPORT_ONLY_CSP).toContain("object-src 'none'");
    expect(REPORT_ONLY_CSP).toContain("base-uri 'self'");
    expect(REPORT_ONLY_CSP).toContain("form-action 'self'");
    expect(REPORT_ONLY_CSP).toContain("https://scripts.simpleanalyticscdn.com");
    expect(REPORT_ONLY_CSP).toContain("https://found.fluncle.com");
    expect(REPORT_ONLY_CSP).toContain("https://i.scdn.co");
    expect(REPORT_ONLY_CSP).toContain("https://*.ingest.de.sentry.io");
    // Inline script stays allowed on purpose (the edge cache makes a per-request nonce
    // unworkable — see the module comment). Pinned so removing it is a decision, not a
    // drive-by that blanks the site's hydration.
    expect(REPORT_ONLY_CSP).toContain("'unsafe-inline'");
    // Never enforced: the Tor mirror serves this markup over http on a .onion host.
    expect(REPORT_ONLY_CSP).not.toContain("upgrade-insecure-requests");
  });

  // THE STRUCTURAL EXEMPTION. `/embed/<logId>` must stay framable by third parties, and
  // the rule that keeps it so is "a route that set its own CSP owns its content policy" —
  // no path string in this module, so any future self-policing route inherits it.
  describe("a route that declares its own CSP keeps it", () => {
    it("layers neither CSP header over an existing one", () => {
      const headers = headerMap(
        httpsGet("https://www.fluncle.com/embed/001.A.01"),
        html({ "content-security-policy": "frame-ancestors *" }),
      );

      expect(headers["Content-Security-Policy"]).toBeUndefined();
      expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
    });

    it("still gives that response nosniff, referrer and HSTS", () => {
      // The exemption is scoped to the CONTENT policy — the transport and sniffing
      // protections are not framing-related and apply to the embed card too.
      const headers = headerMap(
        httpsGet("https://www.fluncle.com/embed/001.A.01"),
        html({ "content-security-policy": "frame-ancestors *" }),
      );

      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000");
    });

    it("the embed route really does set its own CSP — the exemption has something to bind to", () => {
      // A behavioural test on a hand-made response proves the RULE; this proves its
      // PREMISE against the live route, so dropping `frame-ancestors *` there (which
      // would silently hand the card `'self'` and break every third-party unfurl) fails
      // here instead of in production. The route module itself is not imported — it pulls
      // the whole log resolver — so the declaration is read from source.
      const source = readFileSync(new URL("../../routes/embed.$logId.ts", import.meta.url), "utf8");

      expect(source).toContain('"Content-Security-Policy": "frame-ancestors *"');
    });
  });

  describe("HSTS is sent only where it is safe", () => {
    it("is sent over https", () => {
      expect(headerMap(httpsGet(), html())["Strict-Transport-Security"]).toBe("max-age=31536000");
    });

    it("is NOT sent over http — local dev must never pin localhost to https", () => {
      const headers = headerMap(new Request("http://localhost:3000/"), html());

      expect(headers["Strict-Transport-Security"]).toBeUndefined();
      // The rest of the document headers still apply in dev, so dev matches prod.
      expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["Content-Security-Policy"]).toBe(ENFORCED_CSP);
    });

    it("is NOT sent to a .onion host — the Tor mirror is http by design", () => {
      const headers = headerMap(
        new Request("https://p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd.onion/log"),
        html(),
      );

      expect(headers["Strict-Transport-Security"]).toBeUndefined();
    });

    it("carries no preload and no includeSubDomains", () => {
      // Deliberate and documented: `preload` is a one-way door and the operator's call;
      // `includeSubDomains` from the apex would blanket every *.fluncle.com host at once.
      const value = headerMap(httpsGet(), html())["Strict-Transport-Security"];

      expect(value).toBe("max-age=31536000");
      expect(value).not.toContain("preload");
      expect(value).not.toContain("includeSubDomains");
    });
  });
});

describe("withSecurityHeaders", () => {
  it("returns the same response object when its headers are mutable", () => {
    const response = html();
    const out = withSecurityHeaders(httpsGet(), response);

    expect(out).toBe(response);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("preserves status, existing headers and body", async () => {
    const response = new Response("<!doctype html>ok", {
      headers: { "cache-control": "public, max-age=60", "content-type": "text/html" },
      status: 404,
    });
    const out = withSecurityHeaders(httpsGet(), response);

    expect(out.status).toBe(404);
    expect(out.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await out.text()).toBe("<!doctype html>ok");
  });

  it("falls back to a re-wrap when the source headers are immutable", async () => {
    // A Response handed straight back from a `fetch()` subrequest can have guarded
    // headers; a media/proxy route must not start throwing because of this layer.
    const guarded = new Response("<!doctype html>proxied", {
      headers: { "content-type": "text/html" },
    });
    Object.defineProperty(guarded, "headers", {
      value: new Proxy(guarded.headers, {
        get(target, property) {
          if (property === "set") {
            return () => {
              throw new TypeError("immutable headers");
            };
          }

          const value = Reflect.get(target, property);

          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });

    const out = withSecurityHeaders(httpsGet(), guarded);

    expect(out).not.toBe(guarded);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await out.text()).toBe("<!doctype html>proxied");
  });

  it("leaves a 101 protocol switch entirely alone", () => {
    // Constructing a Response with status 101 is illegal, so stand one in.
    const upgrade = { headers: new Headers(), status: 101 } as unknown as Response;

    expect(withSecurityHeaders(httpsGet(), upgrade)).toBe(upgrade);
    expect(upgrade.headers.get("x-content-type-options")).toBeNull();
  });
});
