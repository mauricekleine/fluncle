// The security-response-header layer, applied at the Worker's one outermost seam
// (server.ts wraps EVERY dispatched response in `withSecurityHeaders`). Before this
// the app served no security headers at all on HTML: no nosniff, no HSTS, no
// Referrer-Policy, and no framing protection — the only CSP anywhere was the
// deliberate `frame-ancestors *` on the oEmbed card route.
//
// WHERE it sits, and why: OUTSIDE the edge cache. `withEdgeCache` stores a rendered
// document in `caches.default` for up to the fresh+SWR window (300s + 3600s on a
// detail page), so a header baked into the stored body's response would keep serving
// whatever policy was current when that document was rendered. Applying the headers
// on the way OUT — after the cache hit/miss branch, after appendOnionLocation — means
// every response carries TODAY's policy, cache hit or cold render alike, and a policy
// change takes effect on the next request instead of after the stale tail drains.
//
// WHAT is applied, and to what:
//   - `X-Content-Type-Options: nosniff` on EVERY response. It is content-type-agnostic
//     and cannot break a client: it only forbids the browser from second-guessing a
//     declared type. (Static assets — /assets, /fonts, the icons — are served by
//     Cloudflare's asset server and never reach this Worker, so public/_headers
//     carries the same nosniff for them.)
//   - `Referrer-Policy` + `Strict-Transport-Security` + the framing CSP + the report-only
//     policy and its `Reporting-Endpoints` sink on HTML DOCUMENTS only. These are
//     document-scoped concerns; a JSON API reply, a feed, an OG image, or a media proxy
//     has no referrer to leak, no frame to protect, and no subresources to police.
//
// The embed exemption is STRUCTURAL, not a path string repeated here: a route that has
// already set its own `Content-Security-Policy` OWNS its content policy, so this layer
// leaves both CSP headers alone. `routes/embed.$logId.ts` is the one route that does
// (`frame-ancestors *`, so third parties may frame the oEmbed card), and it keeps it
// without this module knowing the path. Any future route that needs its own policy
// gets the same treatment for free.

import { BROWSER_SENTRY_DSN, SENTRY_RELEASE } from "../sentry-config";

/** The one header safe on every response, whatever its content type. */
const NOSNIFF_HEADER = "X-Content-Type-Options";
const NOSNIFF_VALUE = "nosniff";

// Send the full URL to same-origin destinations, the bare origin cross-origin over
// HTTPS, and nothing when leaving HTTPS. This is already the modern browser default;
// stating it explicitly pins the behaviour for the older engines that still default to
// `no-referrer-when-downgrade` (which leaks the full path — including a /log
// coordinate or an /admin route — to every outbound link target).
const REFERRER_POLICY_VALUE = "strict-origin-when-cross-origin";

// One year, NO `preload`, and deliberately NO `includeSubDomains`.
//
// `preload` is excluded because it is a one-way door: submitting the apex to the
// browsers' baked-in list is effectively irreversible on the timescale of a shipped
// browser, and it is the operator's call, not a code change's.
//
// `includeSubDomains` is excluded on the conservative reading. The site's HTML is
// served from www.fluncle.com, where the directive would only cover
// `*.www.fluncle.com` — nothing that exists — so it buys no protection there. From the
// apex it would blanket EVERY current and future `*.fluncle.com` host at once
// (galaxy, radio, found, dig, status — status.fluncle.com is third-party hosted), and a
// single one that is not reachable over HTTPS becomes a hard outage that a primed
// browser remembers for a year with no server-side undo. Turning it on is a
// deliberate operator step once every subdomain is verified HTTPS-only; see the PR.
const HSTS_VALUE = "max-age=31536000";

/**
 * The ENFORCING policy — one directive, and only the one that has to be enforced to do
 * its job. `frame-ancestors` is the modern, iframe-scoped successor to
 * X-Frame-Options; it is inert in a report-only header (report-only never blocks), so
 * clickjacking protection cannot ride the report-only rollout below. Nothing on this
 * site frames itself cross-origin (the oEmbed card is the one framed surface, and it
 * declares its own `frame-ancestors *` — see the structural exemption above), so
 * enforcing `'self'` breaks no legitimate flow.
 */
