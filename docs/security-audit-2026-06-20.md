# Security Audit — Full Codebase (2026-06-20)

## Intro

This is a full-codebase security audit of the Fluncle monorepo: the web app (`apps/web`, TanStack Start on Cloudflare Workers + Turso/libSQL), the CLI (`apps/cli`), the public SSH terminal (`apps/ssh`), the authoritative DNS server (`apps/dns`), the Raycast extension, and the supporting packages.

**Open-source threat model.** This repository is public. Source, build config, and the entire git history are visible to attackers, so the audit specifically checked three things beyond ordinary review: (1) that no secret or credential is committed anywhere in the tree or in history; (2) that the security model never relies on code obscurity — every gate must hold with the source in hand; (3) that the public↔admin trust boundary is sound. The headline result on (1) is clean (see "Committed secrets" below), which is the single most important property for a public repo.

**Remediation is deliberately deferred.** This slice produces the audit only. No code was changed. Fixes are intentionally out of scope here because they would clash with other in-flight work that cuts across the same files. Each finding below carries a concrete next step for whoever picks up remediation.

**How this audit was run.** The intended tool was **deepsec** (Vercel Labs). It could not run — see "Tooling" below. The audit was instead performed as a rigorous manual review, decomposed across nested sub-agents per area (web admin auth + the trust boundary; Turso/SQL + the DB layer; secrets + git history + supply-chain; R2/presign + outbound OAuth/integrations; the public unauthenticated HTTP surface; the Go SSH/DNS services + the CLI). Findings were deduplicated and severity-ranked centrally, and every cited `file:line` was read and confirmed to say what the finding claims — no finding rests on an unverified citation.

## Tooling: why deepsec could not run

The task specified deepsec (`https://github.com/vercel-labs/deepsec`). Per its README, deepsec requires a paid model budget: it is "configured to use the best models at maximum thinking levels, meaning scans can cost thousands or even tens-of-thousands of dollars for large codebases," and it needs an `AI_GATEWAY_API_KEY` (Vercel AI Gateway) or equivalent `ANTHROPIC_AUTH_TOKEN`/OpenAI credentials. The README's only no-key fallback (reusing a local Claude/ChatGPT subscription) self-describes as lacking "sufficient capacity for full repository scans."

