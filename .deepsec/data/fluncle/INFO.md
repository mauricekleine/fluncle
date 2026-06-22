# fluncle

## What this codebase does

Fluncle is a public drum & bass archive ("Fluncle's Findings"). The product surface is a Cloudflare Worker running TanStack Start (`apps/web`) that owns ALL public + admin API routes (Spotify, Telegram, Discord, Turso/libSQL mutations, R2). The HTTP API is contract-first oRPC (`@fluncle/contracts`), dual-mounted at `/api/v1` and `/api`. Persistence is Turso/libSQL via Drizzle. Other surfaces are thin clients: a Bun CLI (`apps/cli`), a Raycast extension, an Expo mobile app (`apps/mobile`), a Chrome extension (`apps/extension`), a Go SSH terminal app (`apps/ssh`), a DNS server (`apps/dns`). Background work (track enrichment, the spoken "observation", newsletter, the Hermes Discord chat agent) runs as agents that call the admin API as the `agent` role.

## Auth shape

Two completely separate identities, each with its own carrier — do not conflate them:

- **Admin tier** (`adminRole(request)` in `lib/server/env.ts`): resolves to `operator | agent | null`. `operator` = either an HMAC-signed `fluncle_admin` cookie (Login-with-Spotify, allow-listed account) OR a `FLUNCLE_API_TOKEN` Bearer; can do everything. `agent` = `FLUNCLE_AGENT_TOKEN` Bearer (Hermes/enrichment); restricted to analysis-field write-back. Token comparison MUST be constant-time (`timingSafeEqual`, `lib/server/env.ts`).
- **oRPC admin spine** (`lib/server/orpc-auth.ts`): `adminProcedure` (any admin), `operatorProcedure`/`operatorGuard` (operator-only → 403 for agent). Field-level role checks (agent may write ONLY analysis fields) are done IN the handler by reading `context.role`. Publish/irreversible ops MUST be `operatorProcedure`.
- **Private-user tier** (`/me`, `lib/server/public-auth.ts` + `account-data.ts`): Better Auth cookie session (username plugin). Mutations require `requireAccountMutation` → JSON content-type + Origin/Referer check + HMAC CSRF token (`x-fluncle-csrf`) + per-op rate limit.

## Threat model

Highest impact: an attacker reaching the **operator** tier (full publish authority over Spotify/Telegram/Discord/Turso/R2) via a token leak, an unauthenticated admin op, or an agent→operator privilege escalation (an `operator`-class op missing `operatorGuard`, or a handler that lets `role === "agent"` write non-analysis fields). Second: **untrusted-input → action** through the agent path — the observation pipeline (`lib/server/observation.ts`) pulls Firecrawl web-search results and the Hermes agent reads Discord; that text must never become an instruction, a fetched URL (SSRF), or reach ElevenLabs/the DB unmechanically-gated (there is a "voice gate" that forbids geography in spoken text). Third: SSRF/secret exfiltration via attacker-influenced URLs in the many outbound `fetch` integrations (Firecrawl, Spotify, YouTube, Mixcloud, Last.fm, Discogs, Deezer, Postiz, Telegram, ElevenLabs, R2).

## Project-specific patterns to flag

- An admin oRPC op (under `lib/server/orpc/*`) on `adminProcedure` (or a bare procedure) that performs a publish / external send / destructive write — should be `operatorProcedure`. Or an admin handler that does NOT branch on `context.role` before writing operator-only fields (agent escalation).
- The public OpenAPI doc must EXCLUDE admin ops; the filter is a `/admin/` path-prefix check in `lib/server/orpc.ts`. An admin op whose REST path is not under `/admin/` leaks into the public spec.
- A `/me` mutation handler that skips `privateUserMutation`/`requireAccountMutation` (missing CSRF/origin/rate-limit), or trusts `userId` from input instead of `context.user.id` (IDOR over another user's saved findings / galaxy progress / account export-delete).
- Firecrawl/Discord/scraped text used to build a prompt, a shell arg, a SQL fragment, or an outbound URL without sanitization (prompt injection / SSRF). Note `isLyricDomain` allow-listing and the geography "voice gate" in `observation.ts`.
- Token/secret read from env and compared with `===` rather than `timingSafeEqual`; or a secret logged / returned in a response / put on an error path.
- Go (`apps/ssh`) input handling: terminal/SSH session input, any command/exec, path handling, or unbounded allocation from remote input.

## Known false-positives

- The hardcoded `devAuthSecret` / `"...change-before-production"` in `public-auth.ts` is a DEV-ONLY fallback; production throws if `BETTER_AUTH_SECRET` is unset — not a leaked secret.
- `apps/web/.dev/` (gitignored local libSQL db), test fixtures (`*.test.ts`), and the generated OpenAPI/Postman docs are not attack surface.
- Public read endpoints (`/tracks`, `/search`, `/stories`, `/radio`, `/mcp`, RSS, `llms.txt`) are intentionally unauthenticated.
