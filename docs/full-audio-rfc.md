# RFC: Full-song audio capture — a parallel side-channel that upgrades three readers

**Status:** Final (divergent research → /taste → a four-role adversarial panel that verified every claim live → completeness-held, 2026-07-07). Supersedes and absorbs [docs/full-audio-embedding.md](./full-audio-embedding.md).
**For:** a fresh build session or a team of agents.
**Canon/authority:** the codebase arbitrates; this is planning, not spec (AGENTS.md: `docs/*-rfc.md` is non-canonical). Where this deviates from the code, the code wins.

> Process note: four divergent researchers, a /taste pass, and a four-role adversarial panel (staff-eng, box/ops-posture, live-DSP/accuracy, product/scope) that read the real files and refuted the draft. They caught real defects — a no-op capture loop, a fictional schema precedent, a starvation trap, a whole-pipeline coupling to one actor, a live-feature regression, a tautological accuracy gate, and a shared-runner contention. All are corrected below; the corrections reshaped the architecture (capture is now a non-blocking side-channel, and the heavy crons are host timers). Corrections + live verifications are in the appendix.

## The standard (definition of done)

Boil the ocean: capture (the host-timer cron + the private bucket + the schema) **plus all three consumers** (enrichment, embeddings, Tier-A live references) **plus** the archive capture-backfill, each with tests + docs. The bar is "holy shit, that's done."

One item remains legitimately **operator-gated, not deferred-as-excuse**: **retiring the `fluncle-bpm-backfill` skill**, gated on _measuring_ the post-capture "unmatched" tail rather than asserted up front (the panel proved full-audio only subsumes it for `capture_status='done'`; the unmatched tail still needs a repair path). The whole-archive **backfill + re-derive is ratified** (2026-07-07 — capture the entire catalogue, paced, in-place, clobber-safe) and ships as part of the delivery, not gated.

The only fully out-of-scope item is **Tier B open-set free-mixing** (the tracklist-free live matcher) — a genuine dependency chain (it needs full-audio + Tier A shipped first) already tracked as a roadmap `Next` item ([docs/ROADMAP.md](./ROADMAP.md), "Live visuals — free mixing without a preloaded tracklist"). This RFC references it as the de-risked follow-on and states its prerequisites; it does not design it.

## 0. Summary / the reframe

- **The root cause is one thing.** The 30-second Deezer/iTunes preview is structurally blind: for liquid DnB it is often a beatless piano intro, spectrally near-identical across tracks, and only ~1/6 of the song. Enrichment reads it (→ null or octave-folded-null BPM), embeddings read it (→ "quiet piano" vectors), and the live matcher references it (→ a mix-in outside the 30s window can never match). **Fix the source once and all three heal.**
- **The unifying artifact is one `source_audio_key`; the unifying _behavior_ is that capture never blocks.** This is the sharper insight the panel forced. Capture is a **seventh self-healing pull-queue** (the pipeline already has this shape six times: enrich, embed, context, note, observation, and the `backfill_discogs_*` presence-gate), but it sits **beside** the analysis pipeline, not upstream of it as a gate. A finding is enriched on its preview _today_, exactly as now, with **zero dependency on the capture step**; when capture later lands the full song, it _upgrades_ the readers that benefit. Capture is a parallel quality side-channel, not a critical-path dependency. (The draft's "gate the queue on the key" was a starvation trap and a whole-pipeline coupling to one grey-market actor — see Unit 2.)
- **Per-reader, the upgrade is asymmetric — and the asymmetry is principled.** Enrichment has a _useful_ preview result today, so it keeps running on preview and **re-derives on full audio only where its BPM is null/fake** (clobber-safe; this _is_ the automated bpm-backfill). Embedding's preview result is _worthless_ (the very thing we're killing), so it **waits for the key** and simply produces no vector for the unmatched tail — better no vector than a lying one. The live matcher references full audio and is **additive** — a bad accuracy recalibration just means we don't ship the swap; the preview references + operator nudge remain.
- **Capture and embed run as rave-02 _host systemd timers_, not gateway crons.** The box has one shared, serial cron runner and a _global_ timeout; a multi-minute embed on that runner starves the latency-sensitive 5-minute sweeps (the repo already moved healthcheck off the gateway for exactly this reason). The full-song embed is minutes-scale, and capture spawns a `yt-dlp` + `ffmpeg` subprocess whose residential-proxy fetch has an unbounded tail latency — neither belongs on the shared runner, so both run decoupled via the proven `fluncle-pin-watch` / `healthcheck-timer` host-timer pattern.
- **The full song lives in a NEW private bucket** (`fluncle-source-audio`), never the world-served `fluncle-videos` (found.fluncle.com is public-by-key). The _source_ of the bytes is the same `yt-dlp`/YouTube match we already sanction (`fluncle-bpm-backfill`'s local tier-2) — Spotify is only the lookup key, no DRM rip, no Spotify creds; see Unit 1 — so the genuine **posture escalation** is narrow: storing the audio _durably_ ("discarded, never stored" → stored-private) and the box _orchestrating_ the fetch (via a residential proxy, since the box's datacenter IP is YouTube-bot-walled) — **ratified by the operator 2026-07-07**, not waved off as "the same grey area."

## 1. Context & goals

**Why now.** The embed cron is paused pending this decision; the bpm-backfill skill exists only because preview-BPM fails; and the live matcher's two auto-match misses are exactly "the DJ mixed in a section the 30s preview never contains." All three are the same wound. The operator ratified (2026-07-07) capturing the full song once into private R2, box-autonomous via `yt-dlp` through a residential proxy.

**Goals, honestly calibrated.**

