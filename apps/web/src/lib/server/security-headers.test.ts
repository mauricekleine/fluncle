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
    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["Referrer-Policy"]).toBeUndefined();
  });

  it("gives an HTML document the referrer, HSTS and the ENFORCED policy — one CSP header", () => {
    const headers = headerMap(httpsGet(), html());

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
    const headers = headerMap(
      httpsGet("https://www.fluncle.com/api/v1/search?q=ab"),
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );

    expect(headers).toEqual({ "X-Content-Type-Options": "nosniff" });
  });

  it("carries frame-ancestors INSIDE the one enforced policy", () => {
    expect(CONTENT_POLICY).toContain("frame-ancestors 'self'");

    expect(CONTENT_POLICY).toContain("object-src 'none'");
    expect(CONTENT_POLICY).toContain("base-uri 'self'");
    expect(CONTENT_POLICY).toContain("form-action 'self'");
    expect(CONTENT_POLICY).toContain("https://scripts.simpleanalyticscdn.com");
    expect(CONTENT_POLICY).toContain("https://found.fluncle.com");
    expect(CONTENT_POLICY).toContain("https://i.scdn.co");
    expect(CONTENT_POLICY).toContain("https://*.ingest.de.sentry.io");
    expect(CONTENT_POLICY).toContain("'unsafe-inline'");
    expect(CONTENT_POLICY).not.toContain("upgrade-insecure-requests");
  });

  it("allows the hosts a Cover Art Archive cover REDIRECTS to, not just the stub", () => {
    expect(CONTENT_POLICY).toContain("https://coverartarchive.org");
    expect(CONTENT_POLICY).toContain("https://archive.org");
    expect(CONTENT_POLICY).toContain("https://*.archive.org");
  });

  it("admits the radio favicon through img-src without wildcarding first-party hosts", () => {
    const imgDirective = CONTENT_POLICY.split("; ").find((directive) =>
      directive.startsWith("img-src "),
    );

    expect(imgDirective).toContain("https://radio.fluncle.com");
    expect(imgDirective).not.toContain("https://*.fluncle.com");
  });

  it("never grants 'unsafe-eval' — the one eval report is a probe that degrades", () => {
    expect(CONTENT_POLICY).not.toContain("unsafe-eval");
  });

  it("keeps font-src 'self' — Scalar uses the app font stack", () => {
    expect(CONTENT_POLICY).toContain("font-src 'self'");
    expect(CONTENT_POLICY).not.toContain("fonts.scalar.com");

    const source = readFileSync(new URL("../../routes/docs.api.tsx", import.meta.url), "utf8");

    expect(source).toContain("withDefaultFonts: false");
  });

  it("allows Cloudflare's edge-injected RUM beacon on BOTH hosts it needs", () => {
    expect(CONTENT_POLICY).toContain("https://static.cloudflareinsights.com");
    expect(CONTENT_POLICY).toContain("https://cloudflareinsights.com");
  });

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
      const headers = headerMap(
        httpsGet("https://www.fluncle.com/embed/001.A.01"),
        html({ "content-security-policy": "frame-ancestors *" }),
      );

      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000");
    });

    it("the embed route really does set its own CSP — the exemption has something to bind to", () => {
      const source = readFileSync(new URL("../../routes/embed.$logId.ts", import.meta.url), "utf8");

      expect(source).toContain('"Content-Security-Policy": "frame-ancestors *"');
    });
  });

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
      expect(sentryCspReportEndpoint("https://abc123@ingest.example.com/42", "deadbeef")).toBe(
        "https://ingest.example.com/api/42/security/?sentry_key=abc123&sentry_release=deadbeef",
      );
    });

    it("omits sentry_release when the release is unknown or empty", () => {
      for (const release of [undefined, ""]) {
        expect(sentryCspReportEndpoint("https://abc123@ingest.example.com/42", release)).toBe(
          "https://ingest.example.com/api/42/security/?sentry_key=abc123",
        );
      }
    });

    it("degrades to NO endpoint on a DSN it cannot read", () => {
      const unusable = [
        "",
        "not a url",
        "https://o1.ingest.de.sentry.io/4511752574468176",
        "https://abc123@o1.ingest.de.sentry.io",
        "https://abc123@o1.ingest.de.sentry.io/",
      ];

      for (const dsn of unusable) {
        expect(sentryCspReportEndpoint(dsn)).toBeUndefined();
      }
    });

    it("points the live endpoint at the BROWSER project's ingest", () => {
      expect(SENTRY_CSP_REPORT_ENDPOINT).toBe(
        sentryCspReportEndpoint(BROWSER_SENTRY_DSN, SENTRY_RELEASE),
      );
      expect(SENTRY_CSP_REPORT_ENDPOINT).toContain(".ingest.de.sentry.io/api/");
      expect(SENTRY_CSP_REPORT_ENDPOINT).toContain("/security/?sentry_key=");
    });

    it("attaches BOTH reporting directives to the enforced policy", () => {
      const headers = headerMap(httpsGet(), html());
      const policy = headers["Content-Security-Policy"];

      expect(policy).toContain(`report-uri ${SENTRY_CSP_REPORT_ENDPOINT}`);
      expect(policy).toContain("report-to csp-endpoint");
      expect(policy?.startsWith(`${CONTENT_POLICY};`)).toBe(true);
    });

    it("gives the report-to group a URL via Reporting-Endpoints", () => {
      const headers = headerMap(httpsGet(), html());

      expect(headers["Reporting-Endpoints"]).toBe(`csp-endpoint="${SENTRY_CSP_REPORT_ENDPOINT}"`);
      expect(headers["Report-To"]).toBeUndefined();
    });

    it("REPORTS from the enforcing header — there is no kill switch, so reports are the net", () => {
      const headers = headerMap(httpsGet(), html());

      expect(headers["Content-Security-Policy"]).toContain("report-uri");
      expect(headers["Content-Security-Policy"]).toContain("report-to");
    });

    it("withholds the sink over http — a dev session must not fire a live side channel", () => {
      const headers = headerMap(new Request("http://localhost:3000/"), html());

      expect(headers["Content-Security-Policy-Report-Only"]).toBe(CONTENT_POLICY);
      expect(headers["Content-Security-Policy-Report-Only"]).not.toContain("report-uri");
      expect(headers["Reporting-Endpoints"]).toBeUndefined();
    });

    it("withholds the sink from the .onion mirror, but still ENFORCES there", () => {
      const headers = headerMap(
        new Request("https://p53pc2uzfu2tnih4cd6wd42ok6zup2uttj6xdmjdccy5kqo33fyppkqd.onion/log"),
        html(),
      );

      expect(headers["Content-Security-Policy"]).toBe(CONTENT_POLICY);
      expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
      expect(headers["Reporting-Endpoints"]).toBeUndefined();
    });

    it("leaves LOCAL DEV advisory — the one origin where enforcing can only cost", () => {
      for (const origin of ["http://localhost:3000/", "http://127.0.0.1:3000/"]) {
        const headers = headerMap(new Request(origin), html());

        expect(headers["Content-Security-Policy-Report-Only"]).toBe(CONTENT_POLICY);
        expect(headers["Content-Security-Policy"]).toBeUndefined();
      }
    });

    it("sends no reporting header to a route that owns its own CSP", () => {
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

          switch (property) {
            case Symbol.iterator:
              return target[Symbol.iterator].bind(target);
            case "append":
              return target.append.bind(target);
            case "delete":
              return target.delete.bind(target);
            case "entries":
              return target.entries.bind(target);
            case "forEach":
              return target.forEach.bind(target);
            case "get":
              return target.get.bind(target);
            case "getSetCookie":
              return target.getSetCookie.bind(target);
            case "has":
              return target.has.bind(target);
            case "keys":
              return target.keys.bind(target);
            case "values":
              return target.values.bind(target);
            default:
              return undefined;
          }
        },
      }),
    });

    const out = withSecurityHeaders(httpsGet(), guarded);

    expect(out).not.toBe(guarded);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await out.text()).toBe("<!doctype html>proxied");
  });

  it("leaves a 101 protocol switch entirely alone", () => {
    const upgrade = { headers: new Headers(), status: 101 } as unknown as Response;

    expect(withSecurityHeaders(httpsGet(), upgrade)).toBe(upgrade);
    expect(upgrade.headers.get("x-content-type-options")).toBeNull();
  });
});
