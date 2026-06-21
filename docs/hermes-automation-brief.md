# Hermes agent — giving it real work (automation orchestrator)

**Status: parked planning, not a spec.** This brief consolidates the scoping for turning the Hermes chat agent into Fluncle's queue-driven automation orchestrator. It is **blocked on the in-flight CLI noun/verb naming pass** (the `fluncle admin …` surface is being re-aligned; command names below are today's, several will change). The plan: park this here, revise it once the naming lands, then execute. Per `AGENTS.md`, a `*-brief.md` is non-canonical planning — the codebase and canon (`DESIGN.md` / `PRODUCT.md` / `VOICE.md`) win on any conflict.

Related: the live agent's architecture + security model is [docs/agents/hermes-agent.md](./agents/hermes-agent.md); the threads this brief unifies are currently split across the ROADMAP's _Hermes follow-ups_, _Newsletter agent_, _Audio observation_, and _Backfill_ sections.

## The one principle everything hangs on

The Hermes agent wears two hats — **chat** (reads untrusted Discord messages and browses untrusted web) and **cron** (trusted, scheduled, no untrusted input per run). They share one process and one `agent`-scoped token, so **whatever the agent _can_ do is what a prompt-injection can do.** Therefore:

- Hand off a task to the agent **only if it fits under the agent-safe ceiling** (reversible / internal / no public footprint). Never raise the ceiling to operator-level just to make a cron run — an injection would inherit it.
- **Hermes orchestrates; it does not compute.** It schedules, reads a queue via the `fluncle` CLI, and either calls a Worker endpoint that does the work server-side or triggers heavy compute elsewhere (Spinup enrichment, the laptop render routine). Hermes never needs ffmpeg, a vendor key, or operator power.
- **Publish-class stays operator** (Maurice) and is not handoffable regardless.

This works because **every task worth automating already fits (or fits with guards) under the agent ceiling** — none need operator power. The upgrade path, if the bot ever broadens toward public: split a second, no-untrusted-input automation principal holding a broader token, so cron authority is never injection-reachable. Not needed for the current private/trusted allow-list.

## What's handoffable

| Task                                                 | Queue ready?                                 | Agent-allowed today?                    | Agent needs a vendor key?                                          | Work to enable                                                                                                                                                                                                                                |
| ---------------------------------------------------- | -------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Enrichment self-heal** (today `enrich-sweep`)      | ✅ enrich-queue (`status=queue`)             | ✅ yes                                  | none (Worker re-fires Spinup)                                      | schedule a Hermes cron — no new code beyond the naming pass.                                                                                                                                                                                  |
| **Audio observations** (today `track observe`)       | ❌ needs a `hasObservation` filter           | ❌ operator-only → flip **with guards** | none (ElevenLabs + Firecrawl already Worker-side via `/observe`)   | add `hasObservation` filter + an `observe-context` endpoint (so the agent scripts _from_ facts without holding Firecrawl) + flip `observe` to agent-allowed behind the `observe:${logId}` idempotency key. **Gated on Fluncle's real voice.** |
| **Newsletter draft** (Friday)                        | ✅ time window via `/api/tracks?since&until` | ❌ no command yet                       | 🔴 **YES today** — holds `LOOPS_API_KEY` + `FIRECRAWL_API_KEY` raw | wrap Loops + Firecrawl in `POST /api/admin/newsletter/draft` + a CLI command; fold the Spinup newsletter agent into a Hermes Friday cron. The send stays a manual operator tap (Loops has no send API).                                       |
| **Discogs ID backfill** (today `backfill discogs`)   | ✅ targeted (`in_release_id IS NULL`)        | ❌ operator-only → flip                 | none (Worker-side)                                                 | the `discogsStatus` reliability column (below) + role flip.                                                                                                                                                                                   |
| **Last.fm loves backfill** (today `backfill lastfm`) | ⚠️ re-loves all (no unloved filter)          | ❌ operator-only → flip                 | none (Worker-side)                                                 | the `lastfmLovedAt` reliability column (below) + role flip.                                                                                                                                                                                   |

