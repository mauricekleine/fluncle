# RFC: Fluncle Studio — the mixtape set → clip pipeline (footage clips; distribution deferred)

**Status:** Final (4 research threads → /taste → 4-role adversarial panel synthesized, 2026-06-29) — completeness standard applied; operator decisions resolved inline. Amended 2026-06-29: Unit F (the `/log` set-video player + video SEO) shipped (#208); Unit A's CLI surface is now `fluncle admin mixtapes distribute --set-video` (the staging folds into the normal distribution flow) rather than a standalone `studio ingest`, and `--set-video` stages **one 1080p rendition — no raw master on R2** (it serves the `/log` player, the editor, and the clip cut; the pristine master stays a local archive). Added **Unit G — the cross-mixtape clip library** (`/admin/clips`: browse/filter/download, distribution-ready) and made the **one-set → many-clips** model explicit.
**For:** a fresh build session / a small team of agents.
**Canon/authority:** the codebase + `AGENTS.md`, `DESIGN.md`, `VOICE.md`, `PRODUCT.md`, `docs/video-variants.md`, `packages/skills/fluncle-mixtapes/references/spine-model.md`. Planning, not spec; code + canon win on conflict.

> Process note: four divergent research threads (cut architecture · editor UX · drop-detection DSP · data model), a `/taste` pass, and a 4-role adversarial panel (staff engineer · design/brand · media-perf · product-scope) that verified claims live against the code and current (June 2026) Cloudflare docs. Their corrections and reframes are baked in; verifications + sources in the appendix. The panel caught real load-bearing errors in the draft — they are corrected here, not papered over.

## The standard (definition of done)

The clipping core ships complete — implementation + tests + docs, every thread tied off. "Holy shit, that's done," not "good enough."

- **Nothing in the clipping core is deferred or optional.** Set-video staging (the `--set-video` rendition), set analysis, the footage cut (with its minimal brand frame), the data layer + cue-unlock, the editor, the **clip library** (browse/filter/download across sets), and the `/log` set-video player all ship.
- **Tests + docs are part of done** (oRPC coverage + auth-tier tests, the DSP picker unit test, the cut-job test, the `set_mixtape_cues` guard test, `docs/fluncle-studio.md`) — in acceptance criteria, not a follow-up.
- **The only sanctioned "not now":** (1) **distribution** to IG/TikTok — a separate outcome with a genuine external blocker (IG's 2026 AI audio-fingerprinting mutes copyrighted audio on API Reels; no API music path; the in-app post is the irreducible manual beat). (2) The **full cosmos composition** over footage — a real enhancement chain on top of the shipped minimal-brand footage clip. Both are honest scoping.
- **Dangling threads this build ties off:** the mixtape gets a **clip-capable rendition on R2** (one 1080p `set.mp4` serving the clip cut + the `/log` player + the editor; the raw master stays local), and **#1's missing per-track cues** become backfillable.

## 0. Summary / the reframe

- **The unifying simplification: one 1080p rendition earns its keep three ways.** `distribute --set-video` derives one 1080p faststart rendition to R2 once, and it is simultaneously (a) the **clip source** (Unit C crops 9:16 from it), (b) the **`/log/<mixtapeLogId>` set-video player** (shipped 2026-06-29, #208 — player + video SEO), and (c) the **editor scrub-preview**. The raw multi-GB master **never goes to R2** — it stays a local archive; a 9:16 social clip from a 1080p rendition is plenty (the platforms re-encode it anyway), so a separate clip-source master earns no R2 place. The draft's hardest blocker ("the 2GB master has no R2 home") dissolves — we don't need it there.
- **Clips are real footage, framed — not generated.** v1 cuts a **9:16 portrait window from the landscape 1080p rendition** (never a squared source — squaring double-crops the frame away), with an operator-chosen x-offset, plus a **minimal brand frame** (Artist — Title, the `fluncle://` coordinate, a small Fluncle mark). This keeps the human-mixing warmth (PRODUCT.md's _warm, crewed_ axis) while carrying enough narrative to satisfy the surface-saturation rule. The full cosmos composition is a later enhancement.
- **MT is the finisher, not the aspect engine** (panel correction). Cloudflare MT crop is **centre-only**, so the framed 9:16 is **baked at the ffmpeg cut**; MT then derives resolution ladders / poster / silent-audio variants from that ≤60s, ≤100 MB clip. A clip is stored as its **own pseudo-finding namespace** `<clipId>/footage.mp4` so the existing `videoCrop(clipId, …)`/`videoPurgeUrls(clipId, …)` helpers work **unchanged** (they're hardwired to `<logId>/footage.mp4` — a `clips/<id>.mp4` subpath gets zero fan-out; the draft was wrong here).
- **One DSP envelope, two jobs.** The set's energy/bass/flux envelope (computed once on the box from the **R2 audio**, which already exists) is both the auto-suggest signal and the editor's waveform data. Auto-suggest is candidate drops the operator vets — not certainties.
- **The cue model already shipped; only the publish-freeze blocks #1.** `mixtape_tracks.start_ms` + the cue-sheet parser + `mixtape-chapters.ts` are live; a narrow, hardened `set_mixtape_cues` write-path unlocks post-publish backfill without touching the frozen set/order.
- **The editor is mixtape-scoped and ~70% assembly** — `/admin/studio/$mixtapeId` entered from the mixtape row (not a 4th nav peer), built from `AdminShell fill` + `VibeMap`'s pointer model + `useVideoStallRecovery` + the radio clock + Shadcn `ui/*`.
- **Decomposition:** A (set-video staging) and B (set analysis) are independent, ship day one. C (the cut) needs A's rendition + the clip object. D (data layer) is independent (ship with B). E (editor) needs A's rendition + C + D. G (clip library) needs C's rendered clips + D's ops. F (`/log` player) is shipped; A automates its staging. Distribution (push-to-social from G) + full-cosmos are later.

## 1. Context & goals

**Why now:** mixtape #2 is re-recorded this week; the empty `@fluncle` Instagram wants a clip drip-feed, and the mixtape `/log` pages want their set video. The goal is the platform-independent **footage-clipping core**: an `/admin/studio` editor that turns one landscape set into many framed, captioned 9:16 footage clips (auto-suggested + hand-picked), ready for whatever distribution lands later.

**The decided fork (operator):** clips are **real footage of the mix**, not generated cosmos composites — the personal "watch a human mix" touch is the brand asset here, reconciled with canon by a minimal brand frame (§4). The panel recommended generated clips (simpler, dodges the footage source entirely); the operator overrode it deliberately, and the set-video staging pays for itself via the `/log` player regardless.

**Honest calibration:** in reach now — ingest, analysis, the footage cut, the data layer, the editor, the `/log` player. Out of this RFC — distribution (a real external IG-audio blocker) and the full cosmos composition. Whether clips _perform_ on socials is an outcome we don't control. A content note, not a code item: future sets want a **portrait-aware camera frame** (the current top-down angle centre-crops to an awkward 9:16, as the operator confirmed) — the editor's framing offset mitigates existing footage; better staging fixes it at the source.

## 2. Unit A — Set-video staging via `distribute --set-video`

**Direction:** fold the staging into the existing `fluncle admin mixtapes distribute` command as a **`--set-video`** flag — so the `/log` set video, the editor preview, **and** the clip source all come free with the normal mixtape distribution flow. This replaces the manual three-step staging the `fluncle-mixtapes` skill documents today (rendition → `aws s3 cp` → flip the toggle); `mixtapeSetVideoUrl` + the `/log` player + the video SEO already shipped (#208), so this is purely the automation of the staging + the flag-flip.

**Resolved (the key simplification — Decision 5):** stage **exactly one artifact — a 1080p faststart rendition** — and **never put the raw multi-GB master on R2**. Every R2 consumer (the `/log` player, the editor scrub, the clip cut) is served by that one rendition; the only thing that wants the pristine raw master is archival / a one-off pristine clip, which is a **local** concern (the operator's disk). A 9:16 social clip cropped from a 1080p rendition is more than enough — the platforms re-encode it anyway — so a separate clip-source master earns no place on R2.

**`fluncle admin mixtapes distribute <id> --video <mixtape>.mp4 --set-video`** does two things beyond the YouTube/Mixcloud legs:

- **Derive + stage one 1080p faststart rendition** (clip-capable; ~1080p CRF ~18–20, ~1 s GOP for scrubbing, ~1.5–2 GB) at `<logId>/set.mp4` — the single source for the `/log` player, the editor scrub-preview, **and** Unit C's cut. **Not capped at 100 MB** (it is never an MT input; it's played + cropped directly over R2 range requests). Multipart upload (the single-PUT presign, `r2-presign.ts`, ~200 MB budget, won't move it) via the set-video presign op (§5). Bytes move CLI-direct (the Worker can't proxy it — same constraint as the YouTube/Mixcloud legs).
- **Flip `setVideoAt`** via the existing operator-tier `update_mixtape` → the `/log` player + the `<video:video>` sitemap entry + the VideoObject light up (Unit F, shipped).

**Embargo:** the rendition follows the mixtape's publish state. `--set-video` runs at distribute (= publish), so the normal path stages it public. The only private-then-flip case is **pre-release backlog clipping** (stage the rendition early to build clips before launch, private until publish) — a deliberate opt-in, not the default.

**Idempotent + backfill:** `--set-video` re-run on an already-published mixtape just re-stages + re-flips (backfills an older set). The raw master stays local; if a _pristine_ hero clip is ever wanted, cut it from that local master on the Mac as a one-off (the 1% case, not the drip-feed). `mixtapeSetVideoUrl` is the only helper needed (shipped); no `mixtapeMasterUrl`.

**Edge cases:** confirm R2 `accept-ranges: bytes` + `+faststart` survive the custom-domain hop (Safari range probing); if editor seeking ever feels heavy at 1080p, the lever is a lighter preview rendition, not re-introducing the raw master.

## 3. Unit B — Set analysis (the box, off R2 audio)

**Direction:** extend `packages/video/src/pipeline/analyze-audio.ts` — factor `computeBands`/`onsetEnvelope`/`normalize*` into a shared module, add `analyze-set.ts` that decodes the set m4a (`mixtapeAudioUrl`, already on R2) and emits full-length curves + candidate windows. De-riskable on **mixtape #1's existing R2 audio** day one.

**Corrections baked in (panel):**

- **Local, not global, tempo.** A 48-min set is multi-tempo; the existing single global `estimateBpm` + single-phase grid drifts ~8 beats by the end. Do **local tempo+phase in a ±~8 s window around each candidate peak** (or skip grid-snap and snap to the nearest local energy beat). Do not ship a global downbeat-snap claim.
- **The picker is new logic, not "the kernel generalized."** The existing kernel nudges a **fixed 400 ms** (≈1 beat at 174), not a bar; top-N peak-picking + local-snap + the pre-roll are new. Score `meanEnergy + 2·meanBass + 0.02·onsetDensity` is reused. Candidates are **loudness-rise candidates**, surfaced as `kind: "drop"` but **operator-vetted** — soft re-entries false-positive; don't oversell precision.
- **Local (per-track / windowed) normalization**, not global max — global pins the scale to the single loudest drop and buries good quieter ones, hurting variety.
- **Streaming decode.** `decodeWav` reads the whole WAV into a Buffer _and_ a Float32Array (≈190 MB at 11025 Hz, ≈381 MB at 22050 — not the draft's 254). Decode **chunked / piped from ffmpeg stdout** at 11025 Hz (Nyquist 5.5 kHz is fine for a bass-keyed picker).

**Artifact (`StudioEnvelope`, written to a private/admin-readable key — embargo):** `{ durationMs, hopMs (~100ms display), energy[], bass[], flux[], peaks[], suggestions[] }` (the 20 ms analysis stays internal; only the decimated curve crosses the wire; omit a global beat grid on multi-tempo sets).

## 4. Unit C — The footage cut (the box) + the minimal brand frame

**Direction:** a clip is a real ffmpeg cut from the landscape **1080p rendition** (Unit A's `<logId>/set.mp4` — the box pulls it from R2; the raw master is never on R2), framed to 9:16, with a minimal brand layer, stored as a pseudo-finding so MT finishes it.

**Plan:**

- **Cut + frame in one ffmpeg pass:** `ffmpeg -ss <inMs> -i set.mp4 -t <durMs> -vf "crop=ih*9/16:ih:<xOffset>:0,scale=1080:1920,<brand overlay>" -c:v libx264 -c:a aac -movflags +faststart` (input = Unit A's 1080p rendition). The **9:16 crop comes from the landscape** with the operator's `xOffset` (never a square intermediate); `-ss` before `-i` + re-encode is frame-accurate in modern ffmpeg. **Bitrate-cap so the clip's `footage.mp4` is < 100 MB** (a 60 s 1080×1920 cut can exceed it; store 1080-tall, cap CRF/bitrate) — else MT 400s the fan-out.
- **The minimal brand frame** (reconciles footage + narrative-saturation): Artist — Title (system sans), the `fluncle://<mixtapeLogId>` coordinate (Oxanium tabular), a small Fluncle mark, grain per the Light-Years Rule — composited at cut time (ffmpeg `drawtext`/overlay, or a thin Remotion pass over the footage if the typographic control is wanted). NOT the full cosmos composition (that's the later enhancement). The look must clear AA over arbitrary footage (a scrim behind the text).
- **Store as a pseudo-finding** `found.fluncle.com/<clipId>/footage.mp4`, so `videoCrop(clipId,…)`/`videoCropPoster(clipId,…)`/`videoAudioStripped(clipId,…)`/`videoPurgeUrls(clipId,{squared:true})` work **unchanged** — MT derives the resolution ladder, poster, and silent cut from the baked 9:16. (The draft's `clips/<id>.mp4` subpath is deleted — those helpers are hardwired to `<id>/footage.mp4` with no source param.)
- **Centre-only crop is a hard MT limit**, which is _why_ the framing bakes at ffmpeg — `cropX/cropY` live as ffmpeg params, **not** an MT capability; do not promise MT off-centre fan-out.
- **Where it runs:** the deterministic ffmpeg trim + the DSP need no GPU and none of the render box's agent machinery (`claude -p`, tmpfs creds, `freshen_checkout`). Run them on the **always-on Hermes box (rave-02) — confirm/install ffmpeg there** — not a new conductor on the GPU render box. (Decision 1.)
- **Purge:** re-cut to the same `clipId` key → `videoPurgeUrls(clipId, …)` the finite set, or the edge serves the stale cut (#152 lesson).

## 5. Unit D — Data layer (schema + contracts)

**A set yields MANY clips** — that's the whole point (a backlog to drip-feed). One-to-many via `mixtapeId`; an editor session (Unit E) mints several rows, and they're browsed/managed across sets in the clip library (Unit G).

**Clip = lightweight derivative, NOT a spine object** (no Log ID — the spine namespace is scarce/collectible; a clip is a re-cuttable trailer). New table **`mixtape_clips`** (via `db:generate`): `{ id (pk = clipId), mixtapeId (FK), inMs, outMs, xOffset, caption?, status, createdAt, updatedAt }` (centre-aspect is always 9:16 in v1; `xOffset` is the framing; `status` tracks `pending`/`done` for the cut queue + drives the library filter; no `cropX/cropY` MT fiction). Distribution **deferred** → a sibling `mixtape_clip_social_posts` table later, never `*_url` columns.

**Cue persistence — the field exists** (`mixtape_tracks.start_ms`); the gap is the publish freeze. New **`setMixtapeCues(id, [{ref, startMs}])`** helper, **hardened** (panel M1): `ref` is a **trackId** (matches the `(mixtapeId, trackId)` unique index — not a position); it **UPDATEs `start_ms` on existing members only**, asserts the **mixtape is non-draft** + the **member set is unchanged** (same count + trackId set) as a state backstop (not handler-discipline alone), and validates **monotonic, start-at-0 cues** (YouTube chapter rules). Note (M2): backfilling #1's cues updates the DB + `/mixtapes` but **not** the already-distributed YouTube description chapters — a chapters re-push is out of scope, flag it.

**oRPC ops** (admin-mixtapes contract + handlers; loose/passthrough bodies):

| op                         | method + path                                        | tier     |
| -------------------------- | ---------------------------------------------------- | -------- |
| `list_clips`               | `GET /admin/clips` (optional `?mixtapeId`/`?status`) | admin    |
| `create_clip`              | `POST /admin/mixtapes/{mixtapeId}/clips`             | operator |
| `update_clip`              | `PATCH /admin/clips/{clipId}`                        | operator |
| `delete_clip`              | `DELETE /admin/clips/{clipId}`                       | operator |
| `set_mixtape_cues`         | `PUT /admin/mixtapes/{mixtapeId}/cues`               | operator |
| `presign_set_video_upload` | `POST /admin/mixtapes/{mixtapeId}/set-video/presign` | operator |
| `presign_clip_upload`      | `POST /admin/clips/{clipId}/presign`                 | operator |

**Seven ops, not five** (panel C4): the existing `presign_track_video_uploads` is track-scoped + footage-required — it can't sign a mixtape set-video rendition or a clip output, so two new **multipart** presign ops are required (`presign_set_video_upload` for `<logId>/set.mp4` from the CLI; `presign_clip_upload` for `<clipId>/footage.mp4` from the box). **Build-gate obligations** (verified accurate): every op into `ADMIN_ROUTE_OPS` (`orpc-admin-coverage.test.ts`) and `EXPECTED_TIERS` (`orpc-auth-coverage.test.ts`, reference-equal middleware check — wire `.use(adminAuth)` for the read, `.use(adminAuth).use(operatorGuard)` for writes); register in the contract export; run `naming-convention-linter`. `list_clips` (filterable by `mixtapeId`) serves **both** the editor (Unit E, one set) and the clip library (Unit G, all sets). Note: `list_*` matches the coverage net's public-op-prefix heuristic — verify `list_clips` lands as `admin` in `EXPECTED_TIERS` and isn't demanded by the public net (M4). Captions authored via `copywriting-fluncle`; store clean, append `fluncle://<mixtapeLogId>` only at payload-build; **add a clip-caption register to VOICE.md** before the first post.

## 6. Unit E — The editor (`/admin/studio/$mixtapeId`)

Entered from a **"Clip this set" action on a minted `MixtapeEditor` row** (mixtape-scoped, not a 4th nav peer — resolves the IA decision). A full `AdminShell fill` page, assembled:

- **Hero preview** (the web rendition from Unit A) over `<video>` + `useVideoStallRecovery`, `preload="metadata"`; one clock — the video's `requestVideoFrameCallback` `mediaTime`; the scrubber + waveform _read_ it (radio's "one clock" discipline).
- **One quiet energy lane** below (two-zone calm) drawn in the **warm-neutral ink ramp** — Stardust `#b7ab95` curve, Starlight Cream `#f4ead7` active region (panel P0: galaxy tints fail contrast — 1.1–1.3:1, nebular can't clear 3:1 — _and_ violate Warm Dark/Retint; the neutral ramp is canon _and_ AA). Bass/flux are optional overlays behind the settings cog.
- **Suggestion-first** (taste): auto-suggested windows render as **dashed-Stardust ghost regions** the operator accepts/nudges/adds; hand-pick drags an in/out band. **A session mints many clips** — accept several suggestions + hand-pick more — each its own `mixtape_clips` row + queued cut (browse/manage them across sets in the library, Unit G). **Color governance:** gold = the **Create clip** action only; playhead = Cream; candidates = dashed Stardust; committed region = Gold-Veil `#f5b8001a` (one sun).
- **Crop framing** = a draggable 9:16 rect over the landscape preview (the `VibeMap` pointer model) → an `xOffset` baked at cut time. This is the framing the awkward centred crop needs.
- **Settings cog** (`Popover`, the radio precedent): clip length, the brand-frame toggle, the framing reset. **Cut the DAW flourishes** (taste): no spectrogram (a later stretch with wavesurfer), no J/K/L shuttle/frame-step (drop-aligned cuts don't need frame precision; arrow-nudge suffices).
- **a11y/canon:** `components/ui/*` only (no `@base-ui/react/*`); Phosphor icons; reduced-motion = clock/pointer-tracked values are _content_ (not gated — cite the VibeMap precedent), only easing/auto-scroll is suppressed; `role="application"` + `aria-label` + `aria-live` time readout. `canon-reviewer` + a11y pass before merge.

## 7. Unit F — the `/log` set-video player (SHIPPED)

**Done** (#208 + the video SEO, 2026-06-29): the mixtape `/log/<mixtapeLogId>` page shows the set video as the hero (replacing the cover) when `setVideoAt` is set — a branded scrubber-driven `<video>`, range-streamed from `<logId>/set.mp4`, plus the `<video:video>` sitemap entry + VideoObject JSON-LD + og:video (crawled like the finding clips). `019.F.1A` is live. The reusable `VideoScrubber` built here is the exact one the editor (Unit E) inherits. The only remaining gap is **Unit A automating the staging** (`--set-video`) that is operator-manual today (per the `fluncle-mixtapes` skill).

## 8. Unit G — The clip library (`/admin/clips`)

A set yields **many** clips, so beyond the per-set editor (Unit E) there's a cross-mixtape **clip library** — an `/admin/clips` grid of every clip, **filterable by mixtape** (and `status`). Each card shows the 9:16 poster (`videoCropPoster(clipId)`) + the source mixtape + the caption + the in/out, with inline preview (the shared `VideoScrubber`) and a **download** action: the rendered clip from R2 — **with-audio** (`<clipId>/footage.mp4`) for IG, or the **silent** variant (`videoAudioStripped(clipId)`) for TikTok — so the operator posts it manually (the irreducible in-app beat; IG/TikTok have no API music path — see §1 + the TikTok-inbox precedent). Built from `AdminShell` + the existing pipeline-board grid patterns + the shared player; reads `list_clips` (filterable); `delete_clip` prunes a bad cut.

**This is where distribution lands when it's built** (deferred — see The standard): a per-clip **"push to Postiz / push to a platform"** action becomes a column here, writing `mixtape_clip_social_posts` rows (the sibling table in Unit D). **Download-and-manual-post is the shipped v1; push-to-social (Postiz or direct) is the documented next layer** that hangs off this surface — so the library is built distribution-ready (the row + the status column) without building distribution now.

## Sequencing & ownership

- **Day one (parallel):** **A** (`distribute --set-video` — the 1080p rendition staging + the presign ops) and **B** (the `analyze-set.ts` envelope/picker, de-risked on **#1's R2 audio**) and **D** (the `mixtape_clips` table + the 7 ops + coverage + the hardened `set_mixtape_cues`). A and D unblock everything; B proves the DSP independently. (Unit F — the `/log` player — is already shipped; A automates its staging.)
- **Then C** (the footage cut) needs A's rendition + D's clip object. **Then E** (editor) needs A's rendition + C + D, and **G** (clip library) needs C's rendered clips + D's `list_clips`. (F is shipped.)
- **Biggest de-risk:** run B against mixtape #1's audio first (proves the picker, zero dependence on the #2 re-record), and stage #1's rendition (Unit A) to validate the multipart upload (#1's `/log` player is already live from the manual staging).
- **Deploy discipline:** one PR per unit; mind Cloudflare build coalescing on `main` merges.

## Decisions needed BEFORE handoff

Most are resolved (operator). Remaining:

1. **Box for the ffmpeg cut + DSP:** the always-on Hermes box (rave-02) — confirm/install ffmpeg there (recommended; deterministic, no GPU). vs the render box.
2. **The minimal brand frame's exact treatment** — ffmpeg `drawtext` (simplest) vs a thin Remotion overlay pass (more control, sets up the future cosmos version). Recommend Remotion-thin for typographic + grain canon.
3. **Pre-release clipping embargo** — the default `--set-video` runs at distribute (= publish), so the rendition stages public, no embargo. ONLY if clips are built _before_ the set publishes does the rendition need to stage private then flip public on release — confirm that flip mechanism (a key move/copy vs an R2 ACL change) when/if pre-release backlog clipping is wanted.
4. **`/log` player default-on for all mixtapes**, or opt-in per mixtape? (Today it is opt-in via the `setVideoAt` flag — keep that.)

**Resolved (Decision 5):** `--set-video` stages **one 1080p rendition, no raw master on R2** — that rendition serves the `/log` player, the editor, and the clip cut; the pristine master stays a local archive (a 9:16 social clip from a 1080p rendition is plenty, platforms re-encode anyway). See Unit A / §0.

## Acceptance criteria

- **A:** `fluncle admin mixtapes distribute <id> --set-video` derives + multipart-uploads one 1080p faststart rendition to `<logId>/set.mp4` and flips `setVideoAt` (idempotent re-run backfills an already-published set; the raw master never goes to R2); a **test** of the presign+upload shape; `docs/fluncle-studio.md` documents the flag + the rendition spec. Replaces the manual three-step staging in the `fluncle-mixtapes` skill.
- **B:** the box produces a `StudioEnvelope` for mixtape #1 from its R2 audio; the top-N picker has a **unit test** (spacing, local-snap, pre-roll) and is **validated on the real set** (snap accuracy, candidate sanity) — not just a fixture.
- **C:** a clip job cuts a framed 9:16 < 100 MB clip (its `footage.mp4`) with the brand frame → stored as `<clipId>/footage.mp4` → `videoCrop(clipId)` derives the ladder/poster/silent; re-cut purges; a **test** of the cut/ship + the AA scrim over footage.
- **D:** migrations via `db:generate`; the **7 ops pass the coverage + auth-tier build-gates**; `set_mixtape_cues` backfills #1 post-publish, **rejects a non-member ref / a draft mutation of set+order / non-monotonic cues**; `naming-convention-linter` clean.
- **E:** the editor loads the rendition + envelope, scrubs, shows suggestions, hand-picks in/out, frames the crop, and creates **several clips in a session** (each → a row + a queued cut); `canon-reviewer` + a11y pass; warm-neutral waveform verified ≥3:1; typecheck/build/lint green.
- **F:** `/log/<mixtapeLogId>` plays the set video (range-streamed, faststart). _(Shipped.)_
- **G:** `/admin/clips` lists every clip, filters by mixtape + status, previews inline, and downloads a clip (with-audio + the silent variant); `delete_clip` prunes one; a **test** of the filter; built distribution-ready (the `mixtape_clip_social_posts` shape + the `status` column) without building push-to-social.
- **End-to-end:** from mixtape #1, produce **several** framed, captioned 9:16 footage clips, browse + filter them in the clip library, **download** one ready to hand-post, and its `/log` page plays the full set — no distribution layer required.

## Risks & open questions

- **Multipart upload of the ~1.5 GB rendition** must actually work over a home line (resumability, TTL) — the biggest new-infra risk; test on #1 first.
- **Centre-crop awkwardness** persists for _existing_ footage (the top-down angle); the `xOffset` framing mitigates, but the durable fix is a **portrait-aware camera setup for future sets** (content, not code).
- **The brand frame must clear AA over arbitrary footage** — a scrim is mandatory; verify on bright/busy frames.
- **Embargo:** only for pre-release backlog clipping — the rendition + the `StudioEnvelope` must be private until publish (there's no raw master on R2 to leak). The default `--set-video` runs at distribute (= publish), staging public, so this applies only if clips are built before release.
- **Multi-tempo BPM** — local per-peak estimation only; a global grid silently no-ops (validated as an acceptance criterion).
- **Render-box contention avoided** by running on rave-02, not the GPU conductor.
- **Out of scope (inherited constraint):** IG/TikTok distribution — IG 2026 AI fingerprinting mutes copyrighted audio on API Reels; the in-app post is the irreducible manual beat; when it lands it's a sibling `*_social_posts` table.
- **Doc-drift (fixed):** `docs/video-variants.md` now uses `fit=cover` to match the code (bare `crop` 400s) — corrected, so the next builder copies the right param.

## Appendix — verifications & sources

_Panel live verifications:_ CF MT caps confirmed against current docs — input ≤100 MB / ≤10 min, output ≤60 s, `time=` 0–10m, `duration=` 1–60 s, width/height 10–2000 px, `fit=cover` centre-only (bare `crop` 400s), no nested transforms, `global_fetch_strictly_public` only for Worker subrequests. `videoCrop`/`videoCropPoster`/`videoClipCrop` confirmed hardwired to `<logId>/footage.mp4` (no source param). `presign_track_video_uploads` confirmed track-scoped + footage-required. `mixtape_tracks.start_ms` + cue-sheet parser + `mixtape-chapters.ts` confirmed shipped. `analyze-audio.ts` picker kernel confirmed (composite score accurate; nudge is 400 ms, not 1 bar). The build-gate tests confirmed to read tiers reference-equal off the router; `ADMIN_ROUTE_OPS`/`EXPECTED_TIERS` shapes verified; the `list_` public-prefix heuristic confirmed. `decodeWav` confirmed whole-file (buffer+array coexist). `r2-presign.ts` confirmed single-PUT ~200 MB / 1 h.

_External (June 2026):_ [CF Stream — Transform videos](https://developers.cloudflare.com/stream/transform-videos/), [CF MT limits 2025-06-10](https://developers.cloudflare.com/changelog/post/2025-06-10-media-transformations-limits-increase/), [CF MT Workers binding 2026-03-18](https://developers.cloudflare.com/changelog/post/2026-03-18-media-transformations-workers-binding/), [web.dev rVFC](https://web.dev/requestvideoframecallback-rvfc/), [HTTP range requests](https://surma.dev/things/range-requests/), [wavesurfer peaks/spectrogram](https://wavesurfer.xyz/docs/methods), [DJ cue-point detection (arXiv 2007.08411)](https://arxiv.org/pdf/2007.08411), [ISMIR novelty tutorial](https://transactions.ismir.net/articles/10.5334/tismir.202), [Postproxy IG Reels API 2026](https://postproxy.dev/blog/instagram-reels-api-publishing-guide/), [Foxi IG Reels copyright 2026](https://www.foximusic.com/blog/instagram-reels-music-copyright-legal-guide/).