In this environment none of those were available: no `AI_GATEWAY_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`VERCEL_*` env var is set, and `pnpm` (which `deepsec init` requires) is not installed. Provisioning a paid Vercel AI Gateway key is a paid-infrastructure change that repo policy (`AGENTS.md` → External Effects) requires asking before doing, and it was not pre-authorized for this slice. The audit therefore fell back to the manual, sub-agent-decomposed review described above.

## Summary

**No Critical or High findings.** The codebase is unusually security-conscious: the public↔admin trust boundary is well-built, the database layer is uniformly parameterized (zero SQL-injection / mass-assignment exposure), no live secret exists in the tree or history, and the DNS server and its systemd unit are exemplary. The findings below are Medium and lower — availability/cost hardening, minor information disclosure, and a few defense-in-depth and deployment-hygiene notes.

| # | Severity | Finding | Area |
|---|----------|---------|------|
| 1 | Medium | `/api/search` has no rate limit — unauth Spotify-credential cost/availability amplification | Public surface |
| 2 | Medium | OG/cover image routes re-render per request with no `Cache-Control` (CPU DoS) | Public surface |
| 3 | Medium | Public SSH terminal has no idle/session timeout or connection cap (DoS) | SSH (Go) |
| 4 | Low | Admin grant cookie is a 30-day stateless HMAC with no revocation path | Admin auth |
| 5 | Low | `FLUNCLE_API_TOKEN` triple-duties as bearer + grant-HMAC + OAuth-state key, no strength floor | Admin auth |
| 6 | Low | `apiErrorResponse` returns raw internal error messages to clients on unexpected errors | Public surface |
| 7 | Low | Public track reads expose operator-internal `videoModelReasoning` | Public surface |
| 8 | Low | Mixcloud `client_secret` sent in a GET query string | OAuth integrations |
| 9 | Low | Presigned R2 PUT does not constrain `Content-Length` | R2 presign |
| 10 | Low | `curl \| sh` CLI installer has no checksum verification | CLI packaging |
| 11 | Low | SSH→API client reads the response body with an unbounded `io.ReadAll` | SSH (Go) |
| 12 | Low | Submission rate-limit key falls back to spoofable `x-forwarded-for` | Public surface |
| 13 | Info | Admin-supplied distribution URLs stored unverified, surface publicly | OAuth integrations |
| 14 | Info | Non-secret IDs (R2 account id, Spinup agent id) committed in clear | Secrets/config |
| 15 | Info | `db:pull-prod` writes a full prod DB dump (incl. OAuth tokens) to a local file | Operator hygiene |

## Committed secrets — the open-source headline

**No live credential was found in the current tree or in any of the 282 commits of git history.** This was verified, not assumed. Method: `git grep <pattern> $(git rev-list --all)` across all reachable commits for every credential shape — Telegram bot token `[0-9]{8,10}:[A-Za-z0-9_-]{35}`, Discord webhook URLs, JWT `eyJ…` (Turso/auth), AWS `AKIA…`, `sk-`/`sk_`/`sk_agent_` keys, `BEGIN … PRIVATE KEY`, Firecrawl/Postiz/Loops/`client_secret=` literals — all returned **0 hits** after excluding `op://` references, `process.env` reads, and placeholders. A broad entropy sweep (every unique 40+ char token across all history in `.ts/.tsx/.go/.sh/.toml`) resolved to a closed set of 8 benign strings (Cloudflare's generated `worker-configuration.d.ts` doc-hashes, SQL index names, and the gated dev fallback in finding #14). A `--diff-filter=A` scan confirmed no `.env`, `.dev.vars`, `.pem`, `.key`, `id_rsa`, or `.db` blob was ever committed. `.dev.vars.tpl` uses `op://` 1Password references for every secret, and the wrangler `vars` block plus the two `VITE_*` values expose only non-secret public IDs/URLs.

This is the property that matters most for a public repo, and it holds.

---

## Findings

### 1. [MEDIUM] `/api/search` has no rate limit — unauthenticated Spotify-credential cost amplification

- **Where:** `apps/web/src/routes/api/search.ts:10-31` (handler); downstream `apps/web/src/lib/server/spotify.ts` (`searchTrackCandidates` → `getSpotifyAccessToken` + `/v1/search`). Also reachable unauthenticated via the MCP `search_tracks` tool (`apps/web/src/lib/server/mcp.ts:89-113`).
- **What:** `GET /api/search?q=` is fully unauthenticated with only a 2-character minimum (`search.ts:16-18`) and no per-IP limit, no result caching, and no Cloudflare Rate Limiting rule (`wrangler.jsonc` declares none). Every request calls Spotify through the operator's single shared app credential — the same `getSpotifyAccessToken` the admin add/publish flow depends on.
- **Why it matters:** An anonymous attacker can drive unbounded volume through one shared credential, exhausting Spotify's rate limit and causing 429s that break the legitimate admin add+publish flow. Pure cost/availability amplification with a single anonymous GET; source is public, so the endpoint and its shared-credential design are known.
- **Next step:** Apply the same DB-backed per-connection limiter used for submissions (`submissions.ts`) — or a Cloudflare Rate Limiting rule — to `/api/search` and the MCP `search_tracks` path, and consider short-TTL caching of identical queries.

### 2. [MEDIUM] OG/cover image routes re-render per request with no `Cache-Control` (CPU DoS)

