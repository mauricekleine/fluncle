# RFC: Clip drip-feed to Instagram — Fluncle-owned scheduling via Postiz

**Status:** Final — build-ready (operator decisions baked in 2026-07-05). Consolidates + supersedes `clip-to-instagram-rfc.md` (its spike passed; its primitives shipped; only its IG-publish leg remained) and folds in the `clip-drip-feed-scope.md` research. Those two docs are retired by this one.
**For:** a fresh build session / a team of agents.
**Canon/authority:** the codebase (`apps/web/src/lib/server/{postiz,clip-caption,clips}.ts`, `apps/web/src/db/schema.ts`, `docs/agents/hermes/scripts/{clip-sweep.ts,social-capture-sweep.sh}`), `AGENTS.md`, `docs/fluncle-studio.md`, the `fluncle-mixtapes`/`fluncle-publish` skills. Planning, not spec.

## The standard (definition of done)

The whole thing, tested + documented, no dangling threads. The one sanctioned "not now" is an external outcome we don't control: **whether Instagram keeps letting the set-clip audio survive** — that's Meta's behaviour, monitored, with the kill switch as the response. Everything else ships complete (the schedule store, the auto-queue, the IG push, the kill-switch-aware cron, the clip-card surface, tests, docs). This RFC also ties off the long-floating `/admin/clips` "Distribute" seam (`clip-card.tsx:227`, inert since the studio RFC) and the deferred `mixtape_clip_social_posts` table.

## 0. What's already shipped (so it stops floating)

The predecessor `clip-to-instagram-rfc.md` was mostly delivered by the Plan→Recording→Mixtape work + operator decisions. Recorded here so those items are closed, not re-litigated:

- **Unit 0 — the audio-survival spike: ✅ PASSED.** The first hand-posted clip has survived on Instagram (3 days as of 2026-07-05). A live-mixed DJ _set_ clip fingerprints differently from a single copyrighted master. **This is the gate the whole IG effort hinged on — it's cleared.** (Ongoing risk is monitored, not a build blocker; the kill switch is the response — §4.)
- **Cue-marking UX (was 4a): ✅ shipped** — the Studio finding-linked cue rail (`/admin/studio/<recordingId>`).
- **The blend-aware resolver (was 4b): ✅ shipped** — `resolveClipTracks` (`packages/contracts/src/util.ts`).
- **The auto-caption (was 4d): ✅ shipped** — `buildClipCaption` (`clip-caption.ts`): clean caption + one `fluncle://` coordinate line per covered finding (or the mixtape `.F.` if published).
- **The changing-ID overlay (was 4c): ✗ CANCELLED** — the operator dropped the baked overlay (#260): it fights real recorded footage; the credit rides in the IG caption instead. Not a TODO — a closed decision.
- **The mic-leak prereq: ✅ handled** — the clip cut takes the clean music track (Track 1); the 3-track OBS convention is documented in `fluncle-mixtapes`.

**So the only remaining work is the IG-publish leg — and it's now unblocked.** The predecessor designed it as a heavy direct-Meta-Graph pipeline; this RFC replaces that with the lighter, more controllable **Postiz-scheduled drip** (below), which the operator has chosen.

## 1. Goal & the decisions

**Goal:** every clip auto-enters a queue and drip-feeds to Instagram on a jittered daily cadence, with a global kill switch — so the operator can run the experiment, watch survival, and halt everything in one move if a clip gets struck.

Operator decisions (2026-07-05), baked in:

1. **Kill switch** — a single global flag that **pauses all future scheduled posts** (the scheduled rows stay; nothing fires while paused; resume by clearing it).
2. **Shape B — Fluncle owns the schedule.** Fluncle stores `scheduledFor` per clip; a cron posts each **directly through Postiz** (`type:"now"`) when its due time arrives. NOT Postiz-native scheduling (no reschedule API, less control) and NOT direct Meta Graph (more code).
3. **Auto-queue on clip creation, jittered daily.** Creating a clip **automatically** schedules it: `scheduledFor = (the latest scheduledFor among not-yet-posted clips, or now if none ahead) + random(23h–25h)`. The 23–25h jitter keeps post times drifting (anti-"bot posts at 10:00 daily every day"). Default cadence ≈ 1/day.
4. **IG account:** a **Creator** account (category "personal blog"), already **connected in Postiz**.
5. **Surface:** the clip-card gains a **"Schedule"** control (see/override a clip's slot), a `/admin/clips` **batch action** (schedule/reschedule several), AND the **auto-schedule-on-create** default (#3).

## 2. Current state (what to reuse)

- **Postiz adapter EXISTS** (`postiz.ts`): `uploadFromUrl` (Postiz _pulls_ a public HTTPS MP4 — our stable `found.fluncle.com/<clipId>/footage.mp4` is exactly right), `resolveIntegrationId` (already accepts `"instagram"`/`"instagram-standalone"` candidates), `createPost`. Worker holds `POSTIZ_API_KEY`; the box/CLI never see it. Today `createPost` hardcodes `type:"now"` — that's fine, the cron fires at due time (shape B).
- **`pushInstagramReel` DOESN'T EXIST** — a near-clone of `pushYouTubeShort`: resolve the IG integration, `uploadFromUrl(clip mp4)`, `createPost` with `settings:{__type:<the connected type>, post_type:"post"}` (single video + `post_type:"post"` = a Reel), `type:"now"`.
- **The clip's public MP4 + caption EXIST** — `found.fluncle.com/<clipId>/footage.mp4` (with-audio, IG-appropriate) + `buildClipCaption(clipId)`.
- **`mixtape_clip_social_posts` DOESN'T EXIST** — the schema comment reserves it (`schema.ts:761`); it becomes the active schedule + status store here.
- **Cron patterns EXIST to mirror** — `clip-sweep.ts` (status-queue drain, one-per-tick, idempotent) + `social-capture-sweep.sh` (the box _triggers_, the Worker calls Postiz — required, since the key is Worker-only). The IG posting cap is ~25–100/24h (Meta), immaterial at ~1/day but enforced as a backstop.

## 3. Design

1. **`mixtape_clip_social_posts` table** (migration via `db:generate`) — one row per `(clipId, platform="instagram")`: `id`, `clipId`, `platform`, `status` (`scheduled` | `posted` | `failed`), `scheduledFor` (ISO), `postizId` (external id), `postedUrl` (the IG permalink), `caption` (snapshot at schedule time), `createdAt`/`updatedAt`. This IS the schedule (not passive tracking). Mirror the `mixtape_social_posts` helpers (`upsertPost`, status updates).
2. **Auto-queue on create** — in the clip-create path (`createClip` / the Studio "Create clip"), insert a `scheduled` row with `scheduledFor = max(scheduledFor where status='scheduled')` (i.e. the tail of the queue) `+ random(23h,25h)`; if the queue has nothing ahead of `now`, base off `now`. The random gap is computed server-side (deterministic per clip is unnecessary — a one-time roll at insert). A helper `nextDripSlot()` owns this so the clip-card + batch action reuse it.
3. **`pushInstagramReel` in `postiz.ts`** — as §2. Caption from `buildClipCaption(clipId)` at fire time (fresh, so a re-cut/late edit is reflected).
4. **The drip cron** (Hermes on-box, clone of `social-capture-sweep.sh`) — each tick (~15–30 min) hits a new operator-tier Worker op `POST /api/admin/clips/drip`. The Worker: **(a) if the kill switch is ON → no-op**; else **(b)** select rows `status='scheduled' AND scheduledFor <= now` whose clip is `done` (video ready), bounded by a per-tick cap **and** the rolling-24h IG cap; **(c)** `pushInstagramReel` each; **(d)** record `postizId`, flip `status='posted'` (or `failed` on error, surfaced for retry). Idempotent by the status read; fast no-op on an empty due-set. A small capture-back (like `capture_post_urls`) backfills `postedUrl` from Postiz's dated list.
5. **The kill switch** — a single global flag (a `kv`/settings row `clip_drip_paused`, or reuse whatever global-flag store exists). Toggled from `/admin/clips` (a prominent switch) + a CLI. The cron checks it first (§4b). Pausing keeps the schedule intact; resuming continues the drip.
6. **The surface** (`/admin/clips` + `clip-card.tsx`) — the inert "Distribute" button becomes **the schedule control**: shows `scheduled for <date>` / `posted <permalink>` / `failed`, lets the operator override the slot or unschedule. A **batch action** schedules/reschedules a selection (respecting the jittered chain). A **kill-switch toggle** on the page header. All voice-sensitive copy → `copywriting-fluncle`.

## 4. Sequencing & effort

- **S:** the `mixtape_clip_social_posts` migration + the schedule store/helpers (`nextDripSlot`).
- **S–M:** `pushInstagramReel` + the `POST /admin/clips/drip` Worker op + oRPC/coverage + tests.
- **M:** the `/admin/clips` surface (schedule control, batch action, kill-switch toggle, clip-card status).
- **S:** the Hermes drip cron (clone `social-capture-sweep.sh`) + register it as a `cron.*` surface.
- **S:** auto-queue-on-create wiring + the CLI mirrors.
- Operator setup (not code): confirm the IG Creator integration in Postiz is publish-capable; monitor the first automated batch's survival.
- **Day-one, zero-risk first slice:** the schedule store + `pushInstagramReel` + a manual "post now" op — proves the IG push end-to-end (one real clip) _before_ the cron auto-drips. This is the on-ramp; the cron + auto-queue follow once one manual post survives.

## 5. Acceptance criteria

- A created clip auto-gets a `scheduled` row `~23–25h` after the queue tail; the cron posts it to IG at due time via Postiz; `postedUrl` (the permalink) lands on the clip card.
- The **kill switch** halts all future posts within one tick and leaves the schedule intact; clearing it resumes.
- The jitter is real (consecutive gaps vary in `[23h,25h]`); the IG 24h cap is respected as a backstop.
- A failed post is marked `failed` + retryable; `posted` rows never re-fire (idempotent).
- Tests: `nextDripSlot` (jitter bounds + chaining + empty-queue), the drip op (kill-switch no-op, due-selection, cap enforcement), `pushInstagramReel` (request shape). Docs: `fluncle-mixtapes`/`fluncle-publish` skills gain the drip flow; a new `cron.clip-drip` surface registered. `bun run check` + coverage/naming tests green.
- The old `docs/clip-to-instagram-rfc.md` + `docs/clip-drip-feed-scope.md` are deleted (folded here); `postiz.ts:481` "IG intentionally not wired" + `platforms.ts` are updated to include the IG drip path.

## 6. Risks & open questions

- **Audio survival over time (the only real risk)** — the drip is the extended experiment. Start with a handful, watch the first automated posts; the kill switch is the mitigation. If IG starts muting/striking, pause and reassess (the design doesn't change).
- **IG account-strike safety** — an operator-approval step before the first automated posts (optional, given the spike passed; the kill switch is the ongoing guard). **Decision left to the operator:** auto-post from the queue immediately, or require a per-clip "approve" flip before the cron will post it? (Recommend: auto-post, since the spike passed and the kill switch covers the downside — but easy to add an `approved` gate if you want a human in the loop early.)
- **Postiz reliability** — the hosted Postiz fires our `type:"now"` push synchronously from our cron, so there's no dependence on Postiz's own scheduler; a Postiz outage just fails that tick's post (marked `failed`, retried next tick).
- **`instagram` vs `instagram-standalone` `__type`** — resolve from the connected integration Postiz reports; the Creator/"personal blog" account should publish as a Reel with `post_type:"post"`. Verify against the live integration during the day-one slice.

## Appendix — consolidated from

`clip-to-instagram-rfc.md` (Unit 0 passed; 4a/4b/4d shipped; 4c cancelled; Unit 5 redesigned here) + `clip-drip-feed-scope.md` (the Postiz scheduling/IG research: `type:"schedule"` support, `upload-from-url` pull model, no `PATCH /posts`, the ~25–100/24h IG cap, the reusable cron patterns). Both retired by this doc.
