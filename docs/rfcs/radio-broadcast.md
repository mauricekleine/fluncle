# RFC: radio.fluncle.com — a true synchronized broadcast (+ streaming optimization)

> **Shipped: #115/#117 — `radio.fluncle.com` is live.** This is the original planning record; read the deferred-units framing below as history, not current state.

**Status:** Draft → Final (research across 4 threads → /taste → adversarial panel synthesized, 2026-06-22) — completeness standard applied.
**For:** a fresh build session (or a small team of agents) turning the per-client radio cycle into one server-authoritative shared run, with fast offset-join playback. Plus Maurice for the catalogue-order, schedule-epoch, and "is mid-join announced" calls.
**Canon/authority:** the codebase and `AGENTS.md` arbitrate; `docs/track-lifecycle.md`, `docs/rfcs/radio-observations.md` (the original radio RFC — built it per-client random), `docs/video-variants.md`, `DESIGN.md` / `PRODUCT.md` / `VOICE.md` (+ `packages/skills/copywriting-fluncle`) are ground truth. This is planning under `docs/`, not spec. It **reverses one scope line** of `radio-observations.md` (which listed "synchronized" + "a 24/7 stream server" as non-goals): synchronization is now in; a stream server is still out (we do it with zero new always-on infra).

> Process note: divergent research across four non-overlapping threads — the central-sync mechanism (DO clock vs deterministic seed+wall-clock vs KV/Turso snapshot, grounded in `wrangler.jsonc` + `server.ts` + CF DO pricing dated 2026-06); the streaming/preload strategy (CF Media Transformations `time=`/`duration=` clipping + faststart + range requests, **probed live against the real catalogue 2026-06-22**); the codebase integration surface (the ordered eligibility query, the oRPC contract op + build-fail coverage test, the catalogue-version fingerprint); and the brand/UX/canon (the banned radio-operator metaphor, the no-dashboard rule, the mid-join copy) — then a /taste pass and an adversarial panel. Their corrections are baked in. Live verifications and sources are in the appendix.

---

## The standard (definition of done)

Every unit ships complete — the shared clock computed and tested, the join made fast and verified in a real browser past hydration, the surface kept in canon, documented. No demo-with-a-TODO. Specifically:

- **Nothing is deferred or optional within a chosen unit.** Unit A (the shared clock) ships with: a stored `radio_schedule` epoch/version (greenfield — there is no DO/KV/schedule state today), the deterministic ordered eligibility query (`getRadioEligibleTracks` + the cheap `getRadioScheduleFingerprint`), the `get_radio_now_playing` oRPC op + handler + the **build-fail coverage-test entry**, the client clock (modulo-over-cumulative-duration, NTP-lite skew, the resync ladder), and the catalogue-grows-without-a-jump rule. Unit B (the fast join) ships with: the two new `media.ts` helpers (an offset-clipped crop `videoClipCrop` and an `atSeconds` poster), the offset-snapped join clip → steady-state crop handoff, the audio `currentTime` seek, the schedule-aware (not random) preload, and the reduced-motion offset-poster. A clock with no fast join, or a join with no shared clock, is not done.
- **Tests + docs are part of done.** New server code (`getRadioEligibleTracks`, `getRadioScheduleFingerprint`, the now-playing handler, the schedule math) ships with unit tests in `apps/web`, mirroring `tracks-radio.test.ts` / the existing `orpc-coverage.test.ts` shape; the schedule arithmetic (cumulative-walk, modulo, the duration floor, the empty/single-finding cases) ships with a **pure-function unit test** (it is the load-bearing logic and must be tested in isolation, not only through the UI). `docs/rfcs/radio-observations.md` gets a one-line "superseded on synchronization by `radio-broadcast.md`" pointer; `docs/track-lifecycle.md`'s radio mention stays accurate.
- **The only sanctioned "not now"** is a genuine external-dependency chain, stated honestly: (1) **WebSocket push / sub-second multi-device parity** (a listening-party feature) is a real upgrade path the recommended design leaves open, but it is _not this RFC's bar_ — a lean-back voice run tolerates a few hundred ms of drift, so push is honestly scoped out, not cut; (2) **catalogue order being a hand-curated "programme"** rather than found-order is a product call parked behind Decision #2 — the deterministic found-order ships and is complete. Neither is a blocker.
- **Tie off dangling threads in reach.** The current `onError → advance()` (random skip) path in `radio.tsx` becomes `onError → resync to the schedule` — a random skip on a _synchronized_ surface desyncs that one client forever, so closing it is part of this delivery, not a follow-up. The `>100MB master` straggler note (`docs/video-variants.md` watch-item) is reaffirmed: the join falls back to the raw master + `currentTime` seek when a source can't be MT-clipped.

---

## 0. Summary / the reframe

