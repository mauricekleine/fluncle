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
//   - `Referrer-Policy` + `Strict-Transport-Security` + the content policy and its
//     `Reporting-Endpoints` sink on HTML DOCUMENTS only. These are
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
 * The clickjacking directive. `frame-ancestors` is the modern, iframe-scoped successor
 * to X-Frame-Options, and it is inert in a report-only header (report-only never
 * blocks) — which is why it was the ONE directive enforced on its own during the
 * report-only rollout, while everything else was still advisory. It is now folded into
 * the one enforced policy below and no longer ships as a header of its own.
 *
 * Nothing on this site frames itself cross-origin (the oEmbed card is the one framed
 * surface, and it declares its own `frame-ancestors *` — see the structural exemption
 * above), so `'self'` breaks no legitimate flow.
 */
const FRAME_ANCESTORS = "frame-ancestors 'self'";

/**
 * The full content policy is ENFORCED, with each known source fixed at its source rather
 * than absorbed as an allowlist entry where that is possible:
 *
 *   - Simple Analytics' `<img>` beacon (queue.*) — a genuine first-party host, allowed.
 *   - Cover Art Archive covers, which 307 → archive.org → a per-node `*.archive.org`.
 *     CSP re-checks every REDIRECT HOP and reports under the ORIGINAL url, so naming
 *     only the stub read as "already allowed, still blocked" for 157 events.
 *   - zod's JIT probe (`try { new Function("") } catch {}`) reported as `blocked-uri:
 *     eval`. It degrades to the interpreted parser, so it was never a reason for
 *     `'unsafe-eval'`; `client.tsx` sets `jitless` and the reports stopped dead.
 *   - Scalar's webfonts on /docs/api, found only by a browser sweep because nothing in
 *     four days of traffic loaded that page. `customCss` already overrides Scalar's font
 *     variables, so `withDefaultFonts: false` removed 14 unused downloads instead of
 *     widening `font-src` to a third-party origin.
 *
 * The flip was gated on a real-browser sweep of 23 surfaces (public, plus the signed-in
 * /admin boards where the CAA covers actually render) collecting `securitypolicyviolation`
 * — which is what report-only alone could never give, since it only ever observes the
 * pages visitors happen to open.
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
 *   - static.cloudflareinsights.com / cloudflareinsights.com — Cloudflare's RUM beacon.
 *     NOTHING in this repo ships it: Web Analytics' automatic setup makes Cloudflare
 *     inject the tag at the edge, so it arrives whether or not the app asks. The script
 *     host and the host it POSTs to (`/cdn-cgi/rum`, read out of beacon.min.js) are
 *     different, so both are named. The policy keeps the data and allows these hosts.
 *     Injection is rare and inconsistent — 15 reports over four days against a streamed
 *     SSR response — so treat that dashboard as a biased sample, not as traffic.
 *   - `data:` for the CSS grain tile (styles.css), `blob:` for the local avatar-crop
 *     preview (components/account/settings-door.tsx).
 *   - `'unsafe-inline'` in `style-src` because React `style={{…}}` props are style
 *     ATTRIBUTES, which no nonce covers.
 */
export const CONTENT_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-src 'none'",
  FRAME_ANCESTORS,
  "script-src 'self' 'unsafe-inline' https://scripts.simpleanalyticscdn.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  // font-src stays 'self' — every face is self-hosted (Oxanium, Space Grotesk,
  // Monaspace Krypton). The one third-party font this site ever requested was Scalar's
  // on /docs/api, and that was answered by turning Scalar's fonts OFF rather than by
  // widening this line: `customCss` already re-points --scalar-font at our own stack,
  // so those 14 downloads were dead weight (routes/docs.api.tsx, withDefaultFonts).
  "font-src 'self'",
  // img-src: the owned R2 masters + the two raw fallback-cover hosts the DTOs can
  // serve (Spotify's CDN, and Cover Art Archive for crawler-minted albums with no
  // owned master yet — crawl.ts stores `coverartarchive.org/release/<id>/front-500`),
  // Google avatars, and Simple Analytics' image beacon (its script reports via an
  // <img> GET to queue.*; the analytics beacon needs this image host).
  //
  // WHY archive.org rides along with coverartarchive.org, and why naming only the
  // latter was a BUG rather than a tight policy: a CAA cover URL is a redirect stub.
  // `coverartarchive.org/release/<id>/front-500` answers 307 → `archive.org/download/…`
  // → 302 → a per-node `dn<NNNNNN>.ca.archive.org` across
  // samples; the US pool answers as `ia<NNN>.us.archive.org`). CSP re-checks EVERY
  // redirect hop, so allowing only the stub blocked the image at hop one and reported
  // it under the stub's own URL — which is exactly why FLUNCLE-WEB-6 kept firing (157
  // events) against a policy that already listed `coverartarchive.org`. Both forms are
  // needed: a `*.archive.org` wildcard does not match the bare apex the 307 lands on.
  // This is a fallback path with a shelf life — `backfill_cover_masters` replaces each
  // CAA URL with an owned master (docs/album-artwork.md), and these two entries retire
  // with the last raw one.
  "img-src 'self' data: blob: https://found.fluncle.com https://i.scdn.co https://coverartarchive.org https://archive.org https://*.archive.org https://lh3.googleusercontent.com https://queue.simpleanalyticscdn.com",
  "media-src 'self' https://found.fluncle.com",
  [
    "connect-src 'self'",
    "https://found.fluncle.com",
    "https://scripts.simpleanalyticscdn.com",
    "https://queue.simpleanalyticscdn.com",
    "https://cloudflareinsights.com",
    "https://*.ingest.de.sentry.io",
  ].join(" "),
].join("; ");

