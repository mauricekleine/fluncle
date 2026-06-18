# RFC: Optional User Accounts — private persistence inside the Galaxy

**Status:** Final (research → taste pass → 4-role adversarial panel synthesized, 2026-06-18) — completeness standard applied.
**For:** A fresh build session or team of agents implementing the complete private account/persistence layer.
**Canon/authority:** `PRODUCT.md`, `DESIGN.md`, `VOICE.md`, `docs/ROADMAP.md`, `docs/track-lifecycle.md`, `docs/track-submissions.md`, and the current codebase arbitrate; this RFC is planning, not canon.

> Process note: divergent research covered data/platform, auth/security, product/brand/community, and cross-surface implementation. A taste pass and adversarial reviews from staff engineering, security/privacy, and product/brand corrected the scope: complete means the private account layer is whole, not that Fluncle ships a public community platform in the same cut.

## The standard (definition of done)

The complete delivery is **optional private persistence**: a signed-in listener can keep their place in the Galaxy, save findings, see their own submissions, export/delete account data, and then leave without damaging anonymous Fluncle. Public identity and public writing are not half-built in this delivery; they are explicitly gated future layers with their own moderation standard.

Nothing in the private account layer is deferred: auth isolation, schema, migrations, CSRF/origin checks, durable rate limits, privacy/export/deletion, Galaxy semantics, anonymous-mode regression tests, web UI, and documentation all ship together. The only sanctioned “not now” items are honest dependency boundaries: D1 is not chosen unless Fluncle deliberately does a data-platform migration; Durable Objects wait until there is a live coordination problem; public crew cards and crew notes wait for a separate public-marginalia RFC.

## 0. Summary / the reframe

- The unifying simplification: **an account is a private overlay on the immutable Log ID spine**. It remembers a person around existing findings; it never authors Fluncle’s log, changes what a finding is, affects publishing, or changes anonymous access.
- The smallest beautiful version is whole: sign in, sync lifetime Galaxy progress, save findings, attach signed-in submissions, view own submission history, export data, delete the account, and keep anonymous mode intact.
- Keep canonical account data in **Turso/libSQL through the existing Drizzle migration workflow**. Cloudflare D1 is Cloudflare’s SQLite platform and is viable, but here it would be a platform migration. Durable Objects are for future live presence/rooms/write serialization, not private profiles/progress/submissions.
- Public auth is hard-separated from admin auth: separate env secrets, routes, cookies, sessions, bearer tokens, state rows, modules, and tests. Public auth must never import or reuse `requireAdmin`, admin cookie names, or admin signing helpers.
- Persist **lifetime collection** separately from **active run cargo**. The current Galaxy clears per-run cargo on tow/reset; account persistence must not erase the game’s stakes.
- Public crew cards, public submission credit, and crew notes are designed only as future gates. If they ship later, they must remain tertiary to the finding and pass a separate moderation/privacy review.

## 1. Context & goals

Fluncle is already a multi-surface archive: every finding has a `tracks` row, a Log ID, a web page, API reads, CLI/SSH/MCP representations, RSS, social captions, and Galaxy placement. `docs/ROADMAP.md` calls out user accounts because the Galaxy currently keeps collected bangers only in runtime state.

The goal is to let a person sign in so Fluncle remembers their private place in the Galaxy without turning the product into a social app. Signed-out visitors still browse, play, submit, subscribe, use APIs, and open platform links.

Non-goals for this RFC: follower graphs, public likes, leaderboards, crowd tagging, public vibe voting, public profiles, generic forums, DMs, open comments, app-style notifications, and any weakening of operator-owned publishing.

## 2. Product model: your place, not Fluncle’s log

The public logbook belongs to Fluncle. The account layer should not call the user a co-author of the canonical log. UI copy should lead with **Your place in the Galaxy**, **Saved findings**, **Galaxy progress**, and **Your submissions**. “Your logbook” may appear only as explanatory copy, and must be defined as a private bookmark/progress overlay that never edits Fluncle’s log.

Private account use cases in scope:

- **Lifetime Galaxy progress:** the set of findings a user has ever logged, plus first/last played time and aggregate deaths/wins.
- **Saved findings:** private saves for tracks the user wants to revisit, separate from game progress.
- **Submission ownership:** signed-in submissions are attached server-side to the user, while anonymous submissions continue to work.
- **Submission history:** the user can see their own pending/approved/passed-on submissions.
- **Data rights:** export and deletion are product features.

