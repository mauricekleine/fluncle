import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_SENTRY_DSN, SENTRY_RELEASE } from "../sentry-config";
import {
  CONTENT_POLICY,
  CONTENT_POLICY_WITH_REPORTING,
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

  it("gives an HTML document the referrer, HSTS and the ENFORCED policy — one CSP header", () => {
    const headers = headerMap(httpsGet(), html());

    // Exactly one CSP header. A report-only or separate framing header would violate
    // the enforced policy contract.
    expect(headers).toEqual({
      "Content-Security-Policy": CONTENT_POLICY_WITH_REPORTING,
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Reporting-Endpoints": REPORTING_ENDPOINTS_VALUE,
      "Strict-Transport-Security": "max-age=31536000",
      "X-Content-Type-Options": "nosniff",
    });
    expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
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

  it("carries frame-ancestors INSIDE the one enforced policy", () => {
    // The framing directive is part of this policy — pinned because losing it would
    // silently drop clickjacking protection.
    expect(CONTENT_POLICY).toContain("frame-ancestors 'self'");

    // …and the honest policy names the hosts the app actually loads, plus the three
    // directives that harden the page even with inline script allowed.
    expect(CONTENT_POLICY).toContain("object-src 'none'");
    expect(CONTENT_POLICY).toContain("base-uri 'self'");
    expect(CONTENT_POLICY).toContain("form-action 'self'");
    expect(CONTENT_POLICY).toContain("https://scripts.simpleanalyticscdn.com");
    expect(CONTENT_POLICY).toContain("https://found.fluncle.com");
    expect(CONTENT_POLICY).toContain("https://i.scdn.co");
    expect(CONTENT_POLICY).toContain("https://*.ingest.de.sentry.io");
    // Inline script stays allowed on purpose (the edge cache makes a per-request nonce
    // unworkable — see the module comment). Pinned so removing it is a decision, not a
    // drive-by that blanks the site's hydration.
    expect(CONTENT_POLICY).toContain("'unsafe-inline'");
    // Never enforced: the Tor mirror serves this markup over http on a .onion host.
    expect(CONTENT_POLICY).not.toContain("upgrade-insecure-requests");
  });

  it("allows the hosts a Cover Art Archive cover REDIRECTS to, not just the stub", () => {
    // The bug the first watch window found: a CAA cover URL is a redirect stub
    // (307 → archive.org → 302 → dn<NNNNNN>.ca.archive.org), CSP re-checks every hop,
    // and a policy naming only `coverartarchive.org` blocks the image at hop one while
    // REPORTING it under the stub's URL. It read as "already allowed, still blocked"
    // for 157 events. Both forms are pinned because a `*.archive.org` wildcard does not
    // match the bare apex the first redirect lands on — dropping either re-breaks it.
    expect(CONTENT_POLICY).toContain("https://coverartarchive.org");
    expect(CONTENT_POLICY).toContain("https://archive.org");
    expect(CONTENT_POLICY).toContain("https://*.archive.org");
  });

  it("never grants 'unsafe-eval' — the one eval report is a probe that degrades", () => {
    // FLUNCLE-WEB-7 reports `blocked-uri: eval` from zod's JIT capability probe, which
    // wraps its `new Function` in a try/catch and falls back to the interpreted parser.
    // Nothing breaks, so the report is NOT a reason to open the policy's biggest hole;
    // it is answered at the source by `configureZod({ jitless: true })` in client.tsx.
    // Confirmed: zero eval reports in the two days after that shipped, against ~50/day
    // before — which is what made enforcing safe without opening this hole.
    expect(CONTENT_POLICY).not.toContain("unsafe-eval");
  });

  it("keeps font-src 'self' — Scalar uses the app font stack", () => {
    // Scalar's docs surface uses our own font stack (`withDefaultFonts: false` and
    // `customCss` in routes/docs.api.tsx), so `font-src` must remain self-only. The moment
    // it grows a host, that choice
    // is being reversed.
    expect(CONTENT_POLICY).toContain("font-src 'self'");
    expect(CONTENT_POLICY).not.toContain("fonts.scalar.com");

    const source = readFileSync(new URL("../../routes/docs.api.tsx", import.meta.url), "utf8");

    expect(source).toContain("withDefaultFonts: false");
  });

  it("allows Cloudflare's edge-injected RUM beacon on BOTH hosts it needs", () => {
    // Nothing in this repo ships the beacon — Web Analytics' automatic setup injects it
    // at the edge. The script host and the host it POSTs to (/cdn-cgi/rum) differ, so
    // allowing only the first would still refuse every report it tries to send.
    expect(CONTENT_POLICY).toContain("https://static.cloudflareinsights.com");
    expect(CONTENT_POLICY).toContain("https://cloudflareinsights.com");
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

    it("attaches BOTH reporting directives to the enforced policy", () => {
      const headers = headerMap(httpsGet(), html());
      const policy = headers["Content-Security-Policy"];

      // `report-uri` is the compatibility floor (Firefox and Safari still have nothing
      // else); `report-to` is the Reporting-API successor a modern engine prefers.
      expect(policy).toContain(`report-uri ${SENTRY_CSP_REPORT_ENDPOINT}`);
      expect(policy).toContain("report-to csp-endpoint");
      // The base policy is carried through unchanged — reporting is appended, never a
      // rewrite of the directives.
      expect(policy?.startsWith(`${CONTENT_POLICY};`)).toBe(true);
    });

    it("gives the report-to group a URL via Reporting-Endpoints", () => {
      const headers = headerMap(httpsGet(), html());

      expect(headers["Reporting-Endpoints"]).toBe(`csp-endpoint="${SENTRY_CSP_REPORT_ENDPOINT}"`);
      // The legacy Reporting-API-v0 header is deliberately not sent — `Reporting-Endpoints`
      // supersedes it, and `report-uri` covers engines without Reporting-API support.
      expect(headers["Report-To"]).toBeUndefined();
    });

    it("REPORTS from the enforcing header — there is no kill switch, so reports are the net", () => {
      // The inverse of the rollout-era rule. While the policy was advisory, reporting was
      // withheld from the enforced header so deliberate framing blocks could not pollute
      // the feed being read to decide the flip. Now the full policy is what blocks, and
      // `securityHeadersFor` is sync and pure by design (it runs on every response,
      // cache hits included), so there is no runtime flag to flip — rollback is
      // revert-and-deploy and these reports are the only thing that says one is needed.
      const headers = headerMap(httpsGet(), html());

      expect(headers["Content-Security-Policy"]).toContain("report-uri");
      expect(headers["Content-Security-Policy"]).toContain("report-to");
    });

    it("withholds the sink over http — a dev session must not fire a live side channel", () => {
      // Every violation a local `bun run dev` or a headless browser smoke provoked would
      // otherwise land in the production Security feed, drowning the real signal.
      const headers = headerMap(new Request("http://localhost:3000/"), html());

      expect(headers["Content-Security-Policy-Report-Only"]).toBe(CONTENT_POLICY);
      expect(headers["Content-Security-Policy-Report-Only"]).not.toContain("report-uri");
      expect(headers["Reporting-Endpoints"]).toBeUndefined();
    });

    it("withholds the sink from the .onion mirror, but still ENFORCES there", () => {
      // Two separate rules, and the split between them is the point. A Tor visitor's
      // browser must never be handed an instruction to POST to sentry.io — the mirror
      // exists so that visitor is not traceable to a third party. But the mirror serves
      // byte-identical markup, so withholding ENFORCEMENT would hand exactly that visitor
      // the weaker security posture. Silent protection, which is the correct trade.
      const headers = headerMap(
        new Request("https://p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd.onion/log"),
        html(),
      );

      expect(headers["Content-Security-Policy"]).toBe(CONTENT_POLICY);
      expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
      expect(headers["Reporting-Endpoints"]).toBeUndefined();
    });

    it("leaves LOCAL DEV advisory — the one origin where enforcing can only cost", () => {
      // vite binds 127.0.0.1:3000, and CSP treats `localhost` and `127.0.0.1` as
      // different origins — so enforcing `connect-src 'self'` would refuse the HMR
      // websocket for anyone who types `localhost`, silently killing hot reload. Dev
      // still gets the identical directives and still logs the identical console
      // warning; only the breakage is dropped. Both spellings are pinned.
      for (const origin of ["http://localhost:3000/", "http://127.0.0.1:3000/"]) {
        const headers = headerMap(new Request(origin), html());

        expect(headers["Content-Security-Policy-Report-Only"]).toBe(CONTENT_POLICY);
        expect(headers["Content-Security-Policy"]).toBeUndefined();
      }
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
      // identical to prod's — dev is advisory rather than enforcing, and the report sink
      // is withheld, so a dev session exercises the same policy and logs the same console
      // warning without breaking HMR or writing to the production Security feed.
      expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["Content-Security-Policy-Report-Only"]).toBe(CONTENT_POLICY);
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