export const ENFORCED_CSP = "frame-ancestors 'self'";

/**
 * The full content policy, shipped REPORT-ONLY. Report-only is the deliberate rollout
 * choice: the header is advisory, so a directive that turns out to be too tight
 * degrades to a console warning rather than a broken page.
 *
 * WHY `script-src` still carries `'unsafe-inline'`. TanStack does support a nonce
 * (`router.options.ssr.nonce`, threaded into both the router-managed script tags and
 * React's `renderToReadableStream`), so the framework is not the blocker — the EDGE
 * CACHE is. This app shared-caches its rendered HTML documents in `caches.default`
 * (lib/server/edge-cache.ts) and serves one stored document to many visitors. A
 * per-request nonce cannot survive that: the stored body's nonce would never match the
 * freshly-generated header value, and every inline script on every cache hit would be
 * blocked. Storing the nonce WITH the document instead makes it a fixed, publicly
 * readable string shared by every viewer of that page — which is precisely the thing a
 * nonce is supposed not to be, so it buys nothing. Hashes fail for the same reason the
 * inline content is not fixed: SSR bakes per-request router state into it. So inline
 * script stays allowed, and it is stated here rather than quietly implied.
 *
 * What the policy still buys with `'unsafe-inline'` in place:
 *   - `script-src` is still an ALLOWLIST for `src=` — the common XSS delivery vehicle
 *     (inject a `<script src="//attacker">`) is refused even though inline is allowed;
 *   - `object-src 'none'` removes the plugin/`<embed>` injection surface outright;
 *   - `base-uri 'self'` blocks a `<base>` injection from re-pointing every relative
 *     URL on the page at an attacker origin;
 *   - `form-action 'self'` stops an injected form from POSTing a password elsewhere;
 *   - `frame-src 'none'` — nothing on this site embeds an iframe;
 *   - the `img-src`/`media-src`/`connect-src`/`font-src` allowlists bound the
 *     exfiltration channels an injection could otherwise open.
 *
 * `upgrade-insecure-requests` is deliberately absent: the Tor mirror serves this same
 * markup over http:// on a .onion host, where upgrading subresources would break it.
 *
 * Every host below is derived from the code, not guessed:
 *   - scripts.simpleanalyticscdn.com — the analytics tag in routes/__root.tsx's
 *     `scripts`; queue.simpleanalyticscdn.com is where that tag beacons.
 *   - found.fluncle.com — the R2 media zone: covers/logos/avatars, the observation
 *     audio, the footage + set video, and the same-zone /cdn-cgi/image + /cdn-cgi/media
 *     transform bases (lib/media.ts). The Studio also fetches its envelope JSON there.
 *   - i.scdn.co — the Spotify cover floor an album without an owned master falls back
 *     to (`albumCoverAtSize`, lib/media.ts).
 *   - lh3.googleusercontent.com — the portrait Better Auth stores on `user.image` for a
 *     "Continue with Google" account that never uploaded one (public-auth.ts).
 *   - *.ingest.de.sentry.io — the browser SDK's ingest (lib/sentry-config.ts).
 *   - `data:` for the CSS grain tile (styles.css), `blob:` for the local avatar-crop
 *     preview (components/account/settings-door.tsx).
 *   - `'unsafe-inline'` in `style-src` because React `style={{…}}` props are style
 *     ATTRIBUTES, which no nonce covers.
 */
export const REPORT_ONLY_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-src 'none'",
  ENFORCED_CSP,
  "script-src 'self' 'unsafe-inline' https://scripts.simpleanalyticscdn.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https://found.fluncle.com https://i.scdn.co https://lh3.googleusercontent.com",
  "media-src 'self' https://found.fluncle.com",
  [
    "connect-src 'self'",
    "https://found.fluncle.com",
    "https://scripts.simpleanalyticscdn.com",
    "https://queue.simpleanalyticscdn.com",
    "https://*.ingest.de.sentry.io",
  ].join(" "),
].join("; ");

