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
- The smallest beautiful version is whole: sign up with a Galaxy username, sign in, sync lifetime Galaxy progress, save findings, attach signed-in submissions, view own submission history, export data, delete the account, and keep anonymous mode intact.
- Keep canonical account data in **Turso/libSQL through the existing Drizzle migration workflow**. Cloudflare D1 is Cloudflare’s SQLite platform and is viable, but here it would be a platform migration. Durable Objects are for future live presence/rooms/write serialization, not private profiles/progress/submissions.
- Public auth is **Better Auth**, email/password plus the `username` plugin. It is hard-separated from admin auth: separate routes, cookies, session handling, schema, and tests. Public auth must never import or reuse `requireAdmin`, admin cookie names, admin signing helpers, `FLUNCLE_API_TOKEN`, or `spotify_auth`.
- Persist **lifetime collection** separately from **active run cargo**. The current Galaxy clears per-run cargo on tow/reset; account persistence must not erase the game’s stakes.
- Public crew cards, public submission credit, and crew notes are designed only as future gates. If they ship later, they must remain tertiary to the finding and pass a separate moderation/privacy review.

## 1. Context & goals

Fluncle is already a multi-surface archive: every finding has a `tracks` row, a Log ID, a web page, API reads, CLI/SSH/MCP representations, RSS, social captions, and Galaxy placement. `docs/ROADMAP.md` calls out user accounts because the Galaxy currently keeps collected bangers only in runtime state.

The goal is to let a person sign up with a Galaxy username and sign in so Fluncle remembers their private place in the Galaxy without turning the product into a social app. Signed-out visitors still browse, play, submit, subscribe, use APIs, and open platform links.

Non-goals for this RFC: follower graphs, public likes, leaderboards, crowd tagging, public vibe voting, public profiles, generic forums, DMs, open comments, app-style notifications, and any weakening of operator-owned publishing.

## 2. Product model: your place, not Fluncle’s log

The public logbook belongs to Fluncle. The account layer should not call the user a co-author of the canonical log. UI copy should lead with **Your place in the Galaxy**, **Saved findings**, **Galaxy progress**, and **Your submissions**. “Your logbook” may appear only as explanatory copy, and must be defined as a private bookmark/progress overlay that never edits Fluncle’s log.

Private account use cases in scope:

- **Galaxy username:** the user’s normalized Better Auth `username` is their identity inside the private Galaxy layer; `displayUsername` preserves presentation.
- **Lifetime Galaxy progress:** the set of findings a user has ever logged, plus first/last played time and aggregate deaths/wins.
- **Saved findings:** private saves for tracks the user wants to revisit, separate from game progress.
- **Submission ownership:** signed-in submissions are attached server-side to the user, while anonymous submissions continue to work.
- **Submission history:** the user can see their own pending/approved/passed-on submissions.
- **Data rights:** export and deletion are product features.

Public-account adjacent ideas out of scope for this RFC:

- **Public crew credit:** possible later, opt-in and operator-approved, attached narrowly to a finding.
- **Public crew cards:** possible later, private by default, no follower graph or activity feed.
- **Crew notes:** possible later as one-note-per-finding marginalia, not comments; no replies, votes, feeds, links, or composer above the canonical log content.

Public copy terms: Sign up, Sign in, Sign out, username, Save, Saved findings, Galaxy progress, Your submissions, sent for review, logged, passed on, export, delete. Keep profile, thread, notification, community, bio, avatar, and moderation as internal terms unless VOICE explicitly canonizes them.

## 3. Data platform decision

Use the existing Turso/libSQL database as the canonical store for private account data.

The repo already has this path: `apps/web/src/lib/server/db.ts` creates the libSQL client from `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`; `apps/web/src/db/schema.ts` is the schema source; `apps/web/drizzle.config.ts` uses `dialect: "turso"`; `apps/web/package.json` exposes `bun run --cwd apps/web db:generate` and `db:migrate`; generated migrations live under `apps/web/drizzle/`.

D1 is Cloudflare’s managed serverless SQLite database with Worker and HTTP API access, built-in disaster recovery, and scale-out across smaller databases. Drizzle supports D1 and Durable Object SQLite. Those facts do not make D1 the right incremental account store here: splitting private user data into D1 while tracks remain in Turso creates cross-store joins; moving all data to D1 is a data-platform migration and deserves its own RFC.

Durable Objects are not the account store. They are right for globally unique, strongly coordinated object-local state: live rooms, presence, multiplayer Galaxy, hot write serialization, or future realtime marginalia. Private progress, saves, submissions, export, and deletion are relational.

## 4. Migration slices and schema

Follow local conventions: generated Drizzle migrations, text primary keys, ISO timestamp strings, explicit indexes, JSON text only where values are not queried, and code-enforced ownership unless the repo deliberately moves to foreign keys.

Slice 0 must land first because it fixes an existing mismatch:

- Widen `submissions.source` typing to include `ssh` everywhere: `apps/web/src/db/schema.ts`, `apps/web/src/lib/server/submissions.ts`, CLI submission admin types, and tests. The server already accepts `ssh`, and `apps/ssh/main.go` posts it.

Slice 1: Better Auth foundation:

- Add `better-auth` and wire `apps/web/src/lib/server/auth.ts` with `betterAuth({ database: drizzleAdapter(db, { provider: "sqlite" }), emailAndPassword: { enabled: true }, plugins: [username(...)] })`.
- Add the minimal runtime Drizzle client Better Auth needs, backed by the existing Turso/libSQL connection. The repo already uses Drizzle for schema/migrations but raw libSQL for most runtime queries, so this is a deliberate auth-local addition, not a repo-wide query rewrite.
- Better Auth owns the auth tables it generates for the configured Drizzle/SQLite adapter: user, session, account, and verification equivalents. Keep those tables aligned with Better Auth’s generated schema instead of hand-rolling incompatible session or verification tables.
- The Better Auth user table must include the username plugin fields: `username` (unique normalized identity) and `displayUsername` (presentation). This username is the user’s private Galaxy identity.
- Use Better Auth’s schema/migration generation as input, then integrate through the repo’s generated Drizzle migration workflow. Do not hand-write auth SQL. If Better Auth’s generated auth-table timestamp conventions differ from Fluncle-owned ISO-string tables, keep Better Auth compatible and isolate that difference to auth tables.
- Add `rate_limit_events`: `id`, `action`, `bucket`, `user_id`, `ip_hash`, `user_agent_hash`, `created_at`; indexes `(action, bucket, created_at)`, `(user_id, action, created_at)`, `(ip_hash, action, created_at)`.

Slice 2: private persistence:

- `user_galaxy_state`: `user_id` (Better Auth user id), `created_at`, `updated_at`, `last_played_at`, `deaths`, `wins`, `schema_version`.
- `user_galaxy_collections`: `id`, `user_id`, `track_id`, `log_id`, `first_collected_at`, `last_collected_at`, `source_surface`; unique `(user_id, track_id)`, indexes `(user_id, first_collected_at)` and `(track_id, first_collected_at)`.
- `user_saved_findings`: `id`, `user_id`, `track_id`, `log_id`, `saved_at`, `note`; unique `(user_id, track_id)`.

Slice 3: submission ownership and data rights:

- Add nullable `user_id` to `submissions`; add index `(user_id, created_at)`. Keep `submitter_hash`, `contact`, and anonymous submission behavior.
- `user_data_exports`: `id`, `user_id`, `requested_at`, `completed_at`, `expires_at`, `status`, `r2_key` nullable.
- `user_deletion_requests`: `id`, `user_id`, `requested_at`, `completed_at`, `status`, `mode`, `summary_json`.

Future public marginalia slices are not part of this RFC. If pursued, they need a separate RFC before adding public profile, credit, crew-note, report, or moderation tables.

## 5. Better Auth contract

Use Better Auth for public accounts. Do not use Spotify OAuth for public accounts; the existing Spotify app remains admin/login-to-admin and playlist-publishing infrastructure only.

Server setup:

- `apps/web/src/lib/server/auth.ts` exports the Better Auth instance.
- Use Better Auth’s Drizzle adapter with provider `sqlite` against the repo’s Turso/libSQL-backed Drizzle setup.
- Enable `emailAndPassword`.
- Add `username()` from `better-auth/plugins`. Configure username validation for the Galaxy identity: lowercase normalized `username`, preserve `displayUsername`, allow only a conservative character set such as letters, numbers, `_`, and `-`, and reserve Fluncle/admin/system terms.
- Add the Better Auth client with `usernameClient()` so the UI can call username sign-in. Better Auth’s username plugin signs in with `client.signIn.username({ username, password })`; sign-up uses the email sign-up flow with a `username` property.
- The email is an auth/recovery credential, not the user’s Fluncle identity. Public and private UI should identify the user by username.

Boundaries:

- Better Auth public sessions must never authenticate `/api/admin/*`.
- Admin auth must remain exactly separate: `requireAdmin`, `fluncle_admin`, `FLUNCLE_API_TOKEN`, `spotify_auth`, and the Spotify admin/publish callback are not public-account primitives.
- Public account deletion/export reads Better Auth user/session/account data through the supported Better Auth/DB shape, not through copied custom session logic.
- CLI/SSH bearer/device-token auth is not in the first web cut. If it ships later, design it as a Better Auth-compatible extension or separate token table that still cannot satisfy admin auth.

Mutation protection:

- Use Better Auth’s session primitives for browser auth and add Fluncle route-level origin/content-type checks for non-Better-Auth account mutations such as saved findings, Galaxy progress, export, and deletion.
- Durable `rate_limit_events` remain required for sign-up/sign-in attempts, saved finding writes, Galaxy progress writes, submissions, export, and deletion.

Tests must prove Better Auth public sessions fail `requireAdmin()`, admin bearer/cookie fails `/api/me`, admin Spotify callback cannot create a public user, and Better Auth routes cannot write `spotify_auth`.