- In reach, buildable now: the capture side-channel; enrichment / embeddings / Tier-A reading full audio; the archive capture-backfill; the tested (clobber-safe, in-place) re-derive machinery.
- Operator-gated (cost/direction/posture, per the standard): running the whole-archive re-derive; retiring the bpm-backfill skill (gated on the measured unmatched-tail rate); the copyright-posture escalation.
- Fully out of scope, roadmap `Next`: **Tier B** open-set free-mixing (needs this RFC shipped first).

## 2. Unit 0 — the schema (ships first, deploys as a no-op)

Add to the `tracks` table (`apps/web/src/db/schema.ts`), grounded in the **real** status precedents — `enrichment_status` (`schema.ts:87`, `notNull().default("pending")`) and `context_status` (`schema.ts:73-75`, nullable, the _query_ treats NULL as pending). (There is **no** `discogs_status` column; the Discogs state is the `backfill_discogs_*` presence quartet at `schema.ts:33-36` — a different, enum-less idiom.) Generate the migration with `bun run --cwd apps/web db:generate`.

```
sourceAudioKey        text("source_audio_key")           // R2 key analysis/source/<logId>/<sha256>.<ext>; PRESENCE = captured
captureStatus         text("capture_status").notNull().default("pending") // enum pending|done|unmatched|failed — models enrichment_status
sourceAudioCapturedAt text("source_audio_captured_at")   // ISO stamp when bytes landed
sourceAudioAttemptedAt text("source_audio_attempted_at") // ISO of last attempt → backoff cooldown
sourceAudioFailures    integer("source_audio_failures").notNull().default(0) // consecutive failures → backoff window
```

