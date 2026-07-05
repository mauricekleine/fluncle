# Scope: scheduled clip drip-feed to Instagram (via Postiz)

**Status:** Scoping doc (not a build). Two read-only research passes (the clip-distribution seam + Postiz's scheduling/IG API) synthesized 2026-07-05. Feeds a build/no-build decision.
**Goal:** schedule Fluncle's set-clips to auto-post to Instagram at spaced future times — a controllable drip-feed the operator can start, watch, and pause.

## 0. The one gate everything sits behind: audio survival

Instagram was **deliberately left un-wired** in the code (`postiz.ts:481-485`, `platforms.ts:10`) — not for a technical reason, but a **copyright one**: baking a master track into a Reel gets muted/struck on a Business/Creator account (the `fluncle-publish` skill documents this). **This scope does not change that risk — it changes the transport.** The counter-evidence: the operator's first hand-posted clip has **survived 3 days**, and a _live-mixed DJ set_ clip fingerprints differently from a single copyrighted master. So the load-bearing assumption is: **set-clip audio survives on IG well enough to drip-feed.** The automated drip should start small and be monitored; the first batch IS the real spike. If clips start getting muted/struck, we pause (see §5) — no architecture change needed.

## 1. Current state (what exists vs deferred)

| Piece                                                                                                 | State                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| The clip object (`mixtape_clips`: in/out, caption, status)                                            | **EXISTS** (`schema.ts:763`)                                                                                      |
| Clip public MP4 URL (`found.fluncle.com/<clipId>/footage.mp4`)                                        | **EXISTS** — already the shape Postiz ingests                                                                     |
| `buildClipCaption` (clean caption + `fluncle://` coordinate lines)                                    | **EXISTS** (`clip-caption.ts`)                                                                                    |
| Postiz adapter (`upload-from-url` pull → `POST /posts`; auth; TikTok+YouTube push)                    | **EXISTS** (`postiz.ts`), Worker-only key                                                                         |
| Postiz `type:"schedule"` + future `date`                                                              | **Supported by Postiz, never used by Fluncle** — `createPost` hardcodes `type:"now"` (`postiz.ts:124`)            |
| `pushInstagramReel`                                                                                   | **DOESN'T EXIST** — but is a near-clone of `pushYouTubeShort` (`settings:{__type:"instagram", post_type:"post"}`) |
| `mixtape_clip_social_posts` tracking table                                                            | **DOESN'T EXIST** — named in comments as the deferred landing spot (`schema.ts:761`)                              |
| Clip "Distribute" button                                                                              | **INERT** (disabled, "lands later" — `clip-card.tsx:227`)                                                         |
| Reusable queue-drain cron (`clip-sweep.ts`) + Worker-paced Postiz trigger (`social-capture-sweep.sh`) | **EXISTS** — the exact patterns to mirror                                                                         |
| A connected IG **Business/Creator** integration in Postiz                                             | **UNCONFIRMED** — must exist before anything works (like the TikTok/YouTube integrations do)                      |

**Postiz facts that shape the design** (cited in the research): Postiz schedules IG Reels on the same `POST /posts` endpoint (`type:"schedule"` + ISO `date` + IG settings); it _pulls_ a public HTTPS MP4 and rehosts it (our stable R2 URL is fine — avoid signed URLs); on the **hosted** service (which we use) a scheduled post fires reliably (always-on backend); there is **no `PATCH /posts/{id}`** to reschedule (delete + recreate); IG's content-publishing cap is ~25–100/24h (immaterial for a few/day). IG needs a Business/Creator account linked to a Facebook Page (Meta requirement, not Postiz).

## 2. The architecture decision

Three viable shapes; the choice is about **who owns the schedule**:

- **(A) Postiz-native scheduling** — Fluncle submits each clip once with a future `date`; Postiz fires them. _Least code._ But the schedule lives in Postiz: pausing/reordering means deleting pending Postiz posts (no PATCH), and status reads come from Postiz's dated list. Less control.
- **(B) Fluncle-side scheduler + cron _(recommended)_** — Fluncle stores `scheduledFor` per clip and a cron drips the _due_ ones to Postiz as `type:"now"` at fire time. **Fluncle owns the schedule** → pause = flip a flag, reorder = edit the queue, cadence + IG-cap enforcement are ours, status is native. Reuses the proven `clip-sweep` (status-queue drain) + `social-capture` (box-triggers-Worker-pushes) patterns exactly.
- **(C) Direct Meta Graph** — the old `docs/clip-to-instagram-rfc.md` §5 approach (bypass Postiz, explicit `copyright_check_status` pre-check + permalink). _Most control over the copyright pre-check, most code_ (build container→publish + our own scheduler + IG OAuth). Overkill given Postiz already publishes IG Reels natively.

**Recommendation: (B).** It reuses the entire existing Postiz adapter + cron patterns (so it's small), and it gives the operator the **control a copyright-experiment drip-feed actually needs** — start, watch, pause, adjust — without depending on Postiz's scheduler or fighting the missing-PATCH limitation. It supersedes the old RFC's direct-Graph transport for _scheduled set-clips_ (note the tension: `postiz.ts:481` "IG intentionally not wired" + the RFC's direct-Graph leg both get updated by this).

## 3. Recommended design (shape B)

1. **Create the deferred `mixtape_clip_social_posts` table** — one row per `(clipId, platform)`, mirroring `mixtape_social_posts`: `clipId`, `platform` (`"instagram"`), `status` (`scheduled` | `posted` | `failed`), `scheduledFor` (ISO), `postizId` (external id), `postedUrl`, `caption` (snapshot at schedule time), timestamps. Migration via `db:generate`. Retire the `mixtape_id=''`-style sentinels — clean from the start.
2. **`pushInstagramReel({ videoUrl, caption, ... })` in `postiz.ts`** — a near-clone of `pushYouTubeShort`: resolve the `"instagram"` integration (the resolver already accepts it), `uploadFromUrl(found.fluncle.com/<clipId>/footage.mp4)`, `createPost` with `settings:{__type:"instagram", post_type:"post"}`, `type:"now"` (the cron fires it at the scheduled time). Caption from `buildClipCaption(clipId)`.
3. **A scheduling surface** — the inert clip-card "Distribute" button becomes **"Schedule"**, or a `/admin/clips` **batch action**: "drip these N clips, 1/day starting <date>, at <time-of-day>." Fluncle computes each clip's `scheduledFor` (next open daily slot), writes `scheduled` rows. Optionally a thin CLI `fluncle admin clips schedule` mirror. The operator picks the clips + the cadence; Fluncle spaces them.
4. **A drip cron** (Hermes on-box, mirrors `social-capture-sweep.sh`): each tick (~15–30 min) hits a new Worker op `POST /api/admin/clips/social/drip` → selects rows where `status='scheduled' AND scheduledFor <= now`, bounded by a per-tick cap **and** the IG 24h ceiling, pushes each via `pushInstagramReel`, records `postizId` + flips `status='posted'` (or `failed`). Idempotent by the status read (a `posted` row is out of the next tick). Fast no-op on an empty due-set.
5. **Status on the clip card + a capture-back** — the card shows `scheduled for <date>` / `posted <url>` / `failed`; a small capture step (like `capture_post_urls`) backfills the live IG permalink from Postiz's dated list once posted.

## 4. Drip mechanics

- **Cadence:** operator-set (e.g. 1/day at 10:00). Fluncle computes each `scheduledFor` = next open slot; the cron fires within a tick of it. Granularity = the tick interval (~15–30 min), fine for a daily drip.
- **IG cap:** stay well under Meta's ~25/24h publish limit (queryable via `content_publishing_limit`); the cron enforces a conservative daily cap as a backstop.
- **Pause (the experiment control):** one flag (or set the pending rows `status='paused'`) → the cron's `scheduled AND due` read returns nothing → the drip stops instantly. Resume by clearing it. This is the whole reason to prefer shape B: **if a clip gets muted/struck, kill the drip in one move** and nothing else fires.
- **Reorder / cancel a pending clip:** edit/delete its `scheduled` row (ours, no Postiz round-trip) before its tick.

## 5. Effort (rough)

- The `mixtape_clip_social_posts` table + migration: **S.**
- `pushInstagramReel` + the drip Worker op + oRPC/coverage: **S–M** (near-clone of existing push + drain patterns).
- The scheduling surface (batch-schedule action + clip-card status): **M** (UI + the cadence computer).
- The Hermes drip cron: **S** (clone `social-capture-sweep.sh`).
- The IG Business integration connected in Postiz + the audio-survival monitoring: **operator setup, not code.**
- Total ≈ **a few focused slices**, mostly reuse. No new external dependency (Postiz already integrated).

## Decisions for the operator (before any build)

1. **Confirm the audio-survival premise** — is the 3-day survival enough to commit to an automated drip, or run one more manual monitored batch first? (The drip's first batch is itself the spike — start with a handful, watch.)
2. **Architecture:** shape **B (Fluncle scheduler + cron)** as recommended, vs A (Postiz-native, less control) vs C (direct Graph, more code)?
3. **Cadence default:** 1/day? a fixed time-of-day? how many clips deep before you reassess survival?
4. **Confirm the IG account is (or can be) a Business/Creator linked to a Facebook Page + connected in Postiz** (the Meta prerequisite; unconfirmed today).
5. **Scheduling surface:** the clip-card "Schedule" button + a `/admin/clips` batch action (recommended), a CLI, or both?

Once 1–4 are settled this is a small, high-reuse build — the clip pipeline was designed with exactly this seam (`mixtape_clip_social_posts`) left open for it.