## 6. Route file map

Use exact TanStack route file names during implementation. URL notation with `:param` is only explanatory; files use the repo’s `$param` convention.

Initial web/API files:

- `apps/web/src/routes/api/auth/$.ts` or the repo-equivalent Better Auth catch-all route → Better Auth handler for `/api/auth/*`; choose the exact TanStack file shape during implementation and verify route generation.
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

`GET /api/me` returns `{ ok: true, user: null }` anonymously. When signed in, it returns a minimal private DTO: `id`, `username`, `displayUsername`, `createdAt`, and feature flags. It must not expose email, password-account metadata, session metadata, saved findings, submissions, or moderation state.

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

- Sign-up/sign-in failures by IP hash, username/email where known, and time bucket.
- Session creation, logout churn, device-code creation/verification.
- Saved finding writes, Galaxy progress writes, submission writes, export requests, deletion requests, profile edits if profile fields ship.
- Newsletter linking if account email linking is added.

Cloudflare Turnstile may be added after thresholds for anonymous/high-risk flows, but every Turnstile token must be verified server-side. Tokens are short-lived and single-use per Cloudflare’s docs.

Public writing abuse controls are reserved for the public marginalia RFC.

## 12. Privacy, deletion, export

Private accounts introduce personal data: username, email, password-auth account metadata, session metadata, music taste/progress, saved findings, submissions, export requests, deletion requests, and rate-limit metadata.

Data handling matrix:

| Data                                           | Export                             | Delete/anonymize                                                     | Retain                                    |
| ---------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| User/profile private fields                    | Yes                                | Delete or mark deleted                                               | Minimal deleted account tombstone         |
| Better Auth user/account/email                 | Yes                                | Delete on account deletion                                           | None unless abuse/legal retention applies |
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
- Public DTOs never expose email, password-account metadata, session metadata, saved findings, private progress, private submissions, rate-limit data, or deletion/export records.
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
2. **Auth foundation:** Better Auth dependency/config, generated auth schema, username plugin, `/api/me`, mutation protection for Fluncle-owned account routes, durable rate limits, admin-boundary tests.
3. **Private persistence:** schema slice 2, Galaxy lifetime-progress APIs, saved findings APIs, web account plate, Galaxy lifetime markers, anonymous regression tests.
4. **Submission ownership:** schema slice 3, signed-in submission attachment, `/api/me/submissions`, anonymous submission regression tests.
5. **Data rights:** export/delete implementation, retention policy docs, privacy copy.
6. **Optional cross-surface account clients:** CLI and SSH device login after web account semantics are stable.
7. **Public marginalia RFC:** only after the private layer is complete and validated.

The critical path is auth/session isolation plus the Galaxy lifetime-vs-active state split. The biggest de-risking move is to prove every current anonymous route and client still passes before account UI grows.

## Decisions needed BEFORE handoff

1. Confirm platform choice: **Turso for canonical private account data**, no D1 split, no Durable Objects.
2. Confirm auth carrier: **Better Auth email/password with the username plugin**, no public Spotify OAuth.
3. Confirm account UI name: recommended **Your place** / **Saved findings**, not “Your logbook” as a primary nav label.
4. Confirm Galaxy semantics: lifetime collection persists; active run cargo still resets on tow/manual restart.
5. Confirm data deletion policy in the matrix, especially signed-in submissions and Discord/Loops limitations.
6. Confirm whether CLI/SSH account auth belongs in the first build wave or only after web persistence lands.

## Acceptance criteria

- Existing anonymous routes still work without auth: `/`, `/about`, `/galaxy`, `/log`, `/log/<id>`, `/api/tracks`, `/api/tracks/<idOrLogId>`, `/api/tracks/random`, `/api/search`, `/api/submissions`, `/api/newsletter`, `/rss.xml`, `/mcp`, and agent discovery surfaces.
- Public auth cannot satisfy admin auth. Tests prove Better Auth sessions fail `requireAdmin()`, admin bearer/cookie fails `/api/me`, and Better Auth routes never touch `spotify_auth`.
- Better Auth is configured with Drizzle `sqlite`, email/password, username plugin, username client plugin, conservative username validation, and reserved username handling.
- Better Auth generated schema/migrations include the username plugin’s `username` and `displayUsername` fields; Fluncle-owned tables reference Better Auth user ids.
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
- Better Auth installation docs: configure `betterAuth`, use the Drizzle adapter with provider `sqlite`, enable email/password, and generate the auth schema/migration. https://better-auth.com/llms.txt/docs/installation.md
- Better Auth username plugin docs: add `username()` and `usernameClient()`, add `username` and `displayUsername` fields, sign in with `client.signIn.username`, and sign up through email sign-up with a `username` property. https://better-auth.com/llms.txt/docs/plugins/username.md
- OWASP Session Management and CSRF cheat sheets for cookie, session, and CSRF guidance. https://cheatsheetseries.owasp.org/