Public-account adjacent ideas out of scope for this RFC:

- **Public crew credit:** possible later, opt-in and operator-approved, attached narrowly to a finding.
- **Public crew cards:** possible later, private by default, no follower graph or activity feed.
- **Crew notes:** possible later as one-note-per-finding marginalia, not comments; no replies, votes, feeds, links, or composer above the canonical log content.

Public copy terms: Sign in, Save, Saved findings, Galaxy progress, Your submissions, sent for review, logged, passed on, export, delete. Keep profile, thread, notification, community, bio, avatar, and moderation as internal terms unless VOICE explicitly canonizes them.

## 3. Data platform decision

Use the existing Turso/libSQL database as the canonical store for private account data.

The repo already has this path: `apps/web/src/lib/server/db.ts` creates the libSQL client from `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; `apps/web/src/db/schema.ts` is the schema source; `apps/web/drizzle.config.ts` uses `dialect: "turso"`; `apps/web/package.json` exposes `bun run --cwd apps/web db:generate` and `db:migrate`; generated migrations live under `apps/web/drizzle/`.

D1 is Cloudflare’s managed serverless SQLite database with Worker and HTTP API access, built-in disaster recovery, and scale-out across smaller databases. Drizzle supports D1 and Durable Object SQLite. Those facts do not make D1 the right incremental account store here: splitting private user data into D1 while tracks remain in Turso creates cross-store joins; moving all data to D1 is a data-platform migration and deserves its own RFC.

Durable Objects are not the account store. They are right for globally unique, strongly coordinated object-local state: live rooms, presence, multiplayer Galaxy, hot write serialization, or future realtime marginalia. Private progress, saves, submissions, export, and deletion are relational.

## 4. Migration slices and schema

Follow local conventions: generated Drizzle migrations, text primary keys, ISO timestamp strings, explicit indexes, JSON text only where values are not queried, and code-enforced ownership unless the repo deliberately moves to foreign keys.

Slice 0 must land first because it fixes an existing mismatch:

- Widen `submissions.source` typing to include `ssh` everywhere: `apps/web/src/db/schema.ts`, `apps/web/src/lib/server/submissions.ts`, CLI submission admin types, and tests. The server already accepts `ssh`, and `apps/ssh/main.go` posts it.

Slice 1: auth/session foundation:

- `users`: `id`, `created_at`, `updated_at`, `last_seen_at`, `status` (`active`, `suspended`, `deleted`), `deleted_at`.
- `user_identities`: `id`, `user_id`, `provider`, `provider_subject`, `provider_username`, `provider_email`, `provider_email_hash`, `created_at`, `last_used_at`; unique `(provider, provider_subject)`.
- `user_sessions`: `id_hash`, `user_id`, `surface` (`web`, `cli`, `ssh`, `mcp`), `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `ip_hash`, `user_agent_hash`; indexes `(user_id, expires_at)` and `(expires_at)`.
- `user_auth_states`: `id_hash`, `purpose`, `provider`, `redirect_uri`, `code_verifier_hash`, `expires_at`, `consumed_at`, `ip_hash`, `user_agent_hash`; index `(purpose, expires_at)`.
- `user_device_codes`: `id_hash`, `user_id`, `surface`, `expires_at`, `consumed_at`, `created_at`, `ip_hash`, `user_agent_hash`; only needed when CLI/SSH login ships.
- `rate_limit_events`: `id`, `action`, `bucket`, `user_id`, `ip_hash`, `user_agent_hash`, `created_at`; indexes `(action, bucket, created_at)`, `(user_id, action, created_at)`, `(ip_hash, action, created_at)`.

Slice 2: private persistence:

- `user_galaxy_state`: `user_id`, `created_at`, `updated_at`, `last_played_at`, `deaths`, `wins`, `schema_version`.
- `user_galaxy_collections`: `id`, `user_id`, `track_id`, `log_id`, `first_collected_at`, `last_collected_at`, `source_surface`; unique `(user_id, track_id)`, indexes `(user_id, first_collected_at)` and `(track_id, first_collected_at)`.
- `user_saved_findings`: `id`, `user_id`, `track_id`, `log_id`, `saved_at`, `note`; unique `(user_id, track_id)`.