- **Where:** `apps/web/src/routes/api/og.$logId.ts:110-122` (returns `ImageResponse`, no cache header; comment at `:13-15` claims "immutable + edge-cached"); `apps/web/src/lib/server/mixtape-cover.ts:102-109` returned by `apps/web/src/routes/api/mixtape-cover.$logId.ts:18-26`.
- **What:** Each request runs Satori + resvg WASM rendering plus `loadGoogleFont` network fetches (`og.$logId.ts:111-114`) and a remote image fetch+base64 inline. No `Cache-Control` header is set on either route (verified: no cache header anywhere in `og.$logId.ts`). workers-og's `ImageResponse` does not add cache headers by default, so the comment's promised caching does not happen — the og:image URLs already carry a `?v=<updatedAt>` query an attacker can randomize to bust any zone-default cache.
- **Why it matters:** A flood of `GET /api/og/<valid-logId>?v=<random>` forces a full WASM image render per request — disproportionate CPU for a cheap anonymous request. The route's own comment asserts a caching guarantee the code doesn't deliver.
- **Next step:** Set an explicit immutable `Cache-Control: public, max-age=31536000, immutable` on the `ImageResponse` so the existing `?v=` versioning actually caches (one render per version), matching the comment's intent.

### 3. [MEDIUM] Public SSH terminal has no idle timeout, session cap, or connection limit (DoS)

- **Where:** `apps/ssh/main.go:94-104` (`wish.NewServer` middleware stack). Only timeouts present are the 12s HTTP-client timeout and the 10s shutdown grace; no `wish.WithIdleTimeout`, `wish.WithMaxTimeout`, or max-concurrent-session cap (verified: grep for those returns nothing).
- **What:** `ssh rave.fluncle.com` is a public internet listener. `activeterm.Middleware()` requires an active terminal, but a client can open a PTY and idle indefinitely. Each session spawns a Bubble Tea program plus a galaxy sim ticking at 15 fps (`main.go:2194`), so abandoned sessions accumulate goroutines and CPU with no ceiling.
- **Why it matters:** An internet-facing listener with no idle timeout and no connection cap can be exhausted by holding many idle PTY sessions open — resource-exhaustion DoS. This is the most actionable item in the audit for a public listener.
- **Next step:** Add `wish.WithIdleTimeout(...)` and `wish.WithMaxTimeout(...)`, plus an in-process concurrent-session cap (the app already tracks sessions via `addRaver`/`removeRaver` at `main.go:240-246`, so a counter check in `sessionCountMiddleware` is a small change). Host-level firewall/fail2ban is complementary; the in-process timeout is the durable fix.

### 4. [LOW] Admin grant cookie is a 30-day stateless HMAC with no revocation path

