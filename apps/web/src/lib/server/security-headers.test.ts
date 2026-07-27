import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_SENTRY_DSN, SENTRY_RELEASE } from "../sentry-config";
import {
  ENFORCED_CSP,
  REPORT_ONLY_CSP,
  REPORT_ONLY_CSP_WITH_REPORTING,
  REPORTING_ENDPOINTS_VALUE,
  securityHeadersFor,
  SENTRY_CSP_REPORT_ENDPOINT,
  sentryCspReportEndpoint,
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
      "Content-Security-Policy-Report-Only": REPORT_ONLY_CSP_WITH_REPORTING,
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Reporting-Endpoints": REPORTING_ENDPOINTS_VALUE,
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

  // THE REPORT SINK. A report-only policy with nowhere to report produces no evidence,
  // and the flip to enforcing stays a guess. These pin that the sink is wired, that it is
  // derived from the committed DSN rather than pasted, and — the half that matters just as
  // much — that it is withheld everywhere a report would be noise or a privacy leak.
  describe("CSP violation reporting", () => {
    it("derives Sentry's Security Header endpoint from a DSN", () => {
      expect(
        sentryCspReportEndpoint(
          "https://abc123@o4511752557232128.ingest.de.sentry.io/4511752574468176",
        ),
      ).toBe(
        "https://o4511752557232128.ingest.de.sentry.io/api/4511752574468176/security/?sentry_key=abc123",
      );
    });

    it("attributes a violation to the build when a release is known", () => {
      // `sentry_release` is Sentry's documented optional parameter, and it is what turns
      // "we have violations" into "THIS deploy added one".
      expect(sentryCspReportEndpoint("https://abc123@ingest.example.com/42", "deadbeef")).toBe(
        "https://ingest.example.com/api/42/security/?sentry_key=abc123&sentry_release=deadbeef",
      );
    });

    it("omits sentry_release when the release is unknown or empty", () => {
      // A shallow CI checkout leaves SENTRY_RELEASE undefined; the endpoint must stay
      // valid rather than carry an empty or literal-`undefined` release.
      for (const release of [undefined, ""]) {
        expect(sentryCspReportEndpoint("https://abc123@ingest.example.com/42", release)).toBe(
          "https://ingest.example.com/api/42/security/?sentry_key=abc123",
        );
      }
    });

    it("degrades to NO endpoint on a DSN it cannot read", () => {
      // A malformed DSN must mean "no reporting" — never a `report-uri undefined`, which a
      // browser would either reject or resolve against our own origin and POST to us.
      const unusable = [
        "",
        "not a url",
        // No public key.
        "https://o1.ingest.de.sentry.io/4511752574468176",
        // No project id.
        "https://abc123@o1.ingest.de.sentry.io",
        "https://abc123@o1.ingest.de.sentry.io/",
      ];

      for (const dsn of unusable) {
        expect(sentryCspReportEndpoint(dsn)).toBeUndefined();
      }
    });

    it("points the live endpoint at the BROWSER project's ingest", () => {
      // A CSP violation is something a visitor's browser observed, so it belongs beside
      // the client-side errors it correlates with — not in the Worker project.
      expect(SENTRY_CSP_REPORT_ENDPOINT).toBe(
        sentryCspReportEndpoint(BROWSER_SENTRY_DSN, SENTRY_RELEASE),
      );
      expect(SENTRY_CSP_REPORT_ENDPOINT).toContain(".ingest.de.sentry.io/api/");
      expect(SENTRY_CSP_REPORT_ENDPOINT).toContain("/security/?sentry_key=");
    });

    it("attaches BOTH reporting directives to the report-only policy", () => {
      const headers = headerMap(httpsGet(), html());
      const policy = headers["Content-Security-Policy-Report-Only"];

      // `report-uri` is the compatibility floor (Firefox and Safari still have nothing
      // else); `report-to` is the Reporting-API successor a modern engine prefers.
      expect(policy).toContain(`report-uri ${SENTRY_CSP_REPORT_ENDPOINT}`);
      expect(policy).toContain("report-to csp-endpoint");
      // The base policy is carried through unchanged — reporting is appended, never a
      // rewrite of the directives.
      expect(policy?.startsWith(`${REPORT_ONLY_CSP};`)).toBe(true);
    });

    it("gives the report-to group a URL via Reporting-Endpoints", () => {
      const headers = headerMap(httpsGet(), html());

      expect(headers["Reporting-Endpoints"]).toBe(`csp-endpoint="${SENTRY_CSP_REPORT_ENDPOINT}"`);
      // The legacy Reporting-API-v0 header is deliberately not sent — `Reporting-Endpoints`
      // supersedes it, and `report-uri` covers the engines that shipped neither.
      expect(headers["Report-To"]).toBeUndefined();
    });

    it("leaves the ENFORCING header reporting-free", () => {
      // It carries `frame-ancestors` and nothing else. A framing block is a deliberate,
      // already-understood outcome; routing it to the sink would mix enforced blocks into
      // the feed the report-only rollout is being read from.
      const headers = headerMap(httpsGet(), html());

      expect(headers["Content-Security-Policy"]).toBe(ENFORCED_CSP);
      expect(headers["Content-Security-Policy"]).not.toContain("report-uri");
      expect(headers["Content-Security-Policy"]).not.toContain("report-to");
    });

    it("withholds the sink over http — a dev session must not fire a live side channel", () => {
      // Every violation a local `bun run dev` or a headless browser smoke provoked would
      // otherwise land in the production Security feed, drowning the real signal in exactly
      // the window that feed is being watched to decide the flip.
      const headers = headerMap(new Request("http://localhost:3000/"), html());

      expect(headers["Content-Security-Policy-Report-Only"]).toBe(REPORT_ONLY_CSP);
      expect(headers["Content-Security-Policy-Report-Only"]).not.toContain("report-uri");
      expect(headers["Reporting-Endpoints"]).toBeUndefined();
    });

    it("withholds the sink from the .onion mirror", () => {
      // A Tor visitor's browser must never be handed an instruction to POST to sentry.io —
      // the mirror exists so that visitor is not traceable to a third party.
      const headers = headerMap(
        new Request("https://p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd.onion/log"),
        html(),
      );

      expect(headers["Content-Security-Policy-Report-Only"]).toBe(REPORT_ONLY_CSP);
      expect(headers["Reporting-Endpoints"]).toBeUndefined();
    });

    it("sends no reporting header to a route that owns its own CSP", () => {
      // The structural exemption covers the sink too: the oEmbed card gets no report-only
      // policy, so a `Reporting-Endpoints` header would name a group nothing references.
      const headers = headerMap(
        httpsGet("https://www.fluncle.com/embed/001.A.01"),
        html({ "content-security-policy": "frame-ancestors *" }),
      );

      expect(headers["Reporting-Endpoints"]).toBeUndefined();
    });

    it("sends no reporting header on a NON-document reply", () => {
      const headers = headerMap(
        httpsGet("https://www.fluncle.com/api/v1/search?q=ab"),
        new Response("{}", { headers: { "content-type": "application/json" } }),
      );

      expect(headers["Reporting-Endpoints"]).toBeUndefined();
    });
  });

  describe("HSTS is sent only where it is safe", () => {
    it("is sent over https", () => {
      expect(headerMap(httpsGet(), html())["Strict-Transport-Security"]).toBe("max-age=31536000");
    });

    it("is NOT sent over http — local dev must never pin localhost to https", () => {
      const headers = headerMap(new Request("http://localhost:3000/"), html());

      expect(headers["Strict-Transport-Security"]).toBeUndefined();
      // The rest of the document headers still apply in dev, and the DIRECTIVES are
      // identical to prod's — only the report sink is withheld, so dev exercises the same
      // policy without writing to the production Security feed.
      expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["Content-Security-Policy"]).toBe(ENFORCED_CSP);
      expect(headers["Content-Security-Policy-Report-Only"]).toBe(REPORT_ONLY_CSP);
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