// ---------------------------------------------------------------------------
// THE REPORT SINK. A report-only policy with nowhere to report is a policy that
// produces no evidence — and no evidence means the flip to enforcing stays a guess
// forever. Sentry ingests CSP violation reports directly at a per-project "Security
// Header" endpoint, so the sink needs no route of our own, no storage, and no
// rate-limiting to write: the endpoint is derived from a DSN this repo already commits.
// ---------------------------------------------------------------------------

/**
 * The reporting group name shared by the policy's `report-to` directive and the
 * `Reporting-Endpoints` response header. Only CSP reports name this group, so nothing
 * else (deprecation, intervention, crash reports) is routed to Sentry — that would need
 * a `default` endpoint, which is deliberately not declared.
 */
const CSP_REPORT_GROUP = "csp-endpoint";

/**
 * Turn a Sentry DSN into its Security Header (CSP) ingest endpoint.
 *
 * A DSN is `https://<publicKey>@<host>/<projectId>`, and Sentry's documented CSP
 * endpoint is `https://<host>/api/<projectId>/security/?sentry_key=<publicKey>` —
 * i.e. the same three parts rearranged, which is why this is derived rather than
 * pasted: the endpoint can never drift from the DSN the SDK actually reports to.
 * `sentry_release` is the documented optional parameter that attributes a violation to
 * a build, and it is what turns "we have violations" into "THIS deploy added one".
 *
 * Returns `undefined` for anything that is not a parseable DSN with both parts. A
 * malformed DSN must degrade to "no reporting" — never to a `report-uri undefined`
 * that browsers would either reject outright or resolve against our own origin.
 */
export function sentryCspReportEndpoint(dsn: string, release?: string): string | undefined {
  let parsed: URL;

  try {
    parsed = new URL(dsn);
  } catch {
    return undefined;
  }

  const publicKey = parsed.username;
  const projectId = parsed.pathname.replace(/^\/+/, "");

  if (publicKey.length === 0 || projectId.length === 0) {
    return undefined;
  }

  const query = new URLSearchParams({ sentry_key: publicKey });

  if (typeof release === "string" && release.length > 0) {
    query.set("sentry_release", release);
  }

  return `${parsed.protocol}//${parsed.host}/api/${projectId}/security/?${query.toString()}`;
}

/**
 * The endpoint violations are POSTed to. Derived from the BROWSER project's DSN, not the
 * Worker's: a CSP violation is something a visitor's browser observed, so it belongs next
 * to the client-side errors it correlates with, in the project whose feed already covers
 * the browser.
 */
export const SENTRY_CSP_REPORT_ENDPOINT = sentryCspReportEndpoint(
  BROWSER_SENTRY_DSN,
  SENTRY_RELEASE,
);

/**
 * The report-only policy WITH the sink attached — the variant served on a real public
 * origin (see `isPublicHttpsOrigin`).
 *
 * Both reporting directives are sent, exactly as Sentry documents. `report-uri` is
 * deprecated-but-universally-supported and is the compatibility floor: Firefox and Safari
 * still have nothing else. `report-to` is the Reporting-API successor, and a browser that
 * honours it ignores `report-uri` — so naming both is additive, never duplicated. The
 * group it names is defined by the `Reporting-Endpoints` header below.
 *
 * The legacy `Report-To` JSON header (Reporting API v0) is deliberately NOT sent:
 * `Reporting-Endpoints` supersedes it in every engine that ever shipped v0, and the
 * browsers that shipped neither are covered by `report-uri` anyway.
 *
 * Falls back to the bare policy if the DSN ever fails to parse — the policy itself must
 * never depend on the sink existing.
 */
export const REPORT_ONLY_CSP_WITH_REPORTING = SENTRY_CSP_REPORT_ENDPOINT
  ? `${REPORT_ONLY_CSP}; report-uri ${SENTRY_CSP_REPORT_ENDPOINT}; report-to ${CSP_REPORT_GROUP}`
  : REPORT_ONLY_CSP;

/** The `Reporting-Endpoints` header value that gives the policy's `report-to` group a URL. */
export const REPORTING_ENDPOINTS_VALUE = SENTRY_CSP_REPORT_ENDPOINT
  ? `${CSP_REPORT_GROUP}="${SENTRY_CSP_REPORT_ENDPOINT}"`
  : undefined;