Slice 3: submission ownership and data rights:

- Add nullable `user_id` to `submissions`; add index `(user_id, created_at)`. Keep `submitter_hash`, `contact`, and anonymous submission behavior.
- `user_data_exports`: `id`, `user_id`, `requested_at`, `completed_at`, `expires_at`, `status`, `r2_key` nullable.
- `user_deletion_requests`: `id`, `user_id`, `requested_at`, `completed_at`, `status`, `mode`, `summary_json`.

Future public marginalia slices are not part of this RFC. If pursued, they need a separate RFC before adding public profile, credit, crew-note, report, or moderation tables.

## 5. Auth token contract

Build a small Worker-native public auth layer instead of adopting Auth.js by default. Auth.js has Drizzle/SQLite adapter and WebAuthn support, but the repo has no Auth.js dependency and the app is TanStack Start on Cloudflare Workers. Add it only after a spike proves it fits this runtime better than the small custom layer.

Public auth modules:

- `apps/web/src/lib/server/public-auth.ts`: session parsing, cookie issue/clear, bearer token parsing, CSRF/origin checks, current-user lookup.
- `apps/web/src/lib/server/public-oauth.ts`: public Spotify OAuth start/callback helpers, separate from admin/publish auth.
- These modules must not import `requireAdmin`, admin cookie constants, `signState`, `verifyState`, or the admin OAuth callback helpers.

Public env keys:

- `PUBLIC_SESSION_SECRET`
- `PUBLIC_OAUTH_STATE_SECRET`
- `PUBLIC_TOKEN_PEPPER`
- Prefer a separate public Spotify OAuth app. Minimum env split: `PUBLIC_SPOTIFY_CLIENT_ID`, `PUBLIC_SPOTIFY_CLIENT_SECRET`, `PUBLIC_SPOTIFY_REDIRECT_URI`.

Browser sessions:

- Production cookie: `__Host-fluncle_session`; local dev may use `fluncle_session`.
- Attributes: `HttpOnly`, `Secure` in production, `SameSite=Lax` or `Strict`, `Path=/`, no `Domain`.
- Cookie value: opaque high-entropy random token. Store only an HMAC/hash in `user_sessions`.
- Rotate session ID after login, identity linking, and privilege-sensitive changes.

Bearer/device tokens:

- Prefix public user tokens visibly, e.g. `fluncle_user_`.
- Generate high-entropy random tokens; store only an HMAC/hash with `PUBLIC_TOKEN_PEPPER`.
- Record `surface`, expiry, revocation, created/last-used metadata, and optional scope.
- Never return a token again after creation.
- Device codes for CLI/SSH are short-lived, single-use, rate-limited, and bound to a pending device row.

OAuth:

- Public Spotify OAuth uses Authorization Code with PKCE (`S256`) and identity scopes only.
- Public OAuth state is stored in `user_auth_states`, consumed exactly once, expires quickly, and is bound to provider, purpose, redirect URI, code verifier metadata, IP/user-agent hashes where appropriate.
- Public callbacks never write `spotify_auth`, never call publish-token exchange helpers, never request playlist scopes, and never branch through the admin callback.

CSRF/origin:

- Add `requirePublicMutationProtection(request, session)`.
- Cookie-authenticated POST/PATCH/DELETE must validate same-origin `Origin` or `Referer`, require JSON content type unless explicitly form-based, and require a CSRF token.
- Bearer-auth API calls do not use CSRF but still require JSON content type and rate limits.

Tests must prove public cookies/tokens fail `requireAdmin()`, admin bearer/cookie fails `/api/me`, public OAuth state cannot be accepted by admin callbacks, and admin state cannot be accepted by public callbacks.

## 6. Route file map

Use exact TanStack route file names during implementation. URL notation with `:param` is only explanatory; files use the repo’s `$param` convention.

Initial web/API files:

