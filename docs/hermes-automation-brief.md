# Hermes agent — giving it real work (automation orchestrator)

**Status: parked planning, not a spec — but the slice it waited on has largely landed.** This brief is the scoping for turning the Hermes chat agent into Fluncle's queue-driven automation orchestrator. The oRPC + Convention B slice that gated it is now mostly in (see [What landed](#what-landed-so-this-is-buildable-not-blocked)); what's left before a clean build start is narrow (see [Green light](#green-light)). Per `AGENTS.md`, a `*-brief.md` is non-canonical planning — the codebase and canon (`DESIGN.md` / `PRODUCT.md` / `VOICE.md`) win on any conflict.

Related: the live agent's architecture + security model is [docs/agents/hermes-agent.md](./agents/hermes-agent.md); the oRPC rails it builds on shipped (the contracts live in `packages/contracts/src/orpc`, the auth spine in `apps/web/src/lib/server/orpc-auth.ts`); the newsletter is now owned by its own RFC, [docs/rfcs/newsletter-own-the-stack.md](./rfcs/newsletter-own-the-stack.md) (see [§ Newsletter](#newsletter--owned-by-its-own-rfc)).

## What landed (so this is buildable, not blocked)

- **The operator/agent auth spine** — `apps/web/src/lib/server/orpc-auth.ts`: `adminAuth` middleware injects a typed `context.role`; `adminProcedure` is the agent-allowed tier; `operatorProcedure` / `operatorGuard` is operator-only (403s the agent); field-level checks read `context.role` in-handler. A verbatim port of the live `env.ts` role model. **This is the foundation every role-flip below now rides** — flips are a procedure-tier change, not a guard swap.
- **The admin oRPC migration** — the #75 pilot + the #77 fan-out drain the admin coverage net's PENDING list to carve-outs only. The Hermes-relevant ops land on the exact tiers we designed (real contract names in the table below).
- **Convention B ratified** (`docs/naming-conventions.md`, 2026-06-21). The contract registry (`packages/contracts/src/orpc/`) is the enforced source of truth — a route without a contract is a build failure.
- **Fluncle's real voice locked** (#73/#74) — bespoke ElevenLabs voice, tuned settings, recovered-audio delivery guide finalized. And the agent now runs **`claude-sonnet-4.6`** (verified on-brand on its Discord newsletter post), so the observation **script-authoring** runs on Hermes too — not just the voice gate but the creative authoring is resolved. No Opus / laptop escape is needed for it; the only compute that still escapes to the Mac is video render (below).

## The one principle everything hangs on

The Hermes agent wears two hats — **chat** (reads untrusted Discord messages and browses untrusted web) and **cron** (trusted, scheduled, no untrusted input per run). They share one process and one `agent`-scoped token, so **whatever the agent _can_ do is what a prompt-injection can do.** Therefore:

- Hand off a task to the agent **only if it fits under the agent-safe ceiling** (reversible / internal / no public footprint). Never raise the ceiling to operator-level just to make a cron run — an injection would inherit it.
- **Hermes is the cloud home for the agent brain; only heavy render escapes it.** Running `claude-sonnet-4.6`, it drains queues via the `fluncle` CLI and does the work itself wherever the compute is light or server-side: the deterministic vendor steps (Last.fm, Discogs, context-note Firecrawl — Worker-side), the **observation** (Sonnet authors the recovered-audio script, the Worker renders ElevenLabs), and **audio analysis** (`ffmpeg` + JS DSP, once `ffmpeg` is in its image — replacing Spinup; scoped in [spinup-to-hermes-enrichment-brief.md](./spinup-to-hermes-enrichment-brief.md)). The single exception is **video render** (headless Chromium + WebGL): too heavy for the current 2-vCPU / 4-GB box, so it stays a Claude automation on the operator's Mac that pulls the render queue — a deliberate compute escape hatch, moved to Hermes only on a box upgrade (a last resort). Hermes still holds no vendor key and no operator power.
- **Publish-class stays operator** (Maurice) and is not handoffable regardless.

This works because **every task worth automating already fits (or fits with guards) under the agent ceiling** — none need operator power. The upgrade path, if the bot ever broadens toward public: split a second, no-untrusted-input automation principal holding a broader token, so cron authority is never injection-reachable. Not needed for the current private/trusted allow-list.

## What's handoffable

Tiers and op names are the **landed oRPC contracts** (#75 / #77). "Flip" = move the contract from `operatorProcedure` to `adminProcedure` (agent-allowed).

| Task (oRPC op)                                 | Queue ready?                          | oRPC tier today                       | Work to enable                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Enrichment self-heal** (`enrich_track`)      | ✅ enrich-queue (`status=queue`)      | ✅ **admin** (agent-allowed)          | wire the Hermes cron — the endpoint is already on the agent tier. The CLI name has settled: `fluncle admin tracks enrich --all`.                                                                                                                       |
| **Audio observations** (`observe_track`)       | ❌ needs a `hasObservation` filter    | operator (#75) → **flip**             | flip to `adminProcedure` + `observe:${logId}` idempotency key + Firecrawl untrusted-input boundary; add `hasObservation` on `list_tracks_admin`; add an `observe-context` contract (script _from_ facts without holding Firecrawl). Voice ✅ resolved. |
| **Discogs ID backfill** (`backfill_discogs`)   | ✅ targeted (`in_release_id IS NULL`) | operator (#77) → **flip**             | the `discogsStatus` reliability column (below) + resolver refactor + tier flip.                                                                                                                                                                        |
| **Last.fm loves backfill** (`backfill_lastfm`) | ⚠️ re-loves all (no unloved filter)   | operator (#77) → **flip**             | the `lastfmLovedAt` reliability column (below) + tier flip.                                                                                                                                                                                            |
| **Newsletter** (draft/send)                    | ✅ time window via `list_tracks`      | draft agent / send operator (planned) | owned by [newsletter-own-the-stack.md](./rfcs/newsletter-own-the-stack.md); Hermes adds the draft-then-Discord-nudge layer. See [§ Newsletter](#newsletter--owned-by-its-own-rfc).                                                                     |

**Not handoffable** (stay operator / human / compute, correctly): `add_track` (the one human act); **tag** and **note** (editorial judgment, gated on the vibe-placement model — and `note` is Fluncle's voice, operator-only by design); **render** (the laptop routine, not the agent); YouTube / TikTok / mixtape **publish + distribute** (`publish_*`, `*_youtube`, `draft_track_social --platform youtube` — public, irreversible); `approve_submission` / `reject_submission` (editorial); all `auth` / token-mint ops.

## Newsletter — owned by its own RFC

The newsletter is now scoped in **[docs/rfcs/newsletter-own-the-stack.md](./rfcs/newsletter-own-the-stack.md)** (ratified). It covers the Loops → Resend move (Audience, subscribe repoint, the on-subscribe confirmation, the Broadcast send) **and** a new newsletter **editions archive** (an `editions` table, `/newsletter/<id>` pages, `list_editions` / `get_edition` contracts), sequenced post-oRPC and targeting an upcoming Friday edition. That RFC owns the build; this brief no longer duplicates it.

The **Hermes-specific contribution** sits on top of that RFC's send capability — the agent-drafts-operator-sends tiering, with a Discord nudge as the gate:

- **Draft** runs **agent-allowed** (the Friday cron builds the edition via the RFC's draft path; Firecrawl tidbits stay Worker-side).
- **Send** stays **operator-only** — sending to the real list is publish-class (PRODUCT.md "operator-controlled").
- **The gate is a Discord nudge:** the agent drafts, then posts a Discord message to the operator (subject, find count, the review/send command) using its existing Discord presence; the operator reviews and sends. The agent never sends. (Upgrade path: schedule the send with an operator veto window — a later choice, not the default.)

Fold this draft-then-nudge tiering into the newsletter RFC when it's built, or keep it a thin Hermes add-on once the RFC's send lands. The secrets invariant holds throughout: `RESEND_API_KEY` is Worker-owned and the agent holds no vendor key — the newsletter was the last raw-key breach, and the RFC closes it.

## Queue gaps

A cron agent needs a "give me the next batch needing X" query per step, off the now-oRPC `list_tracks_admin` (GET /admin/tracks, #77):

- **Ready:** enrichment (`status=queue`), render (`hasVideo=false`), tag (`placement=unplaced`).
- **Need new filter params on `list_tracks_admin`:** `hasObservation`, `hasNote`, and per-platform publish (`hasYouTubePost` / `hasTikTokPost`, joined on `social_posts` status). These extend the existing contract's input schema.
- **Backfills:** Discogs already filters `in_release_id IS NULL`; Last.fm re-walks all published (no unloved filter) — both fixed by the reliability columns below.

## Two reliability columns (the self-heal made precise)

Both love-on-add and discogs-resolve-on-add are **best-effort** (verified: each swallows its own errors and never blocks or fails an `add`). That is correct — but it means a transient failure is silent and permanent unless something re-attempts it. The backfill commands _are_ that re-attempt (the same role `enrich_track` plays for enrichment), so they are infrastructure, not throwaway scripts. Two columns make them targeted instead of brute-force.

Conventions that make this clean (from the schema + DTO): the public DTO is an explicit SQL whitelist (`TRACK_SELECT` + a row-mapper), so a column that isn't added there **never surfaces** — "internal only" is free. Listing orders by `added_at`, not `updated_at`, so these writes won't reshuffle the feed; but `updatedAt` _is_ surfaced (freshness / lastmod) and the enrich sweep's stale clock reads it, so both new columns must be written **quietly** (touch only their own column, don't bump `updated_at`).

### `lastfmLovedAt` (`lastfm_loved_at`, `text` ISO, nullable)

- Platform-prefixed on purpose — a future platform's endorsement gets its own column (`spotifySavedAt`, …), never a generic `loved`.
- `NULL` = not yet successfully loved (a retry candidate); set = loved at that time. **Written only on a successful love** — a swallowed failure stays `NULL`, which is what makes the sweep self-heal.
- Write path: the existing best-effort love (on-add + backfill) stamps it on success.
- Backfill query: `published AND lastfm_loved_at IS NULL` (targeted; a daily run usually touches zero).
- Internal-only: not in `TRACK_SELECT`/the mapper.
- Existing rows (already loved): a one-time `UPDATE … SET lastfm_loved_at = added_at WHERE published` avoids one redundant full re-love.

### `discogsStatus` (`discogs_status`, `text NOT NULL DEFAULT 'pending'`)

Stops overloading `in_release_id IS NULL`, which today conflates "never ran" with "ran, no confident match (null by design)." Mirrors the `enrichmentStatus` enum:

- `pending` — never attempted (default).
- `resolved` — confident ≥0.90 match; `inReleaseId` set.
- `unmatched` — attempted, no confident match → **skip on routine runs.**
- `failed` — attempted but errored (transient) → a retry candidate.

- **One required resolver change:** `discogsResolveRelease` currently swallows both errors and no-matches into `{}` — it conflates `failed` and `unmatched`. It must return a discriminated outcome (`{ status, releaseId?, masterId? }`) so the caller can stamp the right state. Small and contained — the only logic change here.
- Write path: on-add resolve and the backfill both stamp the status from that outcome (+ ids on `resolved`).
- Backfill query: `published AND discogs_status IN ('pending','failed')` — skips `resolved` and `unmatched`, so it stops re-burning the rate-limited MB/Discogs budget on hopeless cases. A `--retry-unmatched` flag (or a rare scheduled pass) widens to `unmatched`, since a release can newly appear upstream.
- Internal-only: `discogs_status` stays out of `TRACK_SELECT`; the surfaced thing remains the Discogs URL derived from `inReleaseId`.
- Existing rows: the migration defaults them to `pending`; the first backfill re-attempts the catalogue once, but short-circuits to `resolved` (no API call) for any row that already has `inReleaseId`, so only genuine nulls cost budget.

Migration: add both columns to `src/db/schema.ts`, then `bun run --cwd apps/web db:generate` (never hand-written, per `AGENTS.md`); Cloudflare auto-migrates on deploy.

## Build on the oRPC rails

Admin **is** on oRPC now (the #75 pilot + the #77 fan-out), so every endpoint this brief adds or touches is a contract, not a TanStack add-on:

- **New ops** — `observe-context`, and the newsletter `draft` / `send` (per the RFC) — get contracts in `packages/contracts/src/orpc/` and handlers in `apps/web/src/lib/server/orpc/`, on the right tier via `.use(adminAuth)` (agent-allowed) or `.use(adminAuth).use(operatorGuard)` (operator-only).
- **New filter params** (`hasObservation`, …) extend the existing `list_tracks_admin` input schema.
- **Role flips** are a one-line tier change on the existing contract (below), and the admin coverage test keeps the registry honest.

## Role flips

Move the contract from the operator tier to the admin tier (agent-allowed) — `operatorProcedure → adminProcedure`. Each is defensible: idempotent and reversible, the Worker owns the keys, and an injected trigger's blast radius is "a few extra free / rate-limited vendor calls":

- `backfill_lastfm` (operator → admin)
- `backfill_discogs` (operator → admin)
- `observe_track` (operator → admin) — **plus** the `observe:${logId}` idempotency key + the Firecrawl untrusted-input boundary

`enrich_track` is **already on the admin tier** (#77 set it there deliberately as the external-cron tier) — no flip needed, it's cron-ready. Newsletter `draft` is agent-allowed and `send` stays operator (per the RFC + the Discord-nudge gate).

## Setup / mechanism

**No on-add push — everything is a cron.** The Worker's on-add work ends at `enrichment_status = pending`; there is no fire-and-forget trigger to Spinup or Hermes. Every step below is a Hermes [cron job](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) — a small "read a queue → act per item, idempotently" loop over the `fluncle` CLI. A new find is caught on the next tick; the same loop drains backfills. (Hermes also exposes an [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) for an on-demand trigger, but the cron is the durable backbone and the default.)

- **Hourly:** the enrichment self-heal (the on-add trigger already fires enrichment; this is the backstop for the ones that slipped).
- **Hourly, queue-gated — context note:** read the `hasContext=false` queue and fetch the Firecrawl facts for the next finding (Worker-side). This is now its **own step**, distinct from the observation that consumes it — so context can fill in parallel and the observation never holds Firecrawl. Idempotent per Log ID.
- **Hourly, queue-gated — observation:** read the `context present AND hasObservation=false` queue, author the recovered-audio script (Sonnet + the `copywriting-fluncle` skill) from the context note, and render it via the Worker. Idempotent per Log ID; no-op when empty.
- **Daily:** the Last.fm love backfill (free, idempotent, now targeted).
- **Weekly / on-demand:** the Discogs backfill (rate-limited; `--retry-unmatched` rarer still).
- **Friday:** draft the newsletter edition (per the RFC) → **post a Discord reminder** to the operator → operator reviews and sends. The agent drafts and nudges; it never sends (publish-class).

## Build order

1. **Enrichment self-heal cron** — the cheapest win; `enrich_track` is already on the agent tier and the CLI name has settled (`fluncle admin tracks enrich --all`), so this is just the cron. Proves the cron pattern.
2. **Reliability columns + backfill tier flips** — `lastfmLovedAt`, `discogsStatus` + the resolver refactor; flip `backfill_lastfm` / `backfill_discogs` to the admin tier; then the daily / weekly crons.
3. **Observation automation** — voice ✅; flip `observe_track` to the admin tier + idempotency, add the `hasObservation` filter on `list_tracks_admin`, add the `observe-context` contract; then the queue-gated cron.
4. **Newsletter** — rides [newsletter-own-the-stack.md](./rfcs/newsletter-own-the-stack.md); once its send lands, add the draft-then-Discord-nudge tiering. (That RFC moves on its own timeline; this is the Hermes hook on top.)

## Green light

A clean build start needs both unchecked boxes ticked:

- ☑ **#77 merged** (on `main` at `6513deb`) — the admin oRPC migration is complete; the PENDING list is down to carve-outs, and every Hermes op is a contract on its tier.
- ☐ **CLI admin naming rename landed** (Convention B §4 step 3 — not started, no aliases yet). The crons invoke via the `fluncle` CLI, so the command names must be stable first; don't wire a cron to a name about to move. **This is now the only remaining gate.**
- ☑ **Fluncle's voice** — locked (#73/#74); observation automation unblocked.
- ☑ **The auth spine** — `orpc-auth.ts` (`adminProcedure` / `operatorProcedure`); role flips are tier changes.

The reliability columns + resolver refactor are oRPC-independent and could start earliest, but they touch `tracks.ts` / `schema.ts`, so hold them until the oRPC slice's sole-active-slice window has fully cleared. Once the two boxes tick, the endpoints get built as oRPC contracts on the existing tiers and the crons wire up in the order above.

**Update the operator skill when this lands.** The `fluncle-hermes-operator` skill (`packages/skills/fluncle-hermes-operator`) is the operator runbook for changing the Hermes agent, grounded in what's live _today_. When this brief's work ships — the scheduled crons, the `backfill_*` / `observe_track` role flips, and the newsletter `draft` / `send` commands — add those levers to the skill so it stays in step with the agent's real capabilities (it carries the same reminder in its own footer).