- **The unifying simplification: the broadcast is a pure function of `(deterministic eligible list, per-segment `observationDurationMs`, one stored epoch)` — there is no clock to run, only a clock to _compute_.** "What's playing now and at what offset" is `p = (now − epoch) mod T`, then a cumulative-duration walk to the index and the residual offset. Everything else — the join, the preload, the drift correction, the growing catalogue — hangs off that one equation. **The audio is the clock** (today the surface already advances on the observation audio's `ended`; the segment length is exactly `observation_duration_ms`, a stored column already on the public DTO). The video just loops silently underneath and never needs to be seek-aligned. So synchronization is **not** a new server runtime — it is the same modulo computed identically on the server (for the response) and on the client (between polls), anchored to one persisted `epoch`.
- **The central-state choice is "store one value, compute the rest" — the Turso-anchored epoch+version (research Candidate C), not a Durable Object.** A pure stateless function (Candidate A) is almost right, but a growing catalogue mutates `T`, and the instant `T` changes, `p = (now−epoch) mod T` **discontinuously jumps for every listener**. The only thing A lacks is one stored value to control _when_ a new schedule takes effect. C adds exactly that — a tiny `radio_schedule` epoch/version persisted in Turso (already wired; no new binding), bumped to the next loop boundary when eligibility changes — and nothing else. A Durable Object (Candidate B) also fixes the jump but stands up an always-on-ish global clock (a perpetual `alarm()` bills duration + a storage-write per `setAlarm`, a `migrations` block, a class export, and stateful infra to operate) to buy push-sync a lean-back radio doesn't need. The repo's explicit "near-free read surface, low ops, no stream server" mandate (`radio-observations.md`, `AGENTS.md`) decides it: **C.**
- **The fast-join breakthrough is real and verified live: Cloudflare Media Transformations clips with `time=` + `duration=`, so a joiner fetches a rendition that BEGINS at the global offset** — faststart, edge-cached, no in-file seek of the non-faststart 83MB master. (Probed 2026-06-22: `time=5s,duration=10s` → `200`, 7.26MB faststart MP4, `MISS` then `HIT` at 20-day TTL.) The join is: an **offset-snapped** short clip (snap the offset to a coarse grid — e.g. nearest 10s — so joiners share one warm cache entry instead of fragmenting it per-second) for instant pixels, then swap to the normal looping `videoCrop` master-rendition once buffered. The audio seeks via `<audio>.currentTime` + R2 range requests (verified `206`; MT is video-only, so there is no edge clip for audio — and none is needed, the mp3 is ~432KB).
- **Synchronization is a server-clock change, not a brand change.** The brand thread's verdict: keep the Begin gate, keep the reduced-motion poster-holds-audio-plays behavior, keep nearly all the copy. The danger is purely linguistic — "broadcast / station / on air / tune in / live / signal / transmission" are the **retired radio-operator metaphor**, banned in VOICE.md. Express "everyone here, same point, right now" as **dropping in on a continuous run already going**, never as tuning into a broadcast. Ship **zero** new chrome: no listener count (a metric — banned by PRODUCT.md "no metrics"), no "LIVE" pill (a second gold + the banned "live" frame), no progress scrubber (a streaming-app clone + uninvited motion). The shared experience is felt, not displayed.
- **Decomposition (truly-coupled vs falsely-coupled vs over-built):**
  - **Unit A — the shared clock** (the stored epoch/version → the ordered eligibility query → `get_radio_now_playing` → the client modulo clock + skew + resync ladder). The point. It makes two browsers land on the same finding at the same offset.
  - **Unit B — the fast offset-join** (the `media.ts` `time=`/`duration=` clip helper + offset poster → the snapped-clip→full-crop handoff → the audio `currentTime` seek → schedule-aware preload). The thing that makes the shared clock _watchable within ~1-2s_ instead of a slow mid-file seek. Depends on A (it seeks to A's offset) but is its own slice.
  - **Falsely-coupled — WebSocket push / listening-party parity.** A different product (sub-second multi-device sync), a different mechanism (DO + hibernatable WS). Parked as the documented upgrade path; not bundled.
  - **Over-built if pulled in — a hand-curated programme, a now-playing dashboard, a 24/7 stream server, HLS/Icecast.** Kept out per the original RFC's non-goals.
- **The honest horizon.** Unit A is fully in reach now (one stored value + one oRPC op + client math, all on rails the repo already runs). Unit B is in reach now (two MT helpers + the join handoff, MT `time=` verified live). Both ship and are verified in a driven real browser past hydration (the `verify-interactive-states-visually` canon). Push-sync waits on a real product need (a listening party), and that's complete-as-scoped.

---

## 1. Context & goals

**Why now.** `radio.fluncle.com` is live (`apps/web/src/routes/radio.tsx`) but **per-client random**: `advance()` pulls one random eligible finding (`fetchRandomRadioTrack` → `GET /api/v1/radio/random` → `getRandomRadioTrack`, an `ORDER BY random() LIMIT 1`), plays its observation over the silent cropped video, and advances on the audio's `ended`. Two browsers opened side by side play different findings at different offsets — there is no station, just a shuffle each visitor runs alone. The goal is a real radio feeling: **everyone who opens it lands at the same finding, the same offset, mid-observation** — a continuous loop centrally managed, that any joiner computes their place in and seeks to. Entangled with it: the square master is a big file (~83MB, verified) and a naive mid-segment seek is slow, so the join must be fast (~1-2s to pixels).

**The two halves are one design.** The shared clock produces an `offsetMs`; the fast join is "seek to that `offsetMs` cheaply." They share the single primitive — `observation_duration_ms` as the segment length and the audio as the master clock — so they are specified together and shipped as two slices of one delivery.

**Goals, honestly calibrated:**

- **In reach now:** a server-authoritative shared schedule (one stored epoch, a deterministic order, the modulo math) such that any two clients agree on finding + offset within perceptual tolerance; a fast offset-join (poster-at-offset → snapped clip → full crop, audio `currentTime` seek) landing pixels in ~1-2s; the growing catalogue handled without a mid-loop playhead jump.
- **Outside this RFC's bar (honest scoping):** sub-second multi-device parity / a listening-party (needs WS push — the documented upgrade path); a hand-curated programme order (a product call, Decision #2); a 24/7 stream server / HLS (an explicit non-goal kept out).
- **Non-goal:** any "now playing" dashboard, listener count, "LIVE"/"on air" chrome, progress scrubber, accounts/chat (off-canon per PRODUCT.md "no metrics" + VOICE.md's retired radio metaphor — kept out).

**PRODUCT.md / DESIGN.md fit (stated plainly):** the surface stays dark-only, cover-led, centered, quiet, fast; the host draws its own chrome. A synchronized run is _consonant_ with the recovered-log fiction — the crew gathered at the same coordinate, the log playing through on its own — **as long as it is never dressed as a broadcast**. The one UI truth synchronization adds (you joined mid-stream) is expressed in-voice or not at all (Decision #3), never as a status widget.

---

## 2. Unit A — the shared clock (the Turso-anchored epoch + the modulo schedule)

### 2.1 The mechanism (research Candidate C), and why not a Durable Object

**Recommended: the schedule is a pure function of the eligible set + a stored `epoch`; a polled `now-playing` endpoint returns the current slot + a server timestamp; the client runs the same math locally between polls.** No Durable Object, no WebSocket, no alarm, no new binding. The one mutable thing a pure function cannot derive — _when_ a catalogue change takes effect — is the single stored value (`epoch`/`version`), so growth never jumps a playhead.

Mechanisms weighed (full analysis in the appendix):

|                                      | A: pure stateless                            | **C: Turso epoch+version (recommended)**                   | B: Durable Object clock                                                                                         |
| ------------------------------------ | -------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Shared playhead                      | ✅ (modulo math)                             | ✅ (same math)                                             | ✅                                                                                                              |
| Growing catalogue                    | ❌ **jumps every listener** when `T` changes | ✅ new schedule applies at the next loop boundary, no jump | ✅ DO controls the seam                                                                                         |
| Infra to operate                     | none                                         | none (reuses Turso/`getDb`)                                | a global DO + perpetual `alarm()` (billed duration + storage-write/alarm), a `migrations` block, a class export |
| Sync channel                         | polled                                       | polled                                                     | poll or WS push                                                                                                 |
| Fit for "near-free, low-ops" mandate | breaks on growth                             | ✅                                                         | over-built for a lean-back surface                                                                              |

**The math (stated once — this is the spec).** Given the eligible findings in a deterministic order `findings[0..n-1]` with per-segment length `dᵢ = max(observationDurationMs(i), FLOOR_MS)`, let `T = Σ dᵢ` (total loop length) and `epoch` the stored wall-clock anchor (ms). At server time `now`:

```
p   = (now − epoch) mod T              // position within one loop
k   = the index where Cₖ ≤ p < Cₖ₊₁   // cumulative sums C₀=0, Cₖ=Cₖ₋₁+dₖ₋₁
currentTrack = findings[k]
offsetMs     = p − Cₖ                  // ms into findings[k]'s observation
nextTrack    = findings[(k+1) mod n]   // the preload target (starts at offset 0)
```

The client seeks `<audio>.currentTime = offsetMs/1000`, plays, and schedules its own advance at `dₖ − offsetMs`. The video loops silently underneath — **its phase is cosmetic and never seek-aligned** (it carries no audio).

### 2.2 The deterministic order (Decision #2)

**Recommended default: `ORDER BY added_at ASC, track_id ASC`** — found-order, the natural broadcast spine, and the codebase's canonical stable total order (the feed cursor, neighbors, and search tiebreak all use the `(added_at, track_id)` tuple — `tracks.ts`). It must **never** be `ORDER BY random()` — that is exactly what breaks synchronization. If Maurice wants a non-found shuffle, seed a **stable permutation by the schedule epoch** (a pure function of `(orderedList, epoch)` computed in the handler) — the SQL stays deterministic either way. Found-order ships; the shuffle is a one-function swap behind Decision #2.

### 2.3 The server surface

**Two new server functions** in `apps/web/src/lib/server/tracks.ts` (mirroring the lightweight `getTrackNeighbors`/`listVibePoints` shape, not the heavy `TRACK_SELECT`):

```ts
export type RadioScheduleEntry = {
  trackId: string;
  logId: string;
  observationDurationMs: number;
};

/** Every radio-eligible finding, deterministically ordered, for the shared loop. */
export async function getRadioEligibleTracks(): Promise<RadioScheduleEntry[]> {
  // where video_squared_at is not null AND observation_audio_url is not null
  //   AND log_id is not null AND observation_duration_ms is not null
  // order by added_at asc, track_id asc
}

/** Cheap fingerprint to detect "the eligible set changed" without re-reading the list. */
export async function getRadioScheduleFingerprint(): Promise<{ count: number; latest: string }> {
  // select count(*), coalesce(max(observation_generated_at), '') over the same predicate
  // version = `${count}:${latest}` — count++ on a new eligible finding; latest moves on a re-observe.
}
```

- The eligibility predicate **must match `getRandomRadioTrack` exactly** (`video_squared_at` + `observation_audio_url` both non-null) plus `observation_duration_ms IS NOT NULL` and `log_id IS NOT NULL` — the schedule arithmetic and the client's URL builder both require them, where the random op tolerated their absence by skipping client-side.
- `observation_duration_ms` is **already in `TRACK_SELECT`** (`tracks.ts:78`) and mapped to `observationDurationMs` (line 150) — but `getRadioEligibleTracks` reads the lean columns directly, not the full item.

**The stored epoch/version.** Add a tiny `radio_schedule` row (Turso) holding `{ epoch, version, generated_at }` — generated via a drizzle migration (`db:generate`, never hand-written SQL). It is read on every `now-playing` and **bumped to the next loop boundary** (`epoch' = epoch + ⌈(now−epoch)/T⌉·T`) when eligibility changes. Because `T'` only applies from `epoch'`, no current listener's offset jumps; they finish the current loop on the old `T`, then roll onto the longer loop at the seam. (See Risk #2 for the "who bumps it" wrinkle — the recommended resolution computes the fingerprint on every `now-playing` and defers the reschedule to the next boundary, so the eligibility _write_ path stays untouched.)

### 2.4 The endpoint + contract (the build-fail coverage test)

A new oRPC op `get_radio_now_playing` → `GET /radio/now-playing`. The exact registration sequence (omitting any step fails the build):

1. **`packages/contracts/src/orpc/radio.ts`** — add the op + a `RadioNowPlayingSchema`, add the key to `radioContract`:

```ts
export const RadioNowPlayingSchema = z
  .object({
    currentTrack: TrackListItemSchema,
    nextTrack: TrackListItemSchema.optional(), // preload target (starts at offset 0)
    offsetMs: z.number(), // ms into currentTrack's observation
    serverEpochMs: z.number(), // Date.now() at response build — drift correction
    scheduleVersion: z.string(), // `${count}:${maxObservationGeneratedAt}` — re-fetch trigger
    totalLoopDurationMs: z.number(),
    trackCount: z.number(),
  })
  .meta({ id: "RadioNowPlaying" });

export const getRadioNowPlaying = oc
  .route({
    method: "GET",
    operationId: "getRadioNowPlaying",
    path: "/radio/now-playing",
    summary: "The server-authoritative now-playing slot on the shared schedule",
    tags: ["Radio"],
  })
  .output(z.object({ ok: z.literal(true), nowPlaying: RadioNowPlayingSchema }));

export const radioContract = {
  get_radio_now_playing: getRadioNowPlaying, // new
  get_random_radio_track: getRandomRadioTrack, // kept (see §2.7)
};
```

2. **`packages/contracts/src/orpc/index.ts`** — add `export { getRadioNowPlaying } from "./radio";` near the radio re-export; the `...radioContract` spread picks up the new key into `CONTRACT_OPERATION_NAMES` (this is what marks the op "converted").
3. **`apps/web/src/lib/server/orpc/radio.ts`** — add `get_radio_now_playing` to `radioHandlers` (the `os.<op>.handler(...)` shape, the same `ORPCError`/`apiFault` envelope the existing handler uses; an empty eligible set throws the `track_not_found` NOT_FOUND the page already handles). No edit to `orpc.ts` — `...radioHandlers(os)` already spreads whatever the factory returns.
4. **`apps/web/src/lib/server/orpc-coverage.test.ts`** — add `"GET /radio/now-playing": "get_radio_now_playing",` to `PUBLIC_ROUTE_OPS` (radio is contract-only — no route file to enumerate, documented at line 47-51). **This is the build-fail guard.**
5. **`apps/web/src/lib/tracks.ts`** — add `fetchRadioNowPlaying()` mirroring `fetchRandomRadioTrack` (`:54`), hitting `/api/v1/radio/now-playing`.

`wrangler.jsonc` and `server.ts` are **untouched** — oRPC dual-mounts `/api/v1` + `/api` automatically; the new op rides the existing `handleOrpc` branch. (The only reason either file would change is if Decision #1 picked a DO — it does not.)

### 2.5 The client clock — skew, the resync ladder, drift tolerance

The client replaces the random `advance()` with the schedule clock:

- **Skew (NTP-lite):** on each `now-playing` poll, `skew = serverEpochMs + RTT/2 − clientReceiveMs` (smoothed across a couple of polls to reject jitter). Thereafter the client computes position locally from `Date.now() + skew`; the server timestamp in each response keeps it honest.
- **Resync cadence:** poll `now-playing` every **30-60s** — it doubles as the catalogue-version refresh (re-fetch the schedule when `scheduleVersion` changes) and the skew refresh. Re-check alignment at each segment boundary (the `ended`/timer, a free moment to re-snap).
- **Seek tolerance (avoid audible re-seeks for jitter, guarantee convergence after a sleep):**
  - `drift < ~250ms` → **let it ride** (imperceptible on a lean-back voice run; a hard seek would be a worse glitch than the drift).
  - `~250ms-2s` → **soft-correct** (nudge `playbackRate` to ~1.03 briefly).
  - `> ~2s`, OR `scheduleVersion` changed, OR `visibilitychange → visible` (a backgrounded tab is throttled and returns seconds off) → **hard-seek** `audio.currentTime = expectedOffset`, treat as a fresh join.

### 2.6 Edge cases Unit A must handle

1. **Empty eligible pool (`T = 0`):** never divide by `T`. Return the `track_not_found` NOT_FOUND (as `getRandomRadioTrack` does); the page shows the existing `COPY.empty` ("Quiet sector tonight").
2. **A single eligible finding (`n = 1`):** the loop is that one observation repeating; `p = (now−epoch) mod d₀`. Works unchanged — one finding on loop forever, which is exactly what "synchronized" should do.
3. **Catalogue grows mid-broadcast:** the central concern. The new finding enters at the **next loop boundary** (the `epoch'` bump), so no current playhead jumps. Pure-A would jump — that jump is precisely why C is chosen.
4. **A finding re-observed (duration changes):** `observation_duration_ms` is overwritten in place (the DTO already re-versions `observationAudioUrl` by `observation_generated_at`, so the audio URL cache-busts). A changed `dₖ` changes `T` → treat it like growth: bump `version`/`epoch` to the next boundary, clients re-fetch on the version change.
5. **Missing/zero `observation_duration_ms`:** excluded by the predicate (`IS NOT NULL`); a **duration floor** (`FLOOR_MS`, a few seconds) additionally guards a corrupt zero from producing a zero-width slot that breaks the cumulative walk.
6. **Broken asset at the scheduled index (a runtime 404):** unlike today's "skip to a fresh random," a synchronized station **must not desync one client by skipping**. Keep the segment scheduled (everyone stays aligned); the failed client shows `COPY.loading` over the next-segment poster until the boundary. **The `onError → advance()` path becomes `onError → resync to schedule`** (this is the dangling-thread tie-off). The eligibility query already guarantees both assets exist, so this is rare.

### 2.7 Keep `get_random_radio_track`? (Decision #5)

The random op stays for now — it is a clean fallback if a client can't reach the schedule, and removing it is a separate cleanup. Recommended: keep it, route the page at `now-playing`, and revisit removal once the synchronized path is proven. (Listed as a decision so the builder doesn't silently delete a contract op other surfaces might alias.)

---

## 3. Unit B — the fast offset-join (CF Media Transformations `time=` clip + audio seek)

### 3.1 The breakthrough, verified live

Cloudflare Media Transformations `mode=video` supports **`time=`** (start offset, 0-10m) and **`duration=`** (1s-60s). Probed 2026-06-22 against the real catalogue: `time=5s,duration=10s` returned a `200`, a **7.26MB faststart** MP4 beginning at the offset (`moov` at byte 36 — CF re-muxes faststart for free), `cf-cache-status: MISS` then `HIT (age 57s)` at a 20-day TTL. So a joiner fetches **a rendition that begins at the global offset** — no in-file seek of the non-faststart 83MB master, no moov-tail fetch.

### 3.2 The join sequence (pixels in ~1-2s)

The existing poster→low-res→onError handoff (`story-view.tsx`) is the spine, adapted to land at an offset:

1. **First paint = a cropped poster AT the offset.** `videoCropPoster` (`media.ts:297`) hardcodes `time=0s`; a joiner 40s in must see the 40s frame or the poster→video swap visibly jumps. **New helper:** add an `atSeconds` param threading `time=${atSeconds}s` into the existing `mode=frame` URL (CF accepts `fit=cover` + `mode=frame` + `time=` together — verified).
2. **First playable = the smallest-rung crop CLIPPED at the (snapped) offset.** **New helper `videoClipCrop(logId, orientation, width, startSeconds, durationSeconds?)`** emitting `fit=cover,width=W,height=H,audio=false,time=${start}s,duration=${dur}s` in **one combined transform** (never nested — the `media.ts:282` rule). Request the 360/480 rung first (a ~3-7MB faststart clip whose frame 0 _is_ the offset), then **swap to the steady-state looping `videoCrop` master-rendition** once buffered, setting `<video>.currentTime` to `(globalOffset % videoDuration)` so the loop phase matches (cosmetic — the video is silent).
3. **Audio seeks via `<audio>.currentTime` + range requests.** MT is video-only, so there is no edge clip for audio — and none is needed: `observation.mp3` is ~432KB, range-served (`206` verified), MP3 has no moov so the browser seeks by frame scan (effectively instant). **Set `audio.currentTime = offsetMs/1000` BEFORE `audio.play()`.** The audio is the authoritative clock; the video follows it.

### 3.3 Offset-snapping (the cache-fragmentation fix — load-bearing)

Every distinct `time=` value is a **distinct cache key**. Per-second join offsets would fragment the cache and every joiner would pay the cold-transform `MISS`. **Snap the join offset to a coarse grid** (e.g. nearest 10s: fetch the clip at `floor(offset/10)*10`), then `<video>.currentTime`-nudge the ≤10s residual within the small faststart clip (cheap). This converts an unbounded key space into a handful of warm clips per segment — joiners share them. The steady-state full crop has no `time=` and is already warm/shared.

### 3.4 The schedule-aware preload (replacing the random preload)

Today `radio.tsx:141` preloads a **random** next finding. Under the shared clock this is wrong twice: the next finding is **known from the schedule** (`nextTrack`), and it always starts at **offset 0** (only a fresh joiner lands mid-segment; an already-watching client rolls onto the next segment at its head). So:

- Replace the random preload with the schedule's `nextTrack` (from the `now-playing` response).
- Preload its **steady-state `videoCrop` rung** (not a `time=` clip — the scheduled transition plays from the head) + its `observation.mp3`, hidden, `preload="auto"` (correct here because you _know_ it will play and _when_ — contrast `story-view.tsx` where neighbors stay `metadata` because the user might never reach them).
- Warm it with enough lead to buffer before the wall-clock cutover; the existing per-segment effect cadence is right, just keyed off `nextTrack` not a fresh fetch.
- **MediaSource/manual buffering is overkill** — segments are short (≤ the observation length), single-file, faststart, edge-cached, range-served. Native `<video>`/`<audio>` + `preload="auto"` + the `time=` join clip covers everything.

### 3.5 Edge cases Unit B must handle

- **Joiner lands <2s before a segment ends:** don't fetch a `time=` clip for a sub-second tail (the cold-transform cost dwarfs the payoff and `duration=` min is 1s). If `remaining = dₖ − offset < ~2s`, **skip straight to the next scheduled segment at offset 0**, showing `COPY.loading` for the brief gap (mirrors the skip-don't-stall philosophy, but to the _scheduled_ next, not a random one).
- **Cold-cache first viewer:** the first joiner at a snapped offset pays the `MISS`; snapping keeps that to a handful of clips per segment. Acceptable.
- **`>100MB` master (can't be MT-clipped at all):** the existing one-shot `onError` → raw master applies; a joiner falls back to raw master + `<video>.currentTime = offset` (a slow tail-moov seek but functional via range). Reaffirm the `docs/video-variants.md` 100MB watch-item; the current 83MB master is under the ceiling but close.
- **Reduced motion:** preserve the existing contract (pause the video, poster holds, observation stays audible) — but the poster must be the **offset frame** (`videoCropPoster(..., atSeconds)`) so a reduced-motion joiner sees the correct mid-segment still while the audio seeks to the offset. The shared-now is carried by the audio clock, not the motion — fully correct.
- **Masters are not faststart, but the normal path never plays them raw** — radio plays CF MT renditions, which **are** faststart (verified). No master re-encode needed for the normal path; a `-movflags +faststart` stream-copy would only help the rare raw-master fallback (low priority).

---

## 4. Brand / UX / canon (synchronization is a server change, not a brand change)

The brand thread's line-by-line verdict: `radio.tsx` is already clean (no banned words; the file comment declares the recovered-log register). Synchronization changes the _mechanism_, and the copy needs exactly one new idea (you joined mid-stream) expressed in-voice.

- **The banned metaphor (quoted from `copywriting-fluncle/references/voice.md`):** `transmission` ("Retired. Radio metaphor; the dimension/log metaphor replaced it"), `signal` as identity ("Fluncle logs findings; he doesn't pick up signals"), `stream/streaming` as identity ("Spotify streams; Fluncle finds"), `📻` (retired). By extension, avoid `broadcast / station / on air / frequency / tune in` as identity/UI labels. (Carve-out: "tune in" survives as casual first-person prose colour in the console easter-egg only — never as a button or the surface's identity verb.)
- **Express synchronization in-fiction as "dropping in on a continuous run already going."** Copy candidates (recovered-log register, sentence case, no exclamation marks):
  - **Begin-gate subtitle** (replaces `COPY.beginSubtitle`): _"One continuous run of findings. You drop in mid-flight, wherever I've got to."_
  - **Mid-join micro-line** (optional, once, quiet — Decision #3): _"You dropped in partway through this one."_
  - **Loading/seeking** (sync-aware, or keep the warmer current line): _"Catching up to the run."_ / keep _"Still listening for the next one."_
  - **Empty** (keep — already in canon): _"Nothing logged out here yet. Quiet sector tonight."_
- **Zero new chrome (Decision #3).** No listener count (PRODUCT.md "no metrics" + invented presence data), no "LIVE"/"on air" pill (the banned frame + a second gold against the One Sun Rule + uninvited motion), no progress scrubber/ticker (a streaming-app clone + uninvited motion per the two-movement ambient budget). The shared experience is **felt** (you and a mate open it and hear the same finding), never **announced**. The strongest in-canon option may be to drop even the mid-join line and let the mid-sentence drop-in be the texture ("recovered from far away," the Light-Years Rule). Recommend: ship the begin-subtitle change; make the mid-join micro-line a one-time, non-persistent, reduced-motion-safe line inside the existing `.radio-scrim` zone, or omit it.
- **The Begin gate survives** — audible audio still needs a gesture; on `begin()` the page resolves the _synced_ finding + offset instead of a random one and seeks. During the ~1-2s seek the user sees the offset poster + the in-voice loading line (the existing `RadioMessage` pattern). "Begin" stays the literal, lowest-risk label (the alternatives "Tune in"/"Go live"/"Listen live" are banned; "Drop in" is the only in-canon alternative and pairs with the subtitle if a change is ever wanted).
- **DESIGN.md rules that bind:** the Legible Sky Rule (any new line sits in the scrim's AA-protected zone), the One Sun Rule (the gold `radio-log-id` is the surface's one gold — add no second accent), the Warm Dark Rule (no broadcast-blue/cyan "on air" tint — it's the exact hue the Retint Rule recolors out), the two-movement ambient budget (no ticker/scrubber/pulsing pip).

---

## Sequencing & ownership

1. **Unit A.1 — the schedule primitives** (the `radio_schedule` epoch/version migration via `db:generate`; `getRadioEligibleTracks` + `getRadioScheduleFingerprint`; the boundary-deferred reschedule on a changed fingerprint). Smallest, lands first; everything depends on it. **Pure-function unit test for the modulo/cumulative-walk math** (empty, single, floor, growth-at-boundary) — this is the load-bearing logic.
2. **Unit A.2 — the endpoint + client clock** (the `get_radio_now_playing` op + handler + the **coverage-test entry** + the contract re-export; `fetchRadioNowPlaying`; the client modulo clock, NTP-lite skew, the resync/seek-tolerance ladder; the `onError → resync` tie-off). Verified in a driven real browser past hydration: two tabs land on the same finding + offset.
3. **Unit B — the fast join** (the `videoClipCrop` + `atSeconds`-poster helpers in `media.ts` + their unit tests mirroring `media.test.ts`; the snapped-clip → full-crop handoff; the audio `currentTime` seek; the schedule-aware preload; the reduced-motion offset poster). Verified: a fresh joiner sees pixels in ~1-2s and is aligned within tolerance.
4. **Copy + canon** (the begin-subtitle change; the optional mid-join line per Decision #3) — small, lands with Unit A.2's UI change.

- **Parallelizable:** the `media.ts` helpers (Unit B) and the schedule primitives (Unit A.1) are independent edits; the endpoint (A.2) gates the page wiring; the page wiring consumes both.
- **The one thing that de-risks the most:** ship A.1 + A.2 first and **open two browser tabs** — the cheapest falsification of the whole bet (do two clients actually agree on finding + offset?). Then layer B's fast join on a proven clock. Verify in a real driven browser **past hydration** (the host-rewrite already hydrates `radio.` → `/radio`; the new client clock must agree across SSR/hydration, per the `verify-interactive-states-visually` canon).

---

## Decisions needed BEFORE handoff

1. **The central-state mechanism (recommended, confirm):** the **Turso-anchored epoch+version** (Candidate C) — a stored schedule epoch, the modulo math computed server- and client-side, a polled `now-playing` endpoint. **No Durable Object, no WebSocket, no new binding.** (DO/WS is the documented upgrade path for a future listening-party only.)
2. **The catalogue order (a product call for Maurice):** **found-order** (`added_at ASC, track_id ASC`) as the default broadcast spine, vs an epoch-seeded stable shuffle, vs a hand-curated programme (out of scope for v1). Recommended: found-order; the shuffle is a one-function swap if wanted.
3. **The mid-join affordance (a `copywriting-fluncle` call):** ship the begin-subtitle "you drop in mid-flight" change (recommended yes). Decide whether to also show a one-time, quiet, non-persistent "You dropped in partway through this one." micro-line, or to omit it and let the mid-sentence drop-in be the texture. **No** listener count / "LIVE" pill / scrubber (off-canon — confirm kept out).
4. **The resync + seek-tolerance constants (recommended, confirm):** poll every 30-60s; let-it-ride `<250ms`, soft-correct `250ms-2s`, hard-seek `>2s` / version-change / tab-return. The offset-snap grid (recommended **10s**) trades cache-sharing against join-frame accuracy.
5. **Keep `get_random_radio_track`? (recommended, confirm):** keep it as a fallback/clean separation; route the page at `now-playing`; revisit removal once synchronized playback is proven. Don't silently delete the contract op.

---

## Acceptance criteria

**Unit A (the shared clock) — ship gates:**

- A `radio_schedule` epoch/version is **generated** via `db:generate` (not hand-written), committed with metadata, applies cleanly. `getRadioEligibleTracks` returns the eligible set **deterministically ordered** (`added_at, track_id`, never `random()`), with the predicate matching `getRandomRadioTrack` **plus** `observation_duration_ms`/`log_id` non-null. `getRadioScheduleFingerprint` returns `${count}:${maxObservationGeneratedAt}`.
- `GET /radio/now-playing` exists as a `get_radio_now_playing` oRPC op, returns `{ ok: true, nowPlaying: { currentTrack, nextTrack?, offsetMs, serverEpochMs, scheduleVersion, totalLoopDurationMs, trackCount } }`; an empty set is the `track_not_found` NOT_FOUND the page handles. The **coverage-test entry** is added (build fails without it). The contract re-export + handler are wired.
- The schedule math has a **pure-function unit test**: cumulative-walk + modulo correctness; the empty pool (no divide-by-`T`), the single finding (`n=1` loop), the duration floor, and **growth at the next boundary without a playhead jump**.
- The client clock: NTP-lite skew, the resync ladder (poll 30-60s, re-fetch on version change), the seek tolerance (ride/soft/hard), and hard-seek on tab-return. **Verified in a driven real browser past hydration: two tabs agree on finding + offset within tolerance.** The `onError → advance()` random skip is replaced by `onError → resync to schedule`.

**Unit B (the fast join) — ship gates:**

- `media.ts` gains `videoClipCrop(logId, orientation, width, startSeconds, durationSeconds?)` (one combined `fit=cover` + `audio=false` + `time=` + `duration=` transform, never nested) and an `atSeconds` param on `videoCropPoster` — both with **unit tests** mirroring `media.test.ts` (the URL shape, the no-nesting rule, the single `?v`).
- A fresh joiner: offset poster → **offset-snapped** join clip (snapped to the grid, residual nudged) → steady-state looping crop; audio `currentTime`-seeked before play. **Pixels within ~1-2s**, aligned within tolerance, on a normal connection.
- The preload is **schedule-aware** (`nextTrack`, steady-state rung, `preload="auto"`), not random. The `<2s`-to-end joiner skips to the next scheduled segment. Reduced motion: offset poster holds, observation audible. `>100MB` master falls back to raw + `currentTime`.

**Docs:** `docs/rfcs/radio-observations.md` gets the "superseded on synchronization" pointer; `docs/track-lifecycle.md`'s radio mention stays accurate.

**Not a ship gate (honest scoping):** WebSocket push / sub-second multi-device parity (the upgrade path); a hand-curated programme; a stream server. Built to accept WS later; not blockers.

---

## Risks & open questions

1. **The catalogue-growth jump (top risk if Candidate A is chosen by mistake).** A pure stateless schedule mutates `T` on every new observation and **jumps every listener's playhead**. The Turso epoch/version (C) is the fix — the new schedule applies at the next loop boundary. The builder must not "simplify" C back to A.
2. **The epoch-bump's "who writes it" wrinkle (verify, recommended resolution inside).** The epoch must change when eligibility changes — but the eligibility-changing write (an `observe` that sets `observation_audio_url`, or the square backfill that sets `video_squared_at`) happens on the _agent_ write path, not a user request. **Recommended: do NOT bump on the write path. Compute the fingerprint (`count` + `max(observation_generated_at)`) on every `now-playing`, and when it changes, recompute the schedule with the new set effective from the _next loop boundary_** (carry the old `T` to the seam). This keeps the eligibility write path untouched and needs only the epoch/version row (or even derives the epoch deterministically from the fingerprint + a fixed origin). Confirm this is acceptable vs an explicit write-path bump.
3. **Cache fragmentation on join clips.** Per-second `time=` values fragment the 20-day edge cache and make every joiner pay a cold `MISS`. Offset-snapping to a coarse grid is **required**, not optional.
4. **Clock skew is real (seconds), not negligible.** A client's `Date.now()` can be seconds off the server. The NTP-lite skew correction is mandatory; never assume the client clock is the server clock.
5. **Tab backgrounding throttles the audio/timer.** A returning tab can be many seconds off → always hard-seek on `visibilitychange → visible`. Don't let a slept tab drift the surface out of sync silently.
6. **Eligibility vs reality drift.** `now-playing` returns what the DB thinks is eligible; an R2 object can be missing/stale (the `r2-purge-needs-media-transforms` canon: transform renditions cache separately). The client must **resync, not random-skip**, on a load error — a skip desyncs that client permanently.
7. **The 83MB master near the 100MB MT ceiling.** A future heavier render could cross it and lose the `time=` clip path entirely (no edge clip → slow raw-master fallback for joiners). Keep the `video-variants.md` watch-item live.
8. **Scope honesty.** Resist bundling WS push, a listening-party, a programme editor, or a stream server into v1 — the original RFC's non-goals are kept out; the recommended design leaves the WS upgrade path open without paying for it now.

---

## Appendix — verifications & sources

**Live verifications (against the worktree code + the live catalogue, 2026-06-22):**

- **The surface is per-client random today:** `apps/web/src/routes/radio.tsx` (`advance()` → `fetchRandomRadioTrack`, audio-`ended` clock at line 194, random preload at line 141); `apps/web/src/lib/tracks.ts:54` (`fetchRandomRadioTrack` → `/api/v1/radio/random`); `getRandomRadioTrack` is `ORDER BY random() LIMIT 1` (`apps/web/src/lib/server/tracks.ts:286-297`).
- **The segment length is a stored column:** `observation_duration_ms` (`apps/web/src/db/schema.ts:41`), in `TRACK_SELECT` (`tracks.ts:78`), mapped to `observationDurationMs` (`tracks.ts:150`), a Phase-2 artifact (`track-lifecycle.md:131`). The audio is the clock (the video `loop`s muted under it).
- **Greenfield central state:** no `DurableObject`/`idFromName`/`kv_namespace`/`durable_object` anywhere in `apps/web/src` or `wrangler.jsonc` (the only binding is the R2 `VIDEOS` bucket). `server.ts` is `export default createServerEntry({ fetch })` ahead of `handleOrpc`/`handleMcp`/router; a DO would need a named class export beside the default (not chosen).
- **The endpoint wiring + build-fail guard:** `packages/contracts/src/orpc/radio.ts` (the existing `get_random_radio_track` op), `index.ts` (the `...radioContract` spread + re-export → `CONTRACT_OPERATION_NAMES`), `apps/web/src/lib/server/orpc/radio.ts` (the `radioHandlers` factory), `orpc-coverage.test.ts:47-51` (radio is contract-only; `PUBLIC_ROUTE_OPS` is the public-surface net that fails the build).
- **Media Transformations `time=`/`duration=` clipping (the join breakthrough):** probed `time=5s,duration=10s` → `200`, **7.26MB faststart** MP4 at the offset, `cf-cache-status: MISS` then `HIT (age 57s)`, 20-day TTL. CF MT crop renditions are faststart (`moov` at byte 36); the raw `footage.mp4` is **NOT** faststart (`moov` in the tail of an **82.9MB** file). `observation.mp3` (~432KB) is range-served (`206`, `accept-ranges: bytes`). The `media.ts` helpers (`videoCrop`/`videoCropPoster`/`videoRendition`/`videoPoster`, the one-combined-transform rule at line 282, the `RenditionWidth` ladder, the `TRANSFORM_VERSION` bust, the `>100MB`/`onError` fallback) are the surface the two new helpers extend.

**Mechanism analysis & sources (dated 2026-06):**

- **CF Durable Objects pricing/billing** (alarms billed as storage writes; duration GB-s while awake/non-hibernating; hibernatable WS avoids idle duration but an `alarm`-driven clock keeps waking the object; free tier ~3M req + ~390k GB-s/mo; ~1,000 req/s soft per-object; single global instance lives in one colo → cross-ocean RTT): https://developers.cloudflare.com/durable-objects/platform/pricing/ , https://developers.cloudflare.com/durable-objects/best-practices/websockets/ , https://developers.cloudflare.com/durable-objects/api/alarms/ — the basis for choosing C over B for a "near-free, low-ops" lean-back surface.
- **DO class export + `migrations`/`new_sqlite_classes` beside a default fetch handler; hibernatable WebSocket API** (Context7, Cloudflare Workers docs) — confirms B is _feasible_ (it doesn't break the TanStack handler), just over-built here.
- **Synchronized-playback epoch + cumulative-duration + modulo schedule pattern** (W3C Media Synchronization on the Web): https://www.w3.org/community/webtiming/files/2018/05/arntzen_mediasync_web_author_edition.pdf — the math in §2.1.
- **CF Media Transformations `mode=video` + `time=`/`duration=`/`fit`/`width`/`height`/`audio` (input <100MB, ≤10min, H.264 + AAC/MP3; origin must support HEAD + range):** https://developers.cloudflare.com/stream/transform-videos/ ; open-beta clip/resize from R2: https://blog.cloudflare.com/media-transformations-for-video-open-beta/
- **MP4 faststart / moov + byte-serving; HTML5 `<video>` seek needs `Accept-Ranges` + `Content-Range`; R2 single-range 206:** https://cleverutils.com/mov-to-mp4/faststart-web-video , https://www.codelessgenie.com/blog/seeking-in-html5-video-with-chrome/ , https://community.cloudflare.com/t/range-request-support-for-videos-in-r2-buckets/776059 — the basis for §3 (the masters needn't be re-encoded because the normal path plays faststart MT renditions).
- **Voice canon:** `packages/skills/copywriting-fluncle/references/voice.md` (§3 banned `transmission`/`signal`/`stream`/`📻`; §4 the Dry Rule; §5 the surface registers + "no hype, no DJ patter"; §6 sentence case + the Garnish/Sauce rules; §7 the "tune in" easter-egg carve-out). `DESIGN.md` (the Legible Sky / One Sun / Warm Dark / Retint Rules + the two-movement ambient budget). `PRODUCT.md` (no metrics, no streaming-clone, no dashboard).