**The `.notNull().default("pending")` is load-bearing** (the panel's B2): without the DDL default, `publishTrack`'s insert (`publish.ts:177-199`, which lists columns explicitly and does not name this one) lands `NULL`, and `capture_status in ('pending','failed')` never matches `NULL` in SQLite — the capture loop would be a silent no-op on every new add. `notNull().default("pending")` makes the insert land `'pending'` (matching `enrichment_status`) **and** backfills every existing row to `'pending'` on migration — which naturally enqueues the whole archive for capture-backfill (Unit 5a) for free. Write the capture query defensively anyway (`capture_status is null or capture_status in ('pending','failed')`), mirroring `context_status` at `tracks.ts:972-973`, so a pre-column NULL is never stranded.

`capture_status` semantics: `pending` (never attempted) → `done` (key written) | `unmatched` (no YouTube result passed the duration guard — terminal, never re-burn the search on it) | `failed` (attempt threw: proxy/`yt-dlp` error, a 403 surviving the player-client fallbacks; retriable under backoff via `source_audio_attempted_at` + `source_audio_failures`, mirroring the Discogs/Last.fm sweeps' Retry-After discipline). **Trim vs the draft:** `source_audio_mime` is dropped (derive the content-type from the key's extension via a `mimeToExtension` inverse) and `source_audio_source` is dropped (one provenance value in v1) — 5 columns, not 7. `capture_status='done'` is kept despite overlapping key-presence because it also distinguishes `pending`/`unmatched`/`failed`, which presence cannot.

Migration deploys as a no-op (Cloudflare auto-migrates on push). No behavior change until Unit 1.

## 3. Unit 1 — capture (a host-timer cron + the private bucket)

### The private store (operator-provisioned)

**Do NOT reuse `fluncle-videos`** — it is served world-readable by key at `found.fluncle.com` (`media.ts:13` `FOUND_BASE`; the repo itself scopes the backup cred "never `fluncle-videos`, which is world-served", `backup-sweep.ts:49`). Create a new **private** bucket `fluncle-source-audio`, **no public custom domain, no r2.dev**. Key mirrors the preview archive, new prefix: `analysis/source/<logId>/<sha256(bytes)>.<ext>` (reuse `buildPreviewArchiveKey`'s shape + `mimeToExtension`, `preview-archive.ts:37,88`). The write must **not** bump `updated_at` (internal state — the preview archive is disciplined the same way, `preview-archive.ts:130`).

Two accessors:

- **Worker binding** `SOURCE_AUDIO` in `apps/web/wrangler.jsonc` (a second `r2_buckets` entry beside `VIDEOS` at `:53`) — used only by the Unit-4 read endpoint (the M5 bridge).
- **Box S3 read-write credential** scoped to `fluncle-source-audio`, vault-sourced — for the capture write and the enrich/embed reads. The box already does S3-direct R2 (`backup-sweep.ts:248` `signS3Request({method})` is method-generic; add a GET — there is no object-GET helper today, only bucket-listing).

### The capture mechanism — box `yt-dlp` through a residential proxy (validated 2026-07-07)

**Decided and end-to-end validated on rave-02, not piloted-blind.** The bytes come from the box running `yt-dlp` directly against a YouTube match — the same source `fluncle-bpm-backfill`'s tier-2 already fetches, just on the box instead of the M5 and stored durably. The 2026-07-07 pilot killed the alternative (the `maximedupre/spotify-downloader` Apify actor served a 157 s **clip** from a Spotify-clip CDN, caught by the duration guard on track 1); a genuine `yt-dlp`→YouTube match returns EXACT full-length audio (388/388, 203/203, 335/335 s). Two constraints the validation surfaced, both now mandatory in the cron:

- **The box needs a residential proxy.** rave-02 is a Hetzner datacenter IP (AS24940) → YouTube bot-walls it on the _first_ request ("Sign in to confirm you're not a bot"), for both search and download. A residential proxy (DataImpulse, ~$1/GB PAYG) resolves it: through the proxy the exit IP reads as a real ISP and the page/player/search/download all succeed.
- **The proxy session must be _sticky_.** YouTube's `googlevideo` CDN IP-locks the media URL to the IP that fetched the player JSON. A rotating proxy exits a _different_ IP on the bytes fetch → `HTTP 403`. DataImpulse's `__sessid.<id>` username suffix pins one exit IP per download (verified: 3 requests → one IP; the full 6.14 MB / 388 s master then downloaded clean). So every `yt-dlp` invocation runs on a per-track sticky session.

The cron is proxy-agnostic — it needs only `artist`/`title`/`duration_ms` in → a validated local file out — so a future proxy swap touches only the vault creds + the session-string builder.

### The capture cron — a rave-02 HOST systemd timer (not a gateway cron)

The box's `--no-agent` crons share **one serial runner** with a **global** `cron.script_timeout_seconds` (`config.yaml:26-27`, default 300; 120s hard kill otherwise, `cron/README.md:472`). A per-track `yt-dlp` fetch is fast (~1-2 s for a 6 MB opus in the pilot), but it spawns a subprocess whose residential-proxy round-trip has an **unbounded tail** (a slow/hanging exit stalls the whole runner) and a batch per tick compounds it — so capture runs as a **host systemd timer** `docker exec`ing the sweep, decoupled from the gateway runner, matching embed and the exact pattern the repo already uses for `fluncle-healthcheck` / `fluncle-pin-watch` (`cron/README.md:250`, `healthcheck-timer/`). Per tick, oldest-first for backfill but **new adds jump the queue** (a fresh finding must not wait behind the whole archive — see Unit 5a), small cap:

1. Query the capture queue (a `hasSourceAudio`/capture filter on `listTracks`, `tracks.ts`, plus a `fluncle admin tracks capture-audio --queue` worklist mirroring the other steps — named `capture-audio` to avoid colliding with the existing `social --capture` / `cron.social-capture`).
2. Build a sticky proxy string (`https_proxy=http://<user>__sessid.<logId>:<pass>@<gw>:<port>`), then `yt-dlp --proxy` a `ytsearch1:"<artist> <title>"` (both on `tracks`: `title` `:141`, artists via the join) → download `-f bestaudio` to a temp file → **duration match-guard** (ffprobe the file vs the finding's `duration_ms`) → S3-direct `PUT` to `fluncle-source-audio` → `update_track` sets `source_audio_key`/`_captured_at` + `capture_status='done'`. No result passes the guard → `unmatched` (terminal). A `yt-dlp`/proxy error → `failed`, bump `source_audio_failures`, stamp `source_audio_attempted_at`. On a `403` surviving the sticky session, retry once with `--extractor-args youtube:player_client=tv,web_safari` before marking `failed`.

   **Why the duration guard is load-bearing.** `yt-dlp` finds the bytes by a **title/artist YouTube match**, not Spotify's master (Spotify is only the finding's identity), so the failure mode is not _access_ but a **wrong-version match** (remix, live, sped-up/nightcore, radio-vs-extended, a different remaster), which would poison every reader. **The guard:** accept a capture only if the downloaded audio's duration is within tolerance (≈ ±3 s / a few %) of the finding's `duration_ms`; otherwise `capture_status='unmatched'`. Prefer official/`- Topic` uploads and de-rank titles containing remix/live/sped-up markers in the `ytsearch` ranking to cut mismatches before the guard even runs. Duration catches the gross mismatches (edits/speed changes); shape-normalized log-mel (Unit 4) tolerates loudness/EQ/remaster differences, so a same-length remaster is fine. This guard is sharpest for Tier-A — the DJ plays the real master from Rekordbox, so a mismatched rip degrades the live fingerprint even for "the same song." (Open Tier-A refinement, not designed here: where a played track exists in the operator's own Rekordbox library on the M5, that file is the _perfect_ reference — identical to what's played — and would beat any rip.)

3. **Trigger the enrichment upgrade, clobber-safe:** on writing a key, reset `enrichment_status='pending'` **only when** the finding's BPM is null or the octave-folded-null/fake case (the exact bpm-backfill trigger) — never touch a good or operator-curated value. This is what makes bpm-backfill's job automated. (Embeddings need no trigger — the embed queue (Unit 3) is `source_audio_key not null AND embedding_json is null`, so a freshly-keyed finding is picked up automatically.)
4. Register in `@fluncle/registry` (`cron.capture`) **and** the healthcheck prober's `AUTOMATION_CRONS` hand-mirror (`fluncle-healthcheck.ts:365-381`) + `docker cp` re-deploy the prober + `docs/admin-jobs.csv`, so it lights up `/status`. (The mirror is drifting _right now_ — it already omits `cron.artist-sweep`/`cron.artist-follow` — so also land the CI guard below.)

### Capture does NOT gate the analysis queues

The draft's `AND source_audio_key is not null` on the enrich/embed queues is removed. Capture races the pipeline; readers select their best-available source (Units 2-3). This keeps enrichment fully independent of the capture step (proxy/YouTube availability) and never strands the terminal `unmatched` tail.

**The add paths are unchanged** — verified: there is exactly one prod insert into `tracks` (`publish.ts:177`, via the oRPC `publish_track` handler; `promote_recording` inserts into `mixtapes` not `tracks`; the only other insert is a test seed). `publishTrack` inserts at the schema default and returns — no inline capture. Web / CLI / Raycast add code needs no edit. (Honest caveat: a new add's _embedding_ now waits for capture instead of being preview-embedded — acceptable, embedding is non-urgent and we don't want preview vectors; its _enrichment_ is unchanged, running on preview immediately.)

## 4. Unit 2 — enrichment: race on preview, upgrade on full audio; keep the repair net

### The change

- `analyze-track.ts` gains an `--audio-file <path>` entry that skips `resolvePreviews()` (`:110`) and decodes the given local file (generalize `loadPreview` `:219`; the ffmpeg→WAV→`decodeWav` tail is identical; `spectral`/`estimateBpm`/`estimateKey` unchanged). **Proven code** — `bpm-backfill/scripts/analyze-local.ts:17,32,36` already runs `estimateBpm` over a full-song `--audio-file`.
- `enrich-sweep.ts` (host-timer or gateway — it is fast and preview-based, so it may stay a gateway cron): **the queue is unchanged** (`tracks.ts:1001-1015`, no capture dependency). The _sweep_ selects its source: S3-GET `source_audio_key` to a temp file and pass `--audio-file` when the key is present, else the existing preview path — **permanently**, not "for the transition." The unmatched tail keeps enriching on preview exactly as today (many previews _do_ have beats).

### Why this gives real BPM

`foldToBand` (`analyze-track.ts:500-513`, fake-160 clamp already removed) octave-folds into the DnB band and returns honest `null`. Feeding the full song makes the successful path primary; the clobber-safe re-derive trigger (Unit 1 step 3) re-runs enrichment on full audio for precisely the null/fake findings.

### Keep the AcousticBrainz fallback; DEFER the skill retirement (measure the tail first)

The panel refuted "retire bpm-backfill entirely, its justification dissolves." Full audio subsumes it **only for `capture_status='done'`**. This RFC _creates_ a new residual: a finding that is `unmatched` **and** has a beatless preview **and** is a post-2022 release (AcousticBrainz 404s) → null BPM with no repair path. So:

- **Keep** the inline AcousticBrainz-by-ISRC fallback (`analyze-track.ts:522`, call site `:844`) unconditionally — it is the last resort for exactly the unmatched tail. Do **not** gut it.
- **Keep** the `fluncle-bpm-backfill` skill until the post-capture-backfill unmatched rate is _measured_. If it proves empty/tiny, retire then (delete the skill dir + `skills-lock.json` entry + `docs/admin-jobs.csv` row 19 + `jobs:html`); if not, the skill's guarded human YouTube path still serves the tail the Spotify actor can't resolve. Retiring the safety net in the same PR that reintroduces the hazard is the wrong order.
- **Do NOT touch** `fluncle-backfill` (the Discogs/Last.fm catalogue cron, admin-jobs rows 8/9) or `fluncle-key-backfill` (Rekordbox ground-truth, row 20; its title+artist matcher is shared into `apps/web/src/lib/server/track-match.ts`).

## 5. Unit 3 — embeddings: gate on the key, run as a host timer

### The change

- `embed-sweep.ts` runs as a **rave-02 host systemd timer** (a windowed full-song MuQ forward is minutes; it must not occupy the shared gateway runner — the same M2 constraint as capture). Replace the `/api/preview/<id>` fetch (`:56-58`) with an S3-GET of `source_audio_key`.
- **Queue gates on the key:** `source_audio_key is not null AND embedding_json is null` (was `embedding_json IS NULL`, `embed-sweep.ts:14`). We deliberately do **not** embed previews (the blind vectors are the thing we're killing) and do **not** embed the unmatched tail (no vector beats a lying "quiet piano" vector). This coupling to capture is acceptable _only_ because embedding is non-urgent — unlike enrichment, which stays ungated.
- `embed-track.py` **must window the full song** — a ~5-min single forward blows past the box's 8 GB (2.85 GB was measured on a 30s preview). Chunk into ~30s windows, embed each, **mean-pool across windows** (bounds RAM and time). `BATCH_CAP → 1` (`embed-sweep.ts:37`). As a host timer the 120s/300s gateway kill no longer applies, but still bound the per-track wall-clock and **verify peak RAM < 8 GB on a real 5-min track** before enabling.

### Cleanup (both required)

1. **Resume `fluncle-embed`** as a host timer (deploy the updated sweep + `embed-track.py`; confirm `hermes cron`/timer status; watch first ticks).
2. **Re-embed the 3 preview-proof findings** (`2fyMcl41…`, `7tqoT2vU…`, `44iDh0Jq…`) **in place** — compute the new vector then overwrite; do **not** null-then-wait. (For 3 rows a direct Turso `UPDATE … SET embedding_json = NULL` re-queue is tolerable, but the _pattern_ to enshrine is compute-then-overwrite, because the archive re-derive (Unit 5b) must never strip a large slice of the live `get_similar_findings` "more like this" space, `schema.ts:79-85`.)

## 6. Unit 4 — Tier-A live references + a gate that measures the RIGHT thing

### The authorized full-song fetch (the bridge, on the M5)

The bridge authenticates to admin APIs via `loadAdminAuth()` (`plan.ts:166`, operator token) — **export `loadAdminAuth` + the `AdminAuth` type** (both private today, `plan.ts:158,166`). The full song is private, so the open `/api/preview/<logId>` relay cannot serve it. Add:

1. **A file-route carve-out** `GET /api/admin/tracks/:idOrLogId/source-audio` (verb_noun `get_source_audio`), modeled on the agent-tier preview endpoint (`tracks.$trackId.preview.ts`). **`requireOperator`** (full copyrighted bytes; only the operator-token bridge calls it — the box reads direct-S3, not this endpoint). Look up `source_audio_key`; `env.SOURCE_AUDIO.get(key)`; stream with the derived content-type; 404 when uncaptured. A legitimate `routes/api/**` media-proxy carve-out; R2 creds stay Worker-side.
2. **`fingerprintSourceAudio(logId, auth)`** in `fingerprint.ts`, mirroring `fingerprintPreview` exactly — any non-OK/miss/uncaptured/decode-failure → `{ frames: null }`, which `matcher.ts:263` `pendingAfter()` skips (the operator nudges past). Never-crash rail preserved: `fingerprintPlan` (`:158`) gains the `AdminAuth`, `boot()` (`serve.ts:63`) resolves it once, bounded concurrency 4, held in memory, network-free during the show; null `loadAdminAuth()` → all-null frames + a loud hold → the show runs fully manual. **Measure boot:** ~17 full songs at ~8-10 MB ≈ ~150 MB pulled through the authed endpoint + ~10× the ffmpeg/FFT work, all before `serve.ts` opens its socket. Pre-show, so acceptable — but quantify it and consider caching decoded fingerprints across bridge restarts.

### The accuracy gate — measure the regressions that CAN happen, not the one that can't

The panel proved the draft's headline metric was a **tautology**: the matcher pointer is monotone-forward _by construction_ (`matcher.ts:263-269,332,336`), so "ordering PERFECT / zero wrong-track" is _always_ green regardless of the score distribution — a full-song swap cannot make the closed-set pointer visit the wrong track or go backward. The regressions a full-song reference _actually_ introduces are **premature advances** (advance to the correct next track before the DJ mixed it) and **phantom advances** (advance to a track that plays minutes later) — both measured by the harness `spurious` counter (`accuracy.ts:159-175`), which the draft left _out_ of the gate. So:

- **Gate criterion is `spurious == 0` (or ≤ the preview baseline)**, renamed "no premature/phantom advances." Report the tautological ordering flag as the trivially-true structural fact it is, not a pass/fail.
- **Add the skip-ahead params to the mandatory retune.** The skip path (`matcher.ts:315-338`) fires a _double_ advance (`pointer = pending2`) on a _lower_ floor (`skipThreshold 0.7` vs `highThreshold 0.8`) and _shorter_ sustain (`skipSustainMs 1500` vs `sustainMs 4000`, `:97-98`). Foreign-score inflation under full-song references hits `skipThreshold`/`skipMargin`/`skipSustainMs` _hardest_, and a false skip is the worst error (a two-track jump). The draft analyzed only the single-advance thresholds.
- **Re-anchor the ground truth.** `anchors.json` is _per-preview_ alignment (`accuracy.ts:15-19`); the GT hook-times for the 2 tracks Tier-A exists to recover are derived from the _same blind preview alignment that fails on them_ — circular. Regenerate `anchors.json` from full-song alignment _before_ the gate, or "target 14/14" is unmeasurable.
- **Calibrate for MIXED references.** During the "land dark" transition and whenever a capture is `unmatched`/`failed`, a live plan holds _both_ full and preview references, which sit on _different score scales_ (different length **and** different adaptive `offsetStep`), breaking the global `sPend >= sCur + margin` hand-off (`matcher.ts:300`) and the skip margin (`:321`). Fix by holding a **uniform offset-_budget_** (score every reference over the same number of positions regardless of length — the `maxPositions` idea applied _uniformly_, which also normalizes the scale), **or** forbid mixed plans (fingerprint a plan all-full or all-preview). Run the gate on the _mixed_ configuration that will actually run live, not an all-full ideal.
- **Automate it.** `accuracy.ts` is a manual script excluded from `bun test` (`package.json:12`); `matcher.test.ts` asserts nothing about `spurious`. Add an automated regression assertion so the gate is not eyeball-only.
- **The harness swap is a code edit, not a fixtures drop** — `accuracy.ts:111` hardcodes `prev/<i>.mp3` (literal path + `.mp3`); it must take `full/<i>.<ext>` with variable extensions.

### The CPU mitigation (verified arithmetic — ship it)

A full reference (~2999 frames at 10 Hz, `mel.ts:18-24`) vs a preview (~299) makes `bestOffsetScore` (`matcher.ts:120`) score over 927 vs 27 sliding positions (`windowFrames 220`) — a verified **34.3×**; ~3 calls/tick × 10 Hz ≈ **245M MAC/s** (`MEL_BINS 40`), ≈ ¼-½ of a core because `frameCosine` is a scalar JS loop (`:106-112`) — contending with OBS on the M5. Fix: an **adaptive, budget-capped `offsetStep`** = `max(3, ceil((ref − windowFrames)/P))` with `P ≈ 150` → 147 positions → verified **6.3× cut** → single-digit % of a core; resolution loss negligible (22 s windows overlap ~91% at a 1.9 s shift — the alignment surface is smooth). Coarsening lowers self _and_ foreign scores, so **step and thresholds are coupled — recalibrate with this policy in place.** (Alternative/complementary: vectorize `frameCosine` to preserve full resolution — same win, no coarsening.) Thread a per-ref `step`/`maxPositions` into `bestOffsetScore` from its 3 callers (`:289,291,319`).

**Tier-A is additive.** If the retune cannot hit `spurious == 0` + ≥ 12/14 on the _mixed_ config, we **do not ship the reference swap** — the preview references + nudge remain, no regression. This protects the show and de-blocks Units 1-3 from the accuracy outcome.

## 7. Unit 5 — the archive: free capture-backfill, split from a gated re-derive

**5a — capture-backfill (in scope, safe, nearly free).** The migration defaults every existing row to `capture_status='pending'`, so the capture host-timer naturally drains the catalogue — but **oldest-first would starve new adds for days**, so capture prioritizes fresh adds over the backlog (a two-tier order, or newest-first for live adds). Write-only (adds a key column), clobbers nothing; the whole ~54-finding archive is well under 1 GB of proxy traffic ≈ **a one-time couple of dollars** on DataImpulse ($1/GB PAYG, never expires), pennies/month ongoing. This is the pipeline's "a backfill is the step's normal cron finding a non-empty queue" doctrine.

**5b — re-derive (machinery ships; running it at archive scale is operator-gated).** Capture alone does not improve an already-enriched/embedded finding (enrich re-derive is clobber-safe and fires only on null/fake BPM per Unit 1 step 3; embed's queue is `embedding_json is null`, and existing rows are non-null). Re-deriving the _whole_ archive is days of box compute that **overwrites derived data** — including the 3 BPMs the bpm-backfill skill hand-corrected. So:

- **Never null `embedding_json` across a slice** — it powers the live `/log` "more like this" row (`schema.ts:79-85`); a mass null degrades that public feature for days at `cap=1`. **Re-embed in place** (compute new vector → overwrite atomically) or null in small paced batches trailing capture, so no large slice is vector-less at once.
- **Enrichment re-derive is the clobber-safe trigger only** (null/fake BPM), so curated values are never overwritten.
- **The operator owns the "re-derive the whole archive?" decision** (cost + whether to reprocess good data). Ship the tested, paced, in-place, clobber-safe machinery; gate the archive-scale _run_ on the operator.

## Sequencing & ownership

- **Day one (no-op unblock):** Unit 0 (schema + migration).
- **The critical path is operator provisioning → Unit 1.** The single biggest de-risk is the vault token + the **private bucket created first**, then the `SOURCE_AUDIO` binding **and** the `get_source_audio` endpoint in **one commit** (a binding to a missing bucket fails `wrangler deploy` and takes down the _whole_ `apps/web` deploy, not just the feature). Confirm the CF build goes green.
- **This delivery's core = Units 2 + 3** (the two source-fix readers, parallel, disjoint files — `analyze-track.ts`/`enrich-sweep.ts`; `embed-sweep.ts`/`embed-track.py` — separate PRs). Enrich (Unit 2) lands with no queue change; embed (Unit 3) + capture (Unit 1) deploy as **host timers** via `docker cp` + the systemd-timer install (not the Worker build).
- **Tier-A (Unit 4) is a fast-follow** (ratified 2026-07-07 — core first): it lands once captures exist to fingerprint and the operator schedules the accuracy re-tune. Additive, so it never blocks the core; the Worker endpoint + `packages/live/*` are its own PRs.
- **Unit 5a** runs on the live capture timer (paced, new-adds-first). **Unit 5b** is operator-triggered.
- **Adjacent fix — the cron-mirror CI guard.** Extract `AUTOMATION_CRONS` from `fluncle-healthcheck.ts` to a side-effect-free module (the prober runs `main()` at import, `:959`), assert it matches `cronSurfaces()` modulo the `status:"hidden"` weight, and it will catch the _current_ `artist-sweep`/`artist-follow` drift plus guarantee `cron.capture` is on `/status`.

## Decisions — ratified + remaining provisioning

**Ratified 2026-07-07 (folded into the plan above):**

- **Copyright-posture escalation → store durably, box-orchestrated.** Narrow by two axes (durable-store + orchestration); the source is the sanctioned `yt-dlp`/YouTube match, not a Spotify DRM rip. Acceptance criteria carry the **`audio-source-policy` memory revision** ("never stored" → "stored private, never served") and the **`track-lifecycle.md:34`** rewrite.
- **Backfill the whole archive** (paced, in-place, clobber-safe — Unit 5, not gated).
- **Capture mechanism = box `yt-dlp` + residential proxy (sticky), validated end-to-end 2026-07-07** — supersedes the earlier "pilot two hosted actors" plan (the Apify actor served clips; the box's own `yt-dlp` beats the bot-wall through a sticky DataImpulse session and returns full masters).
- **Core first, Tier-A as a fast-follow** (Units 2+3 this delivery; Unit 4 lands once captures exist + the accuracy gate is scheduled).
- **`get_source_audio` = `requireOperator`** (the box reads direct-S3; only the bridge hits the endpoint, which returns full copyrighted bytes).

**Remaining operator provisioning (actions, sequenced — no forks left):**

1. **Residential-proxy + source-audio R2 creds → the vault** (`DATAIMPULSE_PROXY` + `FLUNCLE_SOURCE_AUDIO_R2` items are in the Fluncle Automations vault as of 2026-07-07). Env-var names, mirroring the `FLUNCLE_BACKUP_R2_*` precedent (`backup-sweep.ts:51-53`): the proxy `FLUNCLE_YTDLP_PROXY_HOST` / `_PORT` / `_USERNAME` / `_PASSWORD`; `FLUNCLE_SOURCE_AUDIO_R2_ACCESS_KEY_ID`; `FLUNCLE_SOURCE_AUDIO_R2_SECRET_ACCESS_KEY` (the bucket defaults to `fluncle-source-audio` in code like backup defaults to `fluncle-backups`; the existing public `R2_ACCOUNT_ID` is reused for the S3 endpoint). Add them as placeholder `op://` lines in the box's op-inject template (`docs/agents/hermes/secrets/`; concrete vault/item names live in the private "Fluncle — Ops Runbook" note), materialized by the `op-sync` timer into the shared `0600 ~/.fluncle-secrets.env` the sweeps source; they clear Hermes' provider-cred blocklist (unrecognized custom vars pass, `cron/README.md`). The R2 cred must be a Cloudflare R2 API token scoped **read-write to only `fluncle-source-audio`** — least-privilege, exactly as the backup cred never touches `fluncle-videos`. **The `APIFY_TOKEN` item from the earlier hosted-actor plan is now unused** (the box owns the fetch); leave it or delete it, code references none.
2. Create the private `fluncle-source-audio` bucket — no public domain — **before** the `SOURCE_AUDIO` binding merges (a binding to a missing bucket fails the whole `apps/web` deploy); land the binding + `get_source_audio` endpoint in one commit; confirm the CF build goes green.
3. Re-embed the 3: in place (recommended) vs a direct Turso null-and-requeue.
4. Schedule the operator-run **accuracy gate** on the M5 (for the Tier-A fast-follow) — re-anchored full-song fixtures + the copyrighted set.
5. bpm-backfill retirement stays **gated on the measured post-backfill unmatched-tail rate** (not now).

## Acceptance criteria

- **Capture:** a new add ends `source_audio_key` set + `capture_status='done'` within a capture cycle **and jumps ahead of the backfill**; an unfindable track → `unmatched` (terminal); a rate-limit → `failed` with backoff; capture runs as a host timer off the gateway runner. Tests: the queue filter (including the `capture_status is null` disjunct), the status transitions, the clobber-safe enrichment-reset trigger (fires on null/fake BPM only).
- **Enrichment:** the queue is **ungated** (actor-independent); the sweep prefers full audio when keyed, else preview, permanently; a beatless-preview finding yields in-band BPM after capture re-derives; the inline AcousticBrainz fallback is retained; bpm-backfill skill retained pending the measured unmatched rate; `analyze-track --audio-file` test.
- **Embeddings:** queue gates on `source_audio_key not null AND embedding_json is null`; `embed-track.py` windows + mean-pools with **verified peak RAM < 8 GB** on a real 5-min track; host timer; cron resumed + on `/status`; the 3 re-embedded **in place**; a windowing test.
- **Tier-A:** `get_source_audio` streams private bytes under `requireOperator`, 404 on uncaptured, passes the oRPC/route coverage tests; `fingerprintSourceAudio` null-frames fallback test; `loadAdminAuth`/`AdminAuth` exported; adaptive budget-capped `offsetStep`; **the gate recorded: `spurious == 0` (≤ baseline), the skip params retuned, `anchors.json` re-anchored from full audio, run on the MIXED config, with an automated assertion** (target 14/14, timing tighter).
- **Docs/canon:** `docs/track-lifecycle.md` gains the capture side-channel **and revises the "never a full song" / "reads the preview" lines**; `docs/full-audio-embedding.md` deleted/redirected here; `@fluncle/registry` `cron.capture` + resumed `cron.embed` + the CI mirror-guard; `docs/admin-jobs.csv` rows + `jobs:html`; the `audio-source-policy` + `track-enrichment-pipeline` memories updated (posture change named).

## Risks & open questions

- **Copyright posture** (M1) — the durable-store escalation. Mitigated by: enrichment never depends on it (side-channel design), backoff, `unmatched` terminal, and the same `yt-dlp`/YouTube source `fluncle-bpm-backfill` already sanctions — no new vendor, just the box fetching (through a proxy) and storing.
- **YouTube arms race / proxy** — `yt-dlp` vs YouTube's bot-walls + PoToken changes; the box owns this (unlike a hosted actor that owns it for you). Mitigated by: a `pin-watch`-style freshening of the `yt-dlp` binary, the sticky-session requirement (validated), a player-client-tuning retry on 403 (`tv,web_safari`), and a PO-token plugin as the next escalation; the residential proxy is DataImpulse PAYG (swap-able — cron is proxy-agnostic).
- **Match quality** (surfaced by "how do we source from Spotify?") — `yt-dlp` returns a _title/artist YouTube match_, not Spotify's master, so a wrong-version rip (remix/live/sped-up/radio-edit/remaster) would poison every reader and is sharpest for Tier-A. Mitigated by the `ytsearch` ranking (prefer official/`- Topic`, de-rank remix/live markers) + the `duration_ms` match-guard (→ `unmatched` on mismatch) + shape-normalized log-mel tolerating remasters; residual risk is a same-length different-edit, caught only if the operator spots it. The operator's own Rekordbox files are the escape hatch for Tier-A fidelity.
- **The embed RAM/wall-clock** (Unit 3) — a too-long or too-hungry full-song embed. Mitigated by windowing + `cap=1` + host-timer isolation + the < 8 GB verification gate.
- **Shared serial runner** — resolved by moving capture + embed to host timers; the enrich/context/note sweeps stay unblocked.
- **Accuracy** (Unit 4) — if the retune can't hit `spurious==0` on the mixed config, Tier-A holds (additive, no regression). Protects the show.
- **The re-derive stampede** (Unit 5b) — resolved by in-place/paced re-embed + clobber-safe enrich + operator gating.
- **Tier B (out of scope, roadmap `Next`):** open-set free-mixing needs full-audio + Tier-A first, plus a transform-robust fingerprint (DJ pitch/tempo/EQ), mix-overlap handling, and an archive index (the roadmap's own MuQ-embedding coarse-prefilter → `bestOffsetScore` confirm sketch). Its own RFC once this lands.

## Appendix — corrections, verifications & sources

**Panel corrections baked in (draft → final):**

- Capture no longer gates the analysis queues (staff-eng B1 + product + taste): starvation of the `unmatched` tail and whole-pipeline coupling to one actor. Now a non-blocking side-channel; enrich races, embed gates, both safe.
- `capture_status` is `notNull().default("pending")` (staff-eng B2): the draft's nullable column + explicit-column insert + `in (...)` query was a silent no-op on every new add.
- The `discogs_status` precedent was **fictional** (staff-eng M3, cited ~4×); re-grounded on `enrichment_status` + `context_status` + the `backfill_discogs_*` quartet.
- Re-derive never nulls `embedding_json` across a slice (staff-eng M4): protects the live `get_similar_findings` "/log" feature; re-embed in place.
- Capture + embed are **host systemd timers** (ops M2/M3): the box's one shared serial runner + global timeout would starve the 5-min sweeps; a proxied `yt-dlp` fetch has an unbounded tail against the 120s kill (embed is minutes-scale).
- Copyright posture reframed as a genuine escalation (ops M1); `SOURCE_AUDIO` binding sequenced behind bucket creation to avoid a whole-site deploy failure (ops M4); secrets routed like `FLUNCLE_BACKUP_R2_*` past the provider-cred blocklist (ops m6); the CI mirror-guard is a real deliverable catching _current_ drift (ops m5).
- The accuracy gate measures `spurious == 0` not the tautological ordering, adds the skip-ahead params, re-anchors GT, and calibrates for mixed references (live-DSP B1/B2/M3/M4); the harness swap is a code edit + `anchors.json` regen (live m5); boot pulls ~150 MB, measure it (live m6).
- Schema trimmed 7 → 5 columns (taste + staff-eng); bpm-backfill retirement deferred to a measured tail (product + taste).

**Verified & holds:** the private-bucket need (`media.ts:13`, `backup-sweep.ts:49`, `wrangler.jsonc:53`); the box S3-direct precedent + missing GET (`backup-sweep.ts:248`); one prod `tracks` insert (`publish.ts:177`); the CLI worklist shape (`enrich/embed --queue`, `admin-tracks.ts:152-162`, `cli.ts:598,625`); the `--audio-file` proof (`bpm-backfill/scripts/analyze-local.ts`); `embed-track.py`'s single-forward → must-window (`:107-108`); the never-crash rail (`fingerprint.ts:122,129,133` → `matcher.ts:263`); all the CPU arithmetic (34.3× / 927 vs 27 / 245M MAC/s / 6.3× — frame-exact at `mel.ts:18-24`, `MEL_BINS 40`); the adaptive-step coupling; migrations auto-apply on deploy.

**Capture-mechanism validation (rave-02, 2026-07-07):** the box's raw Hetzner IP (AS24940) is bot-walled by YouTube on the first search + download request. Through a DataImpulse residential proxy the exit IP reads as a real ISP (e.g. AS803 SaskTel) and the page/player/`ytsearch1:` all succeed; on the default rotating port the media-bytes fetch 403s (googlevideo IP-locks the URL to the player-JSON IP), fixed by a sticky session (`__sessid.<id>` username suffix → one exit IP for ~30 min; verified 3 requests → one IP, then a full 6.14 MB / 388 s opus master downloaded clean, 133 kbps). Duration match on `ytsearch` verified (335/334.7 s). The rejected alternative: `maximedupre/spotify-downloader` (Apify, $0.00265/track) served a 157 s **clip** from `cdn-spotify-247.zm.io.vn`, not full songs — caught by the duration guard.

**Plan/cost (settled 2026-07-07):** capture is **box `yt-dlp` through a DataImpulse residential proxy** ($1/GB PAYG, never expires — set up with $5 credit) — no Apify, no monthly rental, no per-track actor fee. The whole ~54-finding archive is well under 1 GB ≈ **a one-time couple of dollars**, ongoing capture pennies/month. This is ~50-100× cheaper than any hosted full-audio actor (all of which are $5-7/mo rentals, because they pay for the same residential proxies) at our volume, and the box owns the fetch end-to-end. Proxy is swap-able (IPRoyal, Decodo, Webshare) — the cron is proxy-agnostic. The `APIFY_TOKEN` vault item from the earlier plan is now unused.

## Paste-ready `/goal`

```
Build full-song capture per docs/full-audio-rfc.md — capture is a NON-BLOCKING parallel side-channel, not a queue gate. Unit 0 (DONE, PR #359 merged, migration 0051 no-op): source_audio_key + capture_status (notNull default 'pending' — load-bearing) + captured_at/attempted_at/failures on tracks. Unit 1: a fluncle-capture rave-02 HOST systemd timer (NOT a gateway cron — shared serial runner) drains capture_status by running yt-dlp on the box through a DataImpulse residential proxy on a PER-TRACK STICKY session (__sessid.<logId> — rotating 823 gives 403 on the media bytes; validated 2026-07-07); ytsearch1:"<artist> <title>" → -f bestaudio → ffprobe duration match-guard (±3s of duration_ms, else unmatched) → S3 PUT to the NEW PRIVATE fluncle-source-audio bucket at analysis/source/<logId>/<hash>.<ext>; on 403 retry once with --extractor-args youtube:player_client=tv,web_safari; on writing a key, reset enrichment_status ONLY where BPM is null/fake (clobber-safe); new adds jump the backfill; add-paths UNCHANGED; queues NOT gated on the key. Unit 2: analyze-track.ts --audio-file; enrich queue UNCHANGED (capture-independent), sweep prefers full audio else preview permanently; KEEP AcousticBrainz + KEEP the bpm-backfill skill until the unmatched tail is measured. Unit 3: embed-sweep as a HOST timer, queue gates on (source_audio_key not null AND embedding_json is null); embed-track.py WINDOW the song (~30s mean-pool, verify RAM<8GB); cap=1; resume fluncle-embed; re-embed the 3 IN PLACE. Unit 4: GET /api/admin/tracks/:id/source-audio (requireOperator, private R2); export loadAdminAuth/AdminAuth; fingerprintSourceAudio (null-frames rail); adaptive budget-capped offsetStep; accuracy gate = spurious==0 (NOT tautological ordering) + retune the SKIP params + re-anchor anchors.json from full audio + calibrate on MIXED refs + automate the assertion. Unit 5a: capture-backfill (cheap, new-adds-first). Unit 5b: re-derive IN PLACE/paced/clobber-safe, operator-gated. Tier B (free-mixing) out of scope (roadmap Next). Operator FIRST: DataImpulse proxy creds + source-audio R2 cred → box op-inject template (FLUNCLE_YTDLP_PROXY_* + FLUNCLE_SOURCE_AUDIO_R2_*; vault items exist), create the private fluncle-source-audio bucket BEFORE the SOURCE_AUDIO wrangler binding (binding+get_source_audio endpoint one commit), the accuracy gate. Tests + docs (incl. revising track-lifecycle.md:34 + the audio-source-policy memory) are part of done.
```