- `apps/web/src/routes/api/auth/spotify/start.ts` → `POST /api/auth/spotify/start`
- `apps/web/src/routes/api/auth/spotify/callback.ts` → `GET /api/auth/spotify/callback`
- `apps/web/src/routes/api/auth/logout.ts` → `POST /api/auth/logout`
- `apps/web/src/routes/api/me.ts` → `GET /api/me`
- `apps/web/src/routes/api/me/profile.ts` → `PATCH /api/me/profile`
- `apps/web/src/routes/api/me/galaxy-progress.ts` → `GET /api/me/galaxy-progress`, `PUT /api/me/galaxy-progress`
- `apps/web/src/routes/api/me/galaxy-progress/logs.ts` → `POST /api/me/galaxy-progress/logs`
- `apps/web/src/routes/api/me/saved-findings.ts` → `GET /api/me/saved-findings`, `POST /api/me/saved-findings`
- `apps/web/src/routes/api/me/saved-findings.$trackId.ts` → `DELETE /api/me/saved-findings/:trackId`
- `apps/web/src/routes/api/me/submissions.ts` → `GET /api/me/submissions`
- `apps/web/src/routes/api/me/export.ts` → `POST /api/me/export`
- `apps/web/src/routes/api/me/export.$exportId.ts` → `GET /api/me/export/:exportId`
- `apps/web/src/routes/api/me/delete.ts` → `POST /api/me/delete`
- `apps/web/src/routes/account.tsx` → private account plate

Do not add `/crew/:handle`, public crew-note routes, or moderation routes in this RFC’s implementation. They require the public marginalia RFC.

## 7. API contracts

Public archive contracts remain anonymous and byte-compatible. Do not add private user state to `/api/tracks`; use `/api/me/*`.

`GET /api/me` returns `{ ok: true, user: null }` anonymously. When signed in, it returns a minimal private DTO: `id`, optional display handle later, `createdAt`, and feature flags. It must not expose provider subjects, email, session metadata, saved findings, submissions, or moderation state.

`GET /api/me/galaxy-progress` returns authenticated lifetime progress: `{ collectedLogIds, updatedAt, deaths, wins }`. Anonymous clients receive `401 auth_required` and continue local/session play.

`POST /api/me/galaxy-progress/logs` appends one Log ID idempotently. The server validates that the Log ID exists and maps to a current `track_id`. Tracks without Log IDs cannot be collected into lifetime account state; clients ignore them for persistence.

`PUT /api/me/galaxy-progress` merges a client set into server state. Server union semantics win by default; a destructive replace requires a separate explicit action and is out of scope.

`GET/POST/DELETE /api/me/saved-findings*` manages private saves. Saves validate `track_id` or Log ID and denormalize current Log ID for display.

`POST /api/submissions` remains anonymous-compatible. If a valid public user session exists, the server attaches `user_id`; clients cannot submit `user_id`.

`GET /api/me/submissions` returns only the signed-in user’s rows with public-safe statuses: pending review, logged, passed on.

Export/delete routes must require reauthentication or a fresh CSRF-bound session check before producing or deleting private data.

## 8. Galaxy state contract

The current game uses `Star.collected` as **active run cargo**: tow/manual reset clears it. Account persistence must not turn that into permanent run state.

Define two layers:

- **Lifetime collection:** server-backed set of Log IDs the user has ever logged while signed in or merged from local progress.
- **Active run cargo:** current sim’s `star.collected` and `collectedCount`; this still resets on tow/manual restart and still drives in-run win conditions.

Behavior matrix:

| Event               | Active run cargo                        | Lifetime collection                                         |
| ------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Signed-out launch   | Empty, as today                         | None unless local-device progress is displayed separately   |
| Signed-in launch    | Empty active cargo                      | Lifetime set available for UI markers outside win condition |
| Fresh star logged   | Mark active cargo collected             | Append Log ID to lifetime set idempotently                  |
| Tow/dry tank        | Reset active cargo to `0/N`, as today   | Preserve lifetime set                                       |
| Manual restart      | Reset active cargo to `0/N`, as today   | Preserve lifetime set                                       |
| Full run win        | Increment `wins` once per completed run | Lifetime set already contains logged stars                  |
| Catalogue growth    | New stars enter active run uncollected  | Existing lifetime set remains; new Log IDs absent           |
| Stale client Log ID | Ignore with structured warning          | Do not create orphan progress                               |

Web implementation:

- Add helpers in `apps/web/src/game/progress.ts`: `applyLifetimeMarkers`, `collectLifetimeLogIds`, `mergeProgress`.
- Do not feed lifetime collection directly into `createSim` as already-collected cargo. Render lifetime markers separately or label previously logged stars without satisfying the active run.
- On `logged` events, enqueue a best-effort `POST /api/me/galaxy-progress/logs` for that Log ID. Do not block audio/rendering.
- Optional local-device progress may exist under a versioned `localStorage` key. On sign-in, offer merge into lifetime collection; never require it for play.

SSH implementation is a separate slice after web account persistence:

- Keep `ssh rave.fluncle.com` anonymous by default.
- Device login shows a short code/URL and receives a user bearer token only for that session unless persistent client storage is explicitly chosen.
- Apply lifetime markers without turning them into active cargo.
- Add Go parity tests for lifetime-vs-active behavior.

## 9. Web surfaces

Use one private account plate, not a dashboard:

- `/account`: private account plate with Galaxy progress summary, saved findings, own submissions, and small utility actions for export/delete/sign out.
- No left nav, no metric cards, no activity feed, no public stats wall, no nested card stacks.
- Settings are a compact utility section on the account plate, not a product destination.

Enhance existing surfaces without letting account state outrank music:

- `/galaxy`: sign-in/sync affordance may appear on the gate or pause surface only; never before launch as a blocker.
- `/log/<id>`: signed-in Save state may appear after the canonical finding actions; no crew notes or public composer in this RFC.
- Home link hub: add Sign in / Your place only when account routes exist, without replacing Submit, CLI, Telegram, Playlist, or Galaxy.
- Submission dialog: signed-in mode attaches identity server-side and says the submission will appear under Your submissions; signed-out contact flow remains.

Music-first regression is a ship gate: `/`, `/log/<id>`, and `/galaxy` must still lead with finding, Log ID, cover/footage, Spotify/platform actions, and game launch, not account chrome.

## 10. CLI, SSH, MCP

The complete private account layer ships web first and preserves current CLI/SSH/MCP anonymous behavior. Cross-surface account auth is sequenced only after the web contract is stable.

CLI later:

- Add `fluncle login`, `fluncle whoami`, `fluncle logout`, `fluncle me submissions`, and `fluncle me saved`.
- Add user API helpers distinct from public and admin helpers.
- Keep `fluncle recent`, `random`, `submit`, `track get`, and open commands anonymous by default.
- Store user token separately from `FLUNCLE_API_TOKEN`.

SSH later:

- Add session-only device login for synced Galaxy lifetime markers and own submissions.
- Do not put admin or Worker secrets in SSH.

MCP later:

- Keep existing public tools and server card anonymous.
- Authenticated MCP tools need their own transport failure contracts, CORS/header tests, and server-card wording before shipping. They are not part of the private web persistence cut.

## 11. Abuse controls and rate limiting

Durable rate limiting ships with the private account foundation. Do not rely on the current in-memory newsletter limiter for account-sensitive actions.

Rate-limit actions:

- OAuth start/callback failures by IP hash, provider subject where known, and time bucket.
- Session creation, logout churn, device-code creation/verification.
- Saved finding writes, Galaxy progress writes, submission writes, export requests, deletion requests, profile edits if profile fields ship.
- Newsletter linking if account email linking is added.

Cloudflare Turnstile may be added after thresholds for anonymous/high-risk flows, but every Turnstile token must be verified server-side. Tokens are short-lived and single-use per Cloudflare’s docs.

Public writing abuse controls are reserved for the public marginalia RFC.

## 12. Privacy, deletion, export

Private accounts introduce personal data: provider identity, email if available, session metadata, music taste/progress, saved findings, submissions, export requests, deletion requests, and rate-limit metadata.

Data handling matrix:

| Data                                           | Export                             | Delete/anonymize                                                     | Retain                                    |
| ---------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| User/profile private fields                    | Yes                                | Delete or mark deleted                                               | Minimal deleted account tombstone         |
| Provider identity/email                        | Yes                                | Delete on account deletion                                           | None unless abuse/legal retention applies |
| Sessions/tokens                                | Metadata only                      | Revoke and delete hashes after retention                             | Short security retention                  |
| Galaxy lifetime progress                       | Yes                                | Delete                                                               | None                                      |
| Saved findings                                 | Yes                                | Delete                                                               | None                                      |
| Signed-in submissions                          | Yes                                | Unlink/anonymize `user_id`; keep submission record for admin history | Submission row without user identity      |
| Anonymous submission contact copied to Discord | Disclose as external copy if known | Cannot guarantee deletion from Discord history                       | Document limitation                       |
| Loops newsletter contact                       | Disclose linked status             | Unsubscribe/delete through Loops if linked and supported             | Loops processor record per Loops behavior |
| Rate-limit/IP/user-agent hashes                | Disclose summary where appropriate | Delete after retention                                               | Short abuse/security retention            |
| Exports in R2                                  | Yes                                | Delete when expired or deletion completes                            | Expire aggressively                       |
| Backups/logs                                   | Policy disclosure                  | Best-effort per platform retention                                   | Retention window only                     |

Privacy defaults:

- Account data is private by default.
- Account creation never implies newsletter consent.
- Public DTOs never expose provider subject, email, session metadata, saved findings, private progress, private submissions, rate-limit data, or deletion/export records.
- Deletion revokes sessions immediately.

The privacy policy and account UI must explain what is stored, how export/delete works, and which third-party processors are involved.

## 13. Public marginalia gate

Public crew credit, crew cards, and crew notes are future work. They are not “optional extras” inside the private account implementation.

Before any public marginalia ships, write a separate RFC that covers:

- Whether public identity belongs in Fluncle canon.
- UI placement that keeps `/log/<id>` music-first.
- One-note-per-finding model, pending-by-default review, reports, appeal/contact path, duplicate reports, profile/handle abuse, ban evasion, and operator moderation audit.
- Public/private DTO snapshots.
- Data retention for reports against a user, reports filed by a user, public notes, public credits, and moderation events.
- Whether verified email or passkey is required before public posting.

Hard default if that RFC is not written: no public profiles, no public notes, no public credits.

## 14. Sequencing & ownership

1. **Fix existing source mismatch:** widen submission source typing to include `ssh`; update CLI/admin types and tests.
2. **Auth foundation:** schema slice 1, public auth modules, env keys, public Spotify OAuth with PKCE, `/api/me`, CSRF/origin helper, durable rate limits, admin-boundary tests.
3. **Private persistence:** schema slice 2, Galaxy lifetime-progress APIs, saved findings APIs, web account plate, Galaxy lifetime markers, anonymous regression tests.
4. **Submission ownership:** schema slice 3, signed-in submission attachment, `/api/me/submissions`, anonymous submission regression tests.
5. **Data rights:** export/delete implementation, retention policy docs, privacy copy.
6. **Optional cross-surface account clients:** CLI and SSH device login after web account semantics are stable.
7. **Public marginalia RFC:** only after the private layer is complete and validated.

The critical path is auth/session isolation plus the Galaxy lifetime-vs-active state split. The biggest de-risking move is to prove every current anonymous route and client still passes before account UI grows.

## Decisions needed BEFORE handoff

1. Confirm platform choice: **Turso for canonical private account data**, no D1 split, no Durable Objects.
2. Confirm first auth carrier: **public Spotify OAuth with a separate public app/client if possible**, schema room for verified email and passkeys.
3. Confirm account UI name: recommended **Your place** / **Saved findings**, not “Your logbook” as a primary nav label.
4. Confirm Galaxy semantics: lifetime collection persists; active run cargo still resets on tow/manual restart.
5. Confirm data deletion policy in the matrix, especially signed-in submissions and Discord/Loops limitations.
6. Confirm whether CLI/SSH account auth belongs in the first build wave or only after web persistence lands.

## Acceptance criteria

