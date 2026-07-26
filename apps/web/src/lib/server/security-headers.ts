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
//   - `Referrer-Policy` + `Strict-Transport-Security` + the framing CSP on HTML
//     DOCUMENTS only. These are document-scoped concerns; a JSON API reply, a feed, an
//     OG image, or a media proxy has no referrer to leak and no frame to protect.
//
// The embed exemption is STRUCTURAL, not a path string repeated here: a route that has
// already set its own `Content-Security-Policy` OWNS its content policy, so this layer
// leaves both CSP headers alone. `routes/embed.$logId.ts` is the one route that does
// (`frame-ancestors *`, so third parties may frame the oEmbed card), and it keeps it
// without this module knowing the path. Any future route that needs its own policy
// gets the same treatment for free.

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

/** True when this response is an HTML DOCUMENT (the only thing the document-scoped headers target). */
function isHtmlResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
}

/**
 * True when HSTS may be sent. Only over a genuine `https://` request: RFC 6797 has the
 * UA ignore the header off a non-secure transport anyway, and gating on it keeps the
 * header out of local dev (`http://localhost:3000`, where a cached HSTS pin would
 * wedge every other http localhost project on the machine) and off the .onion mirror,
 * which is served over http by design.
 */
function allowsHsts(url: URL): boolean {
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

  if (allowsHsts(new URL(request.url))) {
    headers.push(["Strict-Transport-Security", HSTS_VALUE]);
  }

  // THE STRUCTURAL EXEMPTION: a route that declared its own CSP owns its content
  // policy, so neither the enforcing framing directive nor the report-only policy is
  // layered over it. This is what keeps the oEmbed card's `frame-ancestors *` intact
  // without this module carrying `/embed/` anywhere.
  if (!response.headers.has("content-security-policy")) {
    headers.push(["Content-Security-Policy", ENFORCED_CSP]);
    headers.push(["Content-Security-Policy-Report-Only", REPORT_ONLY_CSP]);
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