// ---------------------------------------------------------------------------
// THE REPORT SINK. During the report-only rollout this was what produced the evidence
// to flip on. Now that the policy is ENFORCED it does something more important: it is
// the only way a block that reaches a real visitor is ever noticed. There is no runtime
// kill switch — `securityHeadersFor` is sync and pure BY DESIGN, because it runs on
// every response including edge-cache hits, and a settings/env lookup there would put
// an await on the hot path — so rollback is revert-and-deploy, and these reports are
// what tells anyone a rollback is needed. Sentry ingests CSP reports at a per-project
// "Security Header" endpoint, so the sink needs no route of our own, no storage, and no
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
 * The policy WITH the sink attached — the variant served on a real public origin (see
 * `isPublicHttpsOrigin`).
 *
 * Both reporting directives are sent, exactly as Sentry documents. `report-uri` is
 * deprecated-but-universally-supported and is the compatibility floor: Firefox and Safari
 * still have nothing else. `report-to` is the Reporting-API successor, and a browser that
 * honours it ignores `report-uri` — so naming both is additive, never duplicated. The
 * group it names is defined by the `Reporting-Endpoints` header below.
 *
 * The legacy `Report-To` JSON header (Reporting API v0) is deliberately NOT sent:
 * `Reporting-Endpoints` supersedes it in engines that support it, and browsers without
 * either Reporting-API version are covered by `report-uri` anyway.
 *
 * Falls back to the bare policy if the DSN ever fails to parse — the policy itself must
 * never depend on the sink existing.
 */
export const CONTENT_POLICY_WITH_REPORTING = SENTRY_CSP_REPORT_ENDPOINT
  ? `${CONTENT_POLICY}; report-uri ${SENTRY_CSP_REPORT_ENDPOINT}; report-to ${CSP_REPORT_GROUP}`
  : CONTENT_POLICY;

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
 * True for a local development origin — and the ONLY place the policy is still advisory.
 *
 * This is deliberately NOT `isPublicHttpsOrigin`, which lumps local dev in with the
 * .onion mirror. Tor visitors read the same markup as everyone else and get the same
 * enforcement; withholding it there would serve a weaker posture for byte-identical
 * pages. Local dev is the one origin where enforcement can only cost and never protect.
 *
 * The concrete cost: vite binds `127.0.0.1:3000` (vite.config.ts + the `dev:vite`
 * script), and CSP treats `localhost` and `127.0.0.1` as DIFFERENT origins. Anyone who
 * browses `http://localhost:3000` — which is what most people type — would have their
 * HMR websocket to `ws://127.0.0.1:3000` refused by `connect-src 'self'`, killing hot
 * reload silently. Report-only still prints the same violation to the dev console, so
 * the early warning survives; only the breakage is dropped.
 */
function isLocalDevOrigin(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
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
  // policy, so nothing is layered over it. This is what keeps the oEmbed card's
  // `frame-ancestors *` intact without this module carrying `/embed/` anywhere.
  if (!response.headers.has("content-security-policy")) {
    // ONE header now, not two. Graduating the full policy to enforcing subsumes the
    // framing-only header is not sent beside it — `frame-ancestors 'self'` is a
    // directive INSIDE this policy — so the report-only slot simply stops being sent
    // rather than being duplicated.
    const policyHeader = isLocalDevOrigin(url)
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy";

    if (isPublic && REPORTING_ENDPOINTS_VALUE) {
      headers.push([policyHeader, CONTENT_POLICY_WITH_REPORTING]);
      headers.push(["Reporting-Endpoints", REPORTING_ENDPOINTS_VALUE]);
    } else {
      headers.push([policyHeader, CONTENT_POLICY]);
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