- Existing anonymous routes still work without auth: `/`, `/about`, `/galaxy`, `/log`, `/log/<id>`, `/api/tracks`, `/api/tracks/<idOrLogId>`, `/api/tracks/random`, `/api/search`, `/api/submissions`, `/api/newsletter`, `/rss.xml`, `/mcp`, and agent discovery surfaces.
- Public auth cannot satisfy admin auth. Tests prove public cookies/tokens fail `requireAdmin()`, admin bearer/cookie fails `/api/me`, and public/admin OAuth state cannot cross callbacks.
- `spotify_auth` remains publish-only; public Spotify login never writes it or requests playlist scopes.
- Public OAuth state is one-time, stored, expiring, purpose-bound, provider-bound, redirect-bound, and PKCE-bound.
- Drizzle schema and generated migrations land in small slices; `ssh` submission source mismatch is fixed first.
- `/api/me` returns `user:null` anonymously and a minimal private DTO when signed in.
- Galaxy lifetime progress never counts as active run cargo. Tests cover launch, fresh log, tow, manual reset, win, catalogue growth, stale Log IDs, local merge, and SSH parity when SSH sync ships.
- Signed-in submissions attach `user_id` server-side; anonymous submissions still work with honeypot and rate limits.
- Saved findings are private and never appear in public track DTOs.
- Data export returns structured account data; deletion revokes sessions and applies the documented retention matrix.
- Music-first regression passes: `/`, `/log/<id>`, and `/galaxy` still lead with findings, Log IDs, cover/footage, Spotify/platform actions, and game launch.
- Public crew cards, notes, reports, moderation boards, and authenticated MCP tools are absent unless a later RFC explicitly adds them.
- Checks for implementation: `bun run --cwd apps/web typecheck`, `bun run --cwd apps/web build`, `bun run --cwd apps/web lint`, `bun run --cwd apps/web test`, relevant CLI tests, `go test -C apps/ssh ./...` when SSH changes, and root `bun run typecheck` if shared contracts move.
- Docs update: README/API docs for account endpoints, privacy/deletion notes, roadmap link to this RFC, and canon updates if account language is promoted.

## Risks & open questions

- Optionality drift: account sync is useful enough that future builders may accidentally make signed-out Galaxy feel second-class.
- Auth boundary failure: public user auth crossing admin/publish authority is the highest security risk.
- Game semantics: lifetime progress must not collapse the active run.
- Product creep: public identity and public writing can turn the archive into a generic community product if not held behind a separate gate.
- Platform temptation: D1 and Durable Objects are attractive but solve different problems than this RFC’s private relational overlay.

## Appendix — verifications & sources

Code paths read during research and review:

- `apps/web/src/db/schema.ts`
- `apps/web/src/lib/server/db.ts`
- `apps/web/drizzle.config.ts`
- `apps/web/wrangler.jsonc`
- `apps/web/src/lib/server/admin-auth.ts`
- `apps/web/src/lib/server/spotify.ts`
- `apps/web/src/lib/server/env.ts`
- `apps/web/src/lib/server/submissions.ts`
- `apps/web/src/lib/server/newsletter.ts`
- `apps/web/src/game/types.ts`
- `apps/web/src/game/sim.ts`
- `apps/web/src/game/game.ts`
- `apps/web/src/routes/galaxy.tsx`
- `apps/web/src/routes/log.$logId.tsx`
- `apps/web/src/lib/server/mcp.ts`
- `apps/cli/src/api.ts`
- `apps/cli/src/commands/submissions.ts`
- `apps/ssh/main.go`
- `PRODUCT.md`
- `DESIGN.md`
- `VOICE.md`
- `packages/skills/copywriting-fluncle/references/voice.md`
- `docs/ROADMAP.md`
- `docs/track-lifecycle.md`
- `docs/track-submissions.md`
- `docs/admin-tagging.md`

Current docs checked:

- Cloudflare D1 docs: D1 is managed serverless SQLite with Worker/HTTP API access, disaster recovery, and scale-out across smaller databases. https://developers.cloudflare.com/d1/
- Cloudflare Durable Objects storage docs: Durable Objects provide object-local storage and SQLite-backed storage for new namespaces; appropriate for coordination and live state. https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- Cloudflare Turnstile docs: server-side Siteverify validation is mandatory; tokens expire after five minutes and are single-use. https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- Drizzle docs: Drizzle supports Cloudflare D1 via `drizzle-orm/d1` and Durable Object SQLite via `drizzle-orm/durable-sqlite`. https://orm.drizzle.team/
- Auth.js docs: Drizzle adapters, SQLite adapter shape, and WebAuthn/passkey provider support exist, but framework/runtime fit must be proven in this repo before adoption. https://authjs.dev/
- Spotify authorization docs: public login should use Authorization Code with PKCE and identity scopes only. https://developer.spotify.com/documentation/web-api/
- OWASP Session Management and CSRF cheat sheets for cookie, session, and CSRF guidance. https://cheatsheetseries.owasp.org/