**Not handoffable** (stay operator / human / compute, correctly): `add` (the one human act); **tag** and **note** (editorial judgment, gated on the vibe-placement model — and `note` is Fluncle's voice, operator-only by design); **render** (the laptop routine, not the agent); **YouTube / TikTok / mixtape publish + distribute** (public, irreversible); `submissions approve/reject` (editorial); all `auth` flows.

## The secrets invariant — the newsletter is the only breach

Audit result: the "agent holds only its admin token; the Worker owns every vendor key" invariant holds **everywhere except the newsletter agent**. ElevenLabs, Discogs, Last.fm, and Postiz are all already wrapped behind `fluncle` commands (the Worker holds the keys). The newsletter agent is the lone exception — it calls the `loops` and `firecrawl` CLIs directly, so it must keep both raw keys on its host.

**The fix:** a Worker endpoint `POST /api/admin/newsletter/draft` that (a) pulls the week's finds + mixtapes, (b) runs the Firecrawl tidbit searches behind their domain allow-list + lyric-marker guards, and (c) creates/updates the Loops **draft** campaign — exposed as `fluncle admin newsletter draft --since … --until …`. The newsletter host then drops both keys and both CLIs and holds only the agent token, like every other task, and folds into Hermes. **This is the highest-value piece:** it closes the last key exposure _and_ unblocks consolidation in one move. (Send stays manual — unchanged.)

## Queue gaps

A cron agent needs a "give me the next batch needing X" query per step. Today:

- **Ready:** enrichment (`status=queue`), render (`hasVideo=false`), tag (`placement=unplaced`) — all via `GET /api/admin/tracks`.
- **Need new filter params on `/api/admin/tracks`:** `hasObservation`, `hasNote`, and per-platform publish (`hasYouTubePost` / `hasTikTokPost`, joined on `social_posts` status).
- **Backfills:** Discogs already filters `in_release_id IS NULL`; Last.fm re-walks all published (no unloved filter) — both fixed by the reliability columns below.

## Two reliability columns (the self-heal made precise)

Both love-on-add and discogs-resolve-on-add are **best-effort** (verified: each swallows its own errors and never blocks or fails an `add`). That is correct — but it means a transient failure is silent and permanent unless something re-attempts it. The backfill commands _are_ that re-attempt (the same role `enrich-sweep` plays for enrichment), so they are infrastructure, not throwaway scripts. Two columns make them targeted instead of brute-force.

Conventions that make this clean (from the schema + DTO): the public DTO is an explicit SQL whitelist (`TRACK_SELECT` + a row-mapper), so a column that isn't added there **never surfaces** — "internal only" is free. Listing orders by `added_at`, not `updated_at`, so these writes won't reshuffle the feed; but `updatedAt` _is_ surfaced (freshness / lastmod) and the enrich-sweep stale clock reads it, so both new columns must be written **quietly** (touch only their own column, don't bump `updated_at`).

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

## Build these as oRPC contracts (admin is on oRPC now)

Every endpoint this brief adds or touches is admin (`/api/admin/*`) — the newsletter draft, observe-context, the backfills, the new queue filters, and the role flips. The [oRPC migration](./orpc-migration-brief.md) now brings the admin surface onto oRPC (admin auth is a typed `context.role` tier via `adminProcedure` / `operatorProcedure`, not per-handler `requireAdmin` / `requireOperator` calls). Since that slice lands first (see Blocked on), build this brief's endpoints as **oRPC contracts on the right procedure tier**, not as TanStack add-ons: the new `…/newsletter/draft` and `observe-context` ops get contracts in the registry; the new `/api/admin/tracks` filter params extend the existing tracks-list contract.

## Role flips

To run on a Hermes cron, these routes move from the operator tier to the admin tier (agent-allowed) — a **procedure-tier change** (`operatorProcedure → adminProcedure`) now that admin is on oRPC, not swapping a guard call. Each is defensible — idempotent and reversible, the Worker owns the keys, and an injected trigger's blast radius is "a few extra free / rate-limited vendor calls":

- `POST /api/admin/backfill/lastfm`
- `POST /api/admin/backfill/discogs`
- `POST /api/admin/tracks/:id/observe` (with the `observe:${logId}` idempotency key + the Firecrawl untrusted-input boundary)
- the new `POST /api/admin/newsletter/draft`

`enrich-sweep` is already agent-allowed.

## Setup / mechanism

Hermes [cron jobs](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron), each a small "read a queue → act per item, idempotently" loop over the `fluncle` CLI:

- **Hourly:** the enrichment self-heal (the on-add trigger already fires enrichment; this is the backstop for the ones that slipped).
- **Hourly, queue-gated:** read the observation queue, render the next finding's observation (idempotent per Log ID; no-op when empty) — _after_ the voice lands.
- **Daily:** the Last.fm love backfill (free, idempotent, now targeted).
- **Weekly / on-demand:** the Discogs backfill (rate-limited; `--retry-unmatched` rarer still).
- **Friday:** the newsletter draft → report the draft link to the operator for the send.

## Build order

1. **Enrichment self-heal cron** — the cheapest win; proves the cron pattern. (No code beyond the naming pass.)
2. **Newsletter wrap + fold-in** — biggest win (closes the last key breach + the consolidation); independent of the voice gate.
3. **Reliability columns + backfill role flips** — `lastfmLovedAt`, `discogsStatus` + the resolver refactor; then daily / weekly crons.
4. **Observation automation** — after Fluncle's real voice; needs the `hasObservation` filter + `observe-context` endpoint + the guarded `observe` flip.

## Blocked on

- **The CLI noun/verb naming pass (in flight).** Command names will change (`enrich-sweep` is shorthand, not the target shape); don't wire cron to names that are about to move. **Revise this brief once the naming lands**, then execute.
- **Fluncle's real voice** — gates the observation automation (a placeholder render would need re-rendering).
- Everything else above is build work, sequenced once the names settle.