/** True when this response is an HTML DOCUMENT (the only thing the document-scoped headers target). */
function isHtmlResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
}

/**
 * True when this request came in over a genuine public `https://` origin — the gate on
 * the two headers that must not reach local dev or the Tor mirror. One predicate, two
 * reasons:
 *
 *   - HSTS. RFC 6797 has the UA ignore the header off a non-secure transport anyway, and
 *     gating on it keeps the header out of local dev (`http://localhost:3000`, where a
 *     cached HSTS pin would wedge every other http localhost project on the machine) and
 *     off the .onion mirror, which is served over http by design.
 *   - CSP REPORTING. A dev session must not fire a live side channel: every violation a
 *     local `bun run dev` or a headless browser smoke provoked would land in the operator's
 *     production Security feed, drowning the real signal in exactly the window the feed is
 *     being watched to decide the flip. And a Tor visitor's browser must never be handed
 *     an instruction to POST to sentry.io — the mirror exists so that visitor is not
 *     traceable to a third party.
 *
 * The DIRECTIVES are identical everywhere, so dev still exercises the same policy; only
 * the sink is withheld.
 */
function isPublicHttpsOrigin(url: URL): boolean {
  return url.protocol === "https:" && !url.hostname.endsWith(".onion");
}

/**
 * The security headers this request/response pair should carry, as ordered pairs.
 * Exported so the policy is unit-testable without driving a Response through the whole
 * dispatch spine.
 */
export function securityHeadersFor(request: Request, response: Response): [string, string][] {
  const headers: [string, string][] = [[NOSNIFF_HEADER, NOSNIFF_VALUE]];

  if (!isHtmlResponse(response)) {
    return headers;
  }

  headers.push(["Referrer-Policy", REFERRER_POLICY_VALUE]);

  const url = new URL(request.url);
  const isPublic = isPublicHttpsOrigin(url);

  if (isPublic) {
    headers.push(["Strict-Transport-Security", HSTS_VALUE]);
  }

  // THE STRUCTURAL EXEMPTION: a route that declared its own CSP owns its content
  // policy, so neither the enforcing framing directive nor the report-only policy is
  // layered over it. This is what keeps the oEmbed card's `frame-ancestors *` intact
  // without this module carrying `/embed/` anywhere.
  if (!response.headers.has("content-security-policy")) {
    // The ENFORCING header stays reporting-free on purpose. It carries `frame-ancestors`
    // and nothing else; a framing block is a deliberate, already-understood outcome, and
    // pointing it at the sink would mix enforced blocks into the feed the report-only
    // rollout is being read from.
    headers.push(["Content-Security-Policy", ENFORCED_CSP]);

    if (isPublic && REPORTING_ENDPOINTS_VALUE) {
      headers.push(["Content-Security-Policy-Report-Only", REPORT_ONLY_CSP_WITH_REPORTING]);
      headers.push(["Reporting-Endpoints", REPORTING_ENDPOINTS_VALUE]);
    } else {
      headers.push(["Content-Security-Policy-Report-Only", REPORT_ONLY_CSP]);
    }
  }

  return headers;
}

/**
 * Apply the security headers to a dispatched response, returning the response to serve.
 *
 * Mutates the response's headers in place when they are mutable (everything this app
 * constructs itself, plus the TanStack router's SSR responses) and falls back to a
 * re-wrap when they are not — a Response handed straight back from a `fetch()`
 * subrequest has guarded headers in some runtimes, and a proxy route must not start
 * throwing because of a header layer. A protocol-switch response (a 101 upgrade) is
 * returned untouched: it carries no body to re-wrap and no document to protect.
 */
export function withSecurityHeaders(request: Request, response: Response): Response {
  if (response.status === 101) {
    return response;
  }

  const headers = securityHeadersFor(request, response);

  try {
    for (const [name, value] of headers) {
      response.headers.set(name, value);
    }

    return response;
  } catch {
    const out = new Response(response.body, response);

    for (const [name, value] of headers) {
      out.headers.set(name, value);
    }

    return out;
  }
}