- **Where:** `apps/web/src/lib/server/env.ts:114` (`ADMIN_GRANT_MAX_AGE_MS = 30 days`); minted in `apps/web/src/lib/server/admin-auth.ts:45-47` (`signGrant` → `{ iat, role: "admin" }`); verified in `env.ts:189-217`; logout at `apps/web/src/routes/api/admin/logout.ts:8-13`.
- **What:** The admin session cookie is a signed `{ iat, role: "admin" }` token with a 30-day window and no nonce/jti or server-side session record. Logout only clears the client cookie; it cannot invalidate a captured copy. The only revocation lever is rotating `FLUNCLE_API_TOKEN` (which also invalidates the CLI bearer and all in-flight OAuth states, since they share the key — see #5).
- **Why it matters:** The design is public, so an attacker knows that capturing the cookie value once (transient XSS, shared/stolen device, log leakage) yields a 30-day admin credential that survives "log out" and cannot be individually revoked. There is exactly one operator, so blast radius is bounded, but there is no per-session kill switch.
- **Next step:** Acceptable for a single-operator tool. If revocation is ever needed, bind the grant to a server-stored session id (or a rotating epoch counter checked at verify time) so logout/compromise can invalidate one grant without rotating the shared token. At minimum, document that token rotation is the only revocation path.

### 5. [LOW] `FLUNCLE_API_TOKEN` triple-duties as bearer + grant-HMAC + OAuth-state key, with no strength floor

- **Where:** `apps/web/src/lib/server/env.ts:118` (`requireAdmin` compares it as the bearer), `:177-183` (`signState` uses it as the HMAC key for both the admin grant and OAuth state); read via `readEnv` (`:68-78`), which only checks non-empty.
- **What:** One secret is simultaneously (a) the bearer token compared against `Authorization`, (b) the HMAC key for the admin grant cookie, and (c) the HMAC key for OAuth state — with no minimum length/entropy enforced. A short or low-entropy value would simultaneously make the bearer brute-forceable and every HMAC forgeable.
- **Why it matters:** Source is public, so the dual/triple use of this one secret is known. If the deployed value is ever weak, it is a single point of failure for the entire admin boundary. This is deployment hygiene, not a code bug.
- **Next step:** Validate a minimum length (e.g. ≥32 chars) on first read, and/or derive the HMAC key from the token via HKDF rather than signing with the raw bearer, so a bearer leak doesn't equal a signing-key leak. Lowest-effort fix is a documented strong-token requirement plus a length assertion.

### 6. [LOW] `apiErrorResponse` returns raw internal error messages to clients on unexpected errors

- **Where:** `apps/web/src/lib/server/http-errors.ts:10`. Public handlers using it include submissions, newsletter, search, `tracks.$idOrLogId`, preview; the OAuth callbacks reflect provider error strings via the same pattern (`apps/web/src/routes/api/admin/spotify/auth/callback.ts:56-62` and the YouTube/Mixcloud equivalents).
- **What:** For any non-`ApiError` thrown in a handler, the 500 response body is `error instanceof Error ? error.message : String(error)`. Notably, `spotifyFetch`/`readApiError` (`apps/web/src/lib/server/spotify.ts:486-505`) throws raw `Error` strings carrying Spotify's upstream status/body, which would surface verbatim to an anonymous caller of `/api/search` on an upstream failure.
- **Why it matters:** Information disclosure of internal/upstream error detail to unauthenticated clients. These are single-line Workers messages, not stack traces, and no secret was observed in these paths, so impact is limited — but error text shouldn't be reflected.
- **Next step:** Return a generic message for the non-`ApiError` branch and log the detail server-side, reserving descriptive messages for intentional `ApiError`s.

### 7. [LOW] Public track reads expose operator-internal `videoModelReasoning`

- **Where:** `apps/web/src/lib/server/tracks.ts:69` (`TRACK_SELECT` includes `video_model_reasoning`), mapped at `:146` (`videoModelReasoning`). Flows to `/api/tracks`, `/api/tracks/$idOrLogId`, `/api/tracks/random`, `/api/stories`, `/api/mixtapes` members, and MCP `get_recent_tracks`/`get_random_track`.
- **What:** Every public track read returns `videoModelReasoning` (which AI model rendered the video and why) — operator-internal pipeline metadata never rendered in the public UI.
- **Why it matters:** Minor information disclosure of internal tooling detail. No PII, submitter identity, or secrets. (Verified that `submitter_hash`, `user_id`, `contact`, and pending/draft submissions are correctly absent from public projections.)
- **Next step:** Drop `video_model`/`video_model_reasoning` from the public `TRACK_SELECT`, or split a public projection from the admin one.

### 8. [LOW] Mixcloud `client_secret` sent in a GET query string

- **Where:** `apps/web/src/lib/server/mixcloud.ts:44-53` — the token exchange builds `client_id`/`client_secret`/`code`/`redirect_uri` into `URLSearchParams` and does `fetch(\`${mixcloudTokenUrl}?${params}\`)`, a GET with the secret in the query string.
- **What:** Secrets in URLs are logged by proxies, CDN access logs, and referrer chains more readily than secrets in headers/bodies. Here it is a server-to-server HTTPS call to `www.mixcloud.com`, so exposure is limited to Mixcloud's endpoint logging and any TLS-terminating egress proxy — but it is the weakest secret-handling pattern in the audited set. By contrast Spotify sends its secret as a Basic auth header and YouTube as a POST form body.
- **Why it matters:** Defense-in-depth; the residual leak channel is provider/proxy logs. Mixcloud's documented OAuth flow forces a GET-with-query shape, so it is partly a provider constraint.
- **Next step:** Confirm whether Mixcloud accepts a POST form body; if not, accept as a documented provider constraint. No other code change required.

### 9. [LOW] Presigned R2 PUT does not constrain `Content-Length`

- **Where:** `apps/web/src/lib/server/r2-presign.ts:76-80` (signs `content-type` but not `content-length`); TTL is `PRESIGN_TTL_SECONDS = 3600` (`r2-presign.ts:22`). Minted only by the admin-gated `apps/web/src/routes/api/admin/tracks.$trackId.video.uploads.ts:26,78`.
- **What:** The presigned upload URL binds the object key (server-derived) and Content-Type into the signature, but not Content-Length. Within the 1-hour window, a presigned PUT for `<logId>/footage.mp4` could upload an arbitrarily large body.
- **Why it matters:** Minor abuse ceiling, and admin-only — an attacker would need the admin token to mint such a URL, and the key is one the server chose (no path traversal, no bucket-wide write — all verified sound). Worth noting as defense-in-depth on the storage-cost dimension.
- **Next step:** Bind a max `Content-Length` (or `Content-Length-Range`) into the presign so an oversized upload is rejected at the edge. Optional.

### 10. [LOW] `curl | sh` CLI installer has no checksum verification

- **Where:** `apps/web/src/routes/cli/latest[.]sh.ts:44,60` (served as `https://www.fluncle.com/cli/latest.sh`). The Homebrew formula does pin sha256 (`apps/cli/packaging/homebrew/fluncle.rb`), so the shell installer is the weaker channel.
- **What:** The generated installer downloads `fluncle-<platform>-<cpu>` from `github.com/.../releases/latest/download/...` over HTTPS and `chmod 755` + moves it into `$HOME/.local/bin` with no sha256 verification. The script is otherwise clean: `set -eu`, HTTPS-only, temp file + cleanup trap, unprivileged user path, no `sudo`.
- **Why it matters:** Standard `curl|sh` trust model plus no integrity check — a compromised GitHub release artifact (or a TLS-stripping MITM) would execute unverified. On par with most installers, hence Low.
- **Next step:** Publish a `.sha256` alongside each release asset and have the installer verify it before the `mv`. Acceptable as-is for the threat model.

### 11. [LOW] SSH→API client reads the response body with an unbounded `io.ReadAll`

- **Where:** `apps/ssh/main.go:2062` (`doJSON`: `io.ReadAll(response.Body)`). By contrast the DNS client caps reads at 1 MiB (`apps/dns/api.go:161`, `io.LimitReader(res.Body, 1<<20)`).
- **What:** The SSH app reads the Fluncle API response with no size limit. Upstream is Fluncle's own first-party API, so this only bites if that origin is compromised or returns an unexpectedly huge body — but it is an inconsistency with the DNS client's correct pattern.
- **Why it matters:** Low — same-origin trust limits exposure; flagged for consistency and defense-in-depth.
- **Next step:** Wrap with `io.LimitReader` mirroring the DNS client.

### 12. [LOW] Submission rate-limit key falls back to spoofable `x-forwarded-for`

- **Where:** `apps/web/src/lib/server/submissions.ts:379-386` (`hashSubmitter`).
- **What:** The per-submitter rate-limit key prefers `cf-connecting-ip` (set by Cloudflare, unspoofable when traffic transits CF) but falls back to the first `x-forwarded-for` value, which is attacker-controlled. If the Worker were ever reachable directly (not through CF), an attacker could rotate `x-forwarded-for` to mint a fresh rate-limit bucket per request and defeat the 5/hour cap.
- **Why it matters:** Behind Cloudflare (the deployed posture) `cf-connecting-ip` is always present, so this is Low/defense-in-depth. It becomes real only if the origin is exposed directly.
- **Next step:** Drop the `x-forwarded-for` fallback (prefer `cf-connecting-ip` only, treating its absence as "unknown"), and ensure the Worker is only reachable through Cloudflare.

### 13. [INFO] Admin-supplied distribution URLs stored unverified and surface publicly

- **Where:** `apps/web/src/routes/api/admin/mixtapes.$mixtapeId.mixcloud.finalize.ts:23-32`; `apps/web/src/lib/server/social.ts:122-163`; `apps/web/src/lib/server/mixtape-social.ts:88-137`.
- **What:** The admin-supplied `url`/`externalId` is stored as the public listen link with only a non-empty-string check — no host allow-list (e.g. must be `mixcloud.com`/`youtu.be`). It later renders on `/log`, `/mixtapes`, RSS, and llms.txt. (YouTube finalize is safer: it constructs `https://youtu.be/${videoId}` from the reported id rather than trusting a full URL.)
- **Why it matters:** Admin-gated, so self-inflicted only — not attacker-reachable. Noted because the value flows to public surfaces; if those ever render the URL unescaped or an admin token leaks, a bad URL would propagate.
- **Next step:** Optionally validate the host of admin-supplied distribution URLs against the platform.

### 14. [INFO] Non-secret IDs committed in clear (intentional, non-credential)

- **Where:** `apps/web/wrangler.jsonc:20` (`R2_ACCOUNT_ID`), `:24` (`SPINUP_ENRICH_AGENT_ID`); mirrored in `.dev.vars.tpl`. A gated dev fallback auth secret also lives at `apps/web/src/lib/server/public-auth.ts:27`, used only when `BETTER_AUTH_SECRET` is unset **and** `import.meta.env.DEV` is true; production throws if the real secret is missing (`public-auth.ts:69-79`).
- **What:** These are identifiers, not credentials; the matching secrets (`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, `SPINUP_ENRICH_AGENT_KEY`) are Worker secrets read from `process.env`, never checked in. The dev fallback is correctly gated and cannot reach production.
- **Why it matters:** None — an account id or agent id alone grants nothing, and the dev fallback is a safe pattern. Listed so a reader doesn't mistake the hex/string for a key.
- **Next step:** None required.

### 15. [INFO] `db:pull-prod` writes a full prod DB dump (including OAuth tokens) to a local file

- **Where:** `apps/web/scripts/db-pull-prod.ts` → output `apps/web/.dev/seed.sql` (path is gitignored: `.gitignore` `apps/web/.dev/`).
- **What:** Dumps every table, including the `*_auth` OAuth-token tables, to a local file. The path is gitignored, so this is operator-local, not a repo exposure. Turso prod creds are read at runtime from 1Password and never printed.
- **Why it matters:** Operator hygiene only — the dump is real production token material sitting on a local disk.
- **Next step:** Keep `apps/web/.dev/` off any synced/backup paths. No code change.

---

## Coverage — verified sound

These areas were reviewed in depth and found sound; recording them so the audit's coverage is auditable.

- **Admin trust boundary.** Constant-time bearer comparison via `timingSafeEqual` (`env.ts:117-131,227-236`) — no `===` on any secret. The allow-list (`admin-auth.ts:25-43`) is exact, case-correct, and fail-closed (empty/missing env denies all, never allows all). Every one of the 34 `/api/admin/*` route files gates with `requireAdmin` as its first statement, except the intentionally-public login front door and the OAuth callbacks, which are instead gated by HMAC-signed state with a 10-minute window. The `/api/v1/*` mirror re-imports the identical `serverHandlers` objects (no parallel ungated surface). The admin grant cookie sets `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` (prod). HMAC is verified before `JSON.parse` (no parse-before-verify); a valid OAuth state cannot be replayed as an admin grant (role check).
- **CSRF / IDOR.** State-changing `/api/me/*` routes enforce JSON content-type + same-origin (origin/referer) + a signed double-submit CSRF token bound to `user.id` (`public-auth.ts:216-256`). Every `/api/me/*` read/write/delete/export is scoped server-side to the session's `user.id` — no IDOR. better-auth config is sound (secret required in prod, explicit `trustedOrigins`, no `disableCSRFCheck`, no `crossSubDomainCookies`). The public/admin auth modules are physically isolated, enforced by `public-auth-boundary.test.ts`.
- **Database layer.** Uniformly parameterized — zero SQL injection, ORDER BY/identifier injection, mass-assignment, or unbounded-pagination exposure across all SQL-building modules and all 23 Drizzle migrations. The generic admin update path (`track-update.ts`) and mixtape update use hardcoded `column = ?` allow-lists and never spread the request body. `LIMIT` is coerced-and-capped everywhere (max 48/50/54). Turso creds are read from `process.env` only, with no hardcoded fallback and no prod-from-test path; the URL/token are never logged. Migrations contain no destructive unscoped statements and no embedded secret values.
- **Public input surface.** Submissions enforce a strict `^[A-Za-z0-9]{22}$` Spotify-id regex + URL/id cross-check + honeypot + a DB-backed 5/hour per-submitter rate limit, and re-fetch authoritative metadata from Spotify rather than trusting client `title`/`artists` (no stored-XSS path into the admin UI). Newsletter caps email length, avoids header injection and enumeration (same `{ ok: true }` whether or not already subscribed), and is idempotent to Loops. The preview/OG/cover proxies have no SSRF (URLs are DB/provider-derived, never attacker-supplied) and no injection (params constrained by the lookup gate's charset; OG escapes title/artist). `/api/health` returns only `{ ok: true }`. CORS `*` appears only on `/api/preview` and `/mcp`, both serving public credential-free data with no `Access-Control-Allow-Credentials`. The MCP `submit_track`/`subscribe_newsletter` tools call the exact same validated, rate-limited functions as the HTTP routes — no softer back door.
- **R2 presign + OAuth integrations.** The presigned-upload object key is fully server-derived (`<logId>/<artifact>` from a DB row + a fixed artifact allow-list) — no path traversal, no bucket-wide write; key segments are `encodeURIComponent`'d and the bucket is a hardcoded constant. All OAuth `start` handlers mint signed state with a nonce + purpose + 10-minute window, verified constant-time on every callback; `redirect_uri` is a fixed env var for Spotify/YouTube; post-auth redirects are fixed relative paths (no open redirect). Refresh/access tokens are stored server-side, never in client-readable cookies; the login path discards Spotify tokens after reading identity. No SSRF in any integration client; Telegram/Discord are outbound-only (no inbound webhook to verify); secrets travel in headers/bodies (except Mixcloud, finding #8) and are never logged.
- **Go services + CLI.** The SSH server is intentionally anonymous and can reach only public endpoints; it carries no credential and has no shell-out/command-injection surface (commands parse into a closed enum; coordinates are `url.PathEscape`'d; terminal-escape bytes are stripped from server-supplied link fields). The host key is generated/persisted to a gitignored path — no key committed. The DNS server is not an open resolver (anything outside the zone → REFUSED, never recurses, no amplification), exposes no inbound control API (`api.go` is an outbound client), bounds malformed packets via `miekg/dns`, sanitizes TXT assembly, and its systemd unit is exemplary (`DynamicUser`, `CAP_NET_BIND_SERVICE` only, `NoNewPrivileges`, `ProtectSystem=strict`, syscall filter). The CLI never writes/logs the token, talks HTTPS to a first-party origin with no command-line origin override, and its packaging pins sha256 for Homebrew + uses OIDC trusted publishing for npm.
- **Secrets / supply chain.** No live secret in tree or history (method above). `.gitignore` coverage is complete (`.env`, `.dev.vars`, `apps/web/.dev/`, SSH host keys, build artifacts). CI workflows use `permissions: contents: read`, `persist-credentials: false`, reference secrets only by name, and publish to npm via OIDC (no token). `bun.lock` is committed with integrity hashes; no `git+`/`*`/`latest`/`file:` dependency ranges; lifecycle scripts are benign and first-party. Go modules have no `replace` directives and use reputable sources.

## Recommended program-level next steps (not blockers)

- Run `bun audit` (or `bun pm audit`) and `govulncheck ./...` in `apps/ssh` and `apps/dns` for live CVE coverage. This audit did not fabricate CVE claims; a version-by-eye review is not a substitute for the vulnerability database.
- Add a `gitleaks`/`trufflehog` pre-commit or CI step so the clean git history stays clean as the public repo grows.
- Consider a Cloudflare Rate Limiting rule as a blanket backstop for the unauthenticated surface (covers findings #1 and #2 at the edge in addition to any app-level fix).
