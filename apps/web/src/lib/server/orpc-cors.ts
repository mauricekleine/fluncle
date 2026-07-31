// THE BROWSER DOOR — cross-origin access to the public `/api/v1` reads.
//
// Until this existed the public API sent no `Access-Control-Allow-Origin` at all and answered no
// OPTIONS preflight, which meant a browser extension or a web app could not read a single byte of
// it. Not throttled, not degraded: hard-blocked by the browser before the response was ever looked
// at. Every other kind of caller (a server, a CLI, a crawler, an agent) was fine, so the gap was
// invisible from the inside and total from the outside.
//
// ── WHAT GETS THE HEADER, AND WHY THE RULE IS DERIVED RATHER THAN LISTED ──────────────────────
// The allowance is `*`, which is exactly as wide as it sounds and exactly as narrow as it needs to
// be: a literal `*` FORBIDS credentialed requests by specification. A browser will not attach
// cookies to a cross-origin fetch under it, and if a caller asks for credentials anyway the browser
// refuses the response rather than the server leaking one. So `*` cannot expose a signed-in read;
// what it exposes is precisely what an anonymous `curl` already gets.
//
// That still leaves the question of WHICH ops, and the answer is derived from the composed router
// rather than written down twice:
//
//   · the op must carry NO auth middleware (the `public-unauth` tier — the same middleware chain
//     `orpc-auth-coverage.test.ts` reads to derive an op's tier, so the running router IS the
//     registry and there is no second list to drift);
//   · the method must be GET (a read; a cross-origin write is not part of this door);
//   · and the op must not be one of the two deliberate exclusions below.
//
// The classification FAILS CLOSED. A new op is invisible to this module until it matches all three
// conditions, so an admin op, an authenticated op, a write, or a path this module cannot parse gets
// no header by construction rather than by anyone remembering.

/** The exclusions: public-unauth GET ops that still must not answer a cross-origin browser. */
const CORS_EXCLUDED_OPERATIONS = new Set<string>([
  // Mints a short-lived read-only replica credential for the requesting device. It carries no auth
  // middleware because the device proves itself in the request body rather than at the tier, but
  // handing its response to arbitrary origins is the one thing a credential-minting read must not
  // do. Already `no-store` at the mount for the same family of reasons.
  "get_replica_token",
  // The signed-in user's own door. It answers user-or-null off the session cookie, and under `*` no
  // cookie ever rides, so a cross-origin caller would get a permanent, confident `null` — a wrong
  // answer dressed as a real one. Better to have no door than a lying one.
  "get_current_private_user",
]);

/** The methods the door opens for. A read, and the preflight that asks about a read. */
const CORS_ALLOWED_METHODS = "GET, OPTIONS";

/**
 * The request headers a cross-origin caller may set. Deliberately short: this surface takes its
 * whole input from the URL, so a caller needs nothing beyond content negotiation.
 */
const CORS_ALLOWED_HEADERS = "Accept, Content-Type";

/** How long a browser may cache the preflight answer. A day; the policy does not move. */
const CORS_MAX_AGE = "86400";

/** A route template's path parameters, as oRPC spells them: `/tracks/{idOrLogId}`. */
const PATH_PARAM = /\{[^}]+\}/g;

/** Regex-special characters that must survive a literal path segment intact. */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * Compile one oRPC route path template into a matcher against a real request path.
 *
 * A path parameter matches one segment and never a slash, so `/tracks/{idOrLogId}` matches
 * `/tracks/004.7.2I` and not `/tracks/004.7.2I/similar` — which is a different op with a different
 * tier, and exactly the confusion a looser pattern would introduce.
 */
function templateToPattern(template: string): RegExp {
  const source = template
    .split(PATH_PARAM)
    .map((literal) => literal.replace(REGEX_SPECIAL, "\\$&"))
    .join("[^/]+");

  return new RegExp(`^${source}$`);
}

/** The shape this module reads off a composed router op. oRPC's `~orpc` internals are not public. */
type RouterOp = {
  "~orpc"?: {
    middlewares?: unknown[];
    route?: { method?: string; path?: string };
  };
};

/**
 * Build the set of request paths (relative to the `/api/v1` mount) that may answer a cross-origin
 * browser, straight off the composed router.
 *
 * Exported taking the router as an ARGUMENT rather than importing it, so `orpc.ts` can own the
 * router and still use this without the two modules importing each other.
 */
export function buildPublicCorsMatcher(router: Record<string, unknown>): (path: string) => boolean {
  const patterns: RegExp[] = [];

  for (const [name, op] of Object.entries(router)) {
    const meta = (op as RouterOp)["~orpc"];
    const path = meta?.route?.path;
    // oRPC leaves `method` unset on a GET, so an absent method IS a GET.
    const method = meta?.route?.method ?? "GET";

    if (
      path === undefined ||
      method !== "GET" ||
      (meta?.middlewares ?? []).length > 0 ||
      CORS_EXCLUDED_OPERATIONS.has(name)
    ) {
      continue;
    }

    patterns.push(templateToPattern(path));
  }

  return (path: string) => patterns.some((pattern) => pattern.test(path));
}

/**
 * The headers themselves.
 *
 * NO `Vary: Origin`, on purpose: the allowance is the literal `*` for every caller rather than an
 * echoed origin, so the response genuinely does not vary and saying it does would fragment every
 * cache in front of this surface by a header nobody reads.
 */
function corsHeaders(): [string, string][] {
  return [
    ["Access-Control-Allow-Origin", "*"],
    ["Access-Control-Allow-Methods", CORS_ALLOWED_METHODS],
    ["Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS],
    ["Access-Control-Max-Age", CORS_MAX_AGE],
  ];
}

/**
 * Answer a CORS preflight for a public read, or `undefined` when this is not one.
 *
 * A preflight is an OPTIONS carrying `Access-Control-Request-Method`; anything else keeps falling
 * through the dispatch chain exactly as it did. A preflight for a path that is NOT a public read
 * also falls through — the browser then blocks the real request, which is the correct outcome for
 * an admin or authenticated op and needs no special-casing here.
 */
export function corsPreflightResponse(
  request: Request,
  path: string,
  isPublicRead: (path: string) => boolean,
): Response | undefined {
  if (
    request.method !== "OPTIONS" ||
    request.headers.get("access-control-request-method") === null ||
    !isPublicRead(path)
  ) {
    return undefined;
  }

  const headers = new Headers();

  for (const [name, value] of corsHeaders()) {
    headers.set(name, value);
  }

  // 204: a preflight is an answer about the policy, never about the resource.
  return new Response(null, { headers, status: 204 });
}

/**
 * Stamp the allowance onto a public read's response, in place.
 *
 * Applied whatever the status, so a 404, a 422, or a spent-dial 429 is READABLE by the browser
 * client that caused it. A cross-origin caller that can see the success and not the refusal cannot
 * tell "no such recording" from "you are rate limited", which is the worst possible failure mode
 * for a surface whose whole argument is saying the negative out loud.
 */
export function applyPublicCors(
  request: Request,
  path: string,
  response: Response,
  isPublicRead: (path: string) => boolean,
): void {
  if (request.method !== "GET" || !isPublicRead(path)) {
    return;
  }

  for (const [name, value] of corsHeaders()) {
    response.headers.set(name, value);
  }
}
