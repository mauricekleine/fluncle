# RFC: Clip an unpublished set — decoupling the clip pipeline from _published_ mixtapes

Status: Shipped
Owner: Fluncle
Catalyst: an operator recorded a set they don't want to publish as a mixtape, but wants to salvage filmed tidbits into Instagram clips. Today, clipping requires publishing a mixtape.

Shipped across three waves: #239 (the `recordings` table + nullable `recording_id` + the `019.F.1A` backfill), #240 (the recordings data layer + oRPC + CLI + the recording-based clip pipeline), and #<this PR> (the admin UI — the `/admin/studio/<recordingId>` re-key, the net-new cue-authoring editor, the `/admin/clips` grouping + recordings index — and docs).

## Outcome

Let the Clip Studio + clip engine cut clips (with the changing on-screen Track-ID) from a captured set **without publishing it**, and publish it later — reusing the already-staged video, no re-upload.

## The decision that shapes everything (resolve first)

The RFC Forge panel refuted the original "new `recording` table" design as over-built and surfaced one real fork. **This is the operator's call and it picks the design:**

> **Will you regularly clip sets you will _never_ publish** (a population of practice sets, livestream VODs, B-roll that must never carry mixtape/spine semantics)?

- **No / rarely** (a staged set almost always becomes a published mixtape) → **Design A (recommended): the _unpublished mixtape_.** Far less code; reuses the entire cue-rail/Studio/clip machinery; clips keep their `fluncle://` coordinate from day one.
- **Yes, a real population** → **Design B: the separate `recording` primitive** (below, corrected for every panel defect). Its one advantage: it does **not** burn a scarce Log-ID coordinate on a set you'll never publish.

**RESOLVED → Design B** (operator decision, 2026-07-01). The operator's constraint is decisive and overrides the code-size argument: **mixtape coordinates are exclusively for full, finished, published mixtapes — a coordinate must never be minted for an individual clip or an unpublished set.** Design A mints the coordinate at stage-for-clipping time, which violates that rule outright. Design B keeps the recording coordinate-less; only `promote` (→ a full published mixtape) ever mints one. Clips from an un-promoted recording therefore carry **no** `fluncle://` line — they point home to `fluncle.com`, which is correct for a set with no published spine entry (not the regression the panel feared — under this constraint it is the intended behavior). **The build follows Design B below (corrected for every panel defect, same public bucket / accept-obscurity).** Design A is retained only as the rejected alternative.

## Why the reframe holds (what the research proved)

The coupling the original draft set out to break is _thin_, and every piece of it already models the "not yet public" case:

- **The only clip↔set link is `mixtape_clips.mixtape_id`** — one plain text column, no FK (`apps/web/src/db/schema.ts:722-740`). Clips are already mixtape-keyed; `019.F.1A` is already a mixtape. **No table, no `recording_id`, no rename, no backfill needed.**
- **The Track-ID render axis is already source-agnostic.** `resolveClipTracks` + `ClipTrackInput` (`packages/contracts/src/util.ts:203-271`) take `{ artists, title, startMs? }`; `clipCutFilterComplex` (`apps/cli/src/commands/clips.ts:254-370`) takes a video URL + members + title + logId. No mixtape reach-in.
- **A minted-but-non-public mixtape already exists as a state.** `distribute` mints into a `distributing` status that "the cover renders, public surfaces stay hidden" (the mixtapes skill); drafts have no resolvable coordinate. The "don't leak an unpublished set into the feed / RSS / sitemap" machinery is built and exercised.
- **The cue rail already writes cues** to `mixtape_tracks.start_ms` via `update_mixtape_cue` (operator, non-draft-gated), and the Track-ID overlay consumes exactly that shape.

So "clip a set you haven't published" = "let a mixtape be minted + set-video-staged + clippable while it sits in a non-public status, and distribute it later." No new object beneath the mixtape — a new _status_ on it.

## Design A — the unpublished mixtape (recommended)

### A.1 Schema

One enum value. `mixtapes.status` today is `["draft","distributing","published"]` (`schema.ts:618`). Add **`"staged"`**: minted (has a `logId` + set video), clippable, **not public, not distributed**. Distinct from `distributing` (which means "distribution in flight"). Generated via `bun run --cwd apps/web db:generate` (it's a CHECK-constraint/enum widening — pure DDL, no data change, no backfill). No new columns: the set video stays at the derived `<logId>/set.mp4`, clips stay keyed by `mixtape_id`.

### A.2 The one new capability: mint + stage without distributing

Today the coordinate is minted _inside_ `distribute`. Add a path that mints into `staged` and stages the set video, with **no** YouTube/Mixcloud legs:

- **CLI:** `fluncle admin mixtapes stage <idOrLogId> --video <set>.mov` — mints the draft's reserved coordinate into `status="staged"` (reusing the existing mint path in `publishMixtape`/the distribute mint), then stages the 1080p set-video rendition to `<logId>/set.mp4` via the **existing** multipart presign machinery (`stageSetVideo` / `presign_set_video_upload`, `apps/cli/src/commands/mixtape-set-video.ts`), and flips `setVideoAt`. This is `distribute --set-video` minus the platform legs and minting into `staged` instead of `distributing`.
- **oRPC:** reuse `presign_set_video_upload` (operator) unchanged; the mint-into-staged is a small addition to the mixtape mint path (a `targetStatus` parameter, defaulting to today's behavior). No new verb.

Coordinate is minted here (committed when you stage-for-clipping). Clips therefore carry `fluncle://<logId>` from day one — the AEO breadcrumb, intact.

### A.3 Clip + Studio + cue rail: reuse as-is

- **Clips:** created + cut exactly as today (keyed by `mixtape_id`); the cut reads `setVideoUrl(mixtape.logId)` and `mixtape.members`/`durationMs`/`title`. **Zero change** — a `staged` mixtape has all of these.
- **The gate widening:** two predicates that today check `draft`/published state must accept `staged`:
  - the clip cut's `setVideoAt` gate already passes (staged sets it) — no change;
  - the cue rail / `update_mixtape_cue` gate is "non-draft" (`assertDraftMixtape`'s inverse) — `staged` is non-draft, so it already passes; verify `setMixtapeCue` (`mixtapes.ts:500-573`) doesn't hard-check `distributing|published`.
- **Studio route:** `/admin/studio/<logId>` works unchanged — a `staged` mixtape has a `logId`, a cover, an energy envelope at `<logId>/studio-envelope.json`, and a set video. **This is the big win over Design B: no poster/envelope gaps, no route re-key.**
- **`ResyncFromCues`** already `return null`s until published — correct for `staged`.

### A.4 Publish later (no copy, no promote verb)

"Publish the full thing" = the **existing** `distribute` (YouTube + Mixcloud) + `publish-youtube`. The set video is _already_ at `<logId>/set.mp4`, so distribute's `--set-video` is a no-op (or skipped). Status flows `staged → distributing → published` through the existing code. No R2 copy, no cross-bucket anything, no new verb, no clip breakage (clips never moved).

### A.5 Privacy

The set video sits at `<logId>/set.mp4` in the public `fluncle-videos` bucket, but a `staged` mixtape's `logId` is **published nowhere** (no `/log`, feed, sitemap, or llms.txt entry until `published`), so the key is as unguessable as a UUID until you choose to go public — at which point the video is _meant_ to be public. This matches the accepted repo posture (`observation.json`, covers, envelopes already sit fetchable-by-key at derivable logIds). **No private bucket, no presigned reads.**

### A.6 Shelve / discard

- Keep it: the `staged` mixtape sits clippable indefinitely (coordinate held).
- Reclaim the coordinate: `delete_mixtape` on a `staged` row (cascade its clips) frees nothing automatically — the sequence counter doesn't roll back — so a deleted staged coordinate is simply skipped. Document that staging commits a coordinate; at 54 total this is comfortable, and it's the price of clips-with-breadcrumbs.

### A.7 Units (complete delivery)

1. **Status + gates** — add `"staged"` to the enum (generated migration); widen the mint path with a `targetStatus`; confirm the cue + cut gates accept `staged`. Tests: a staged mixtape is non-public (absent from feed/sitemap/llms.txt/`/mixtapes`), cue write + clip create/cut succeed on it.
2. **`stage` command + mint-into-staged** — the CLI `admin mixtapes stage --video`, reusing `stageSetVideo` + the mint; oRPC `targetStatus` param; coverage/auth tests updated (no new op paths → minimal delta). Tests: stage mints the reserved coordinate, stages `<logId>/set.mp4`, flips `setVideoAt`, leaves status `staged`.
3. **Publish transition** — `distribute` on a `staged` mixtape skips re-staging the set video and flows to `published`. Test: staged → distribute → published, set video untouched, `/log` lights up.
4. **Docs** — the mixtapes skill (the stage-then-clip-then-publish flow), `docs/fluncle-studio.md` (clip a staged set).

### A.8 Definition of done (A)

Stage tonight's set → it's non-public everywhere → clip it in the Studio with the changing Track-ID **and** the `fluncle://032.F.1B` coordinate → the clip lands, nothing on `/log`. Later, `distribute` → `/log/032.F.1B` goes live, the same clips still valid, no re-upload. Mixtape #1 untouched. All checks green (`typecheck`, strict `lint`, `apps/web`+`apps/cli` tests, `build`); the three coverage nets stay green.

## Design B — the separate `recording` primitive (SHIPPED)

Built because the fork answer is "yes." It avoids committing a coordinate to never-published sets, at the cost of materially more code and clips that carry no specific coordinate (they point home to `fluncle.com`) until promoted. The original draft's B, **corrected for every panel defect**:

- **Schema: ADD, never rename** (staff-eng D1, clip-domain D1). `ALTER TABLE mixtape_clips ADD COLUMN recording_id text` (nullable) **beside** `mixtape_id`; the cut prefers `recording_id`, falls back through `mixtape_id → mixtape → logId`; drop `mixtape_id` only in a **later** migration after prod is confirmed backfilled. (`drizzle-kit` rename detection is interactive → unusable here, and risks DROP+ADD data loss.)
- **`recordings` table:** `id` (`randomUUID()`), `title`, `recordedAt`, `r2Key` (owned), `durationMs`, `tracklistJson`, timestamps. Cues as **`[{ id, artists, title, startMs }]`** — not `{startMs,label}` (clip-domain D2): the `id` is the cue `ref` for `set_recording_cue`, `{artists,title}` feeds `resolveClipTracks` with genuinely zero change and lets promotion seed `mixtape_tracks` with no em-dash re-splitting.
- **Same bucket, accept-obscurity** (product D2, staff D5/D7 moot): stage to `fluncle-videos/recordings/<uuid>/set.mp4` (unguessable, never listed) — **no private bucket, no presigned-GET, no cross-origin/CORS question, no dual R2 token scope.** Promotion is a **within-bucket** `CopyObject` `recordings/<uuid>/set.mp4 → <logId>/set.mp4`.
- **`CopyObject`/`DeleteObject` are NEW server-side helpers** (staff D6) — no copy/delete exists in the repo today; write them as `client.fetch(PUT, {headers:{"x-amz-copy-source": …}})` in `r2-presign.ts`'s style (server-side, no presign). R2 cross-/same-bucket copy is confirmed real; 5 GiB single-copy ceiling is safely above a ~2 GB set (assert source size).
- **`promote` is idempotent** (staff D2): **mint-or-reuse** (if the recording already links a mixtape, reuse it — never re-mint a scarce coordinate); copy (overwrite-safe); seed members; flip `setVideoAt`; repoint `r2Key`; **delete the old key LAST, best-effort, tolerating already-gone**. Re-runnable end to end.
- **Backfill 019.F.1A idempotently** (staff D4): `where recording_id is null`, skip synthesis if already linked; run once post-`db:migrate` as a committed script (CF does not run it — mind the window; keep the `mixtape_id` fallback until it lands, staff D3).
- **The cue rail is NEW UI, not reuse** (clip-domain D3): a recording starts with an empty tracklist and needs an _add-a-cue_ editor (label + mark, keyed by cue `id`); reuse only the row rendering + progress, not the mixtape data source.
- **Overlay + Studio** (clip-domain D4/D5): un-promoted clips omit the `fluncle://` line **and collapse `titleY` to `h-<SAFE_BOTTOM>-th`** (else dead space); "re-cut gains the coordinate" is **manual** (the cron only cuts `pending`). The Studio loses the poster (recording has no cover) and the energy envelope (keyed by logId) → manual in/out only, or stage a recording envelope. `promote` = `publish` is the right verb intent, but B needs a real new op; naming: `recording` collides with the `record_` verb family — settle before build.
- **Coverage:** add the new ops to `orpc-admin-coverage`, `orpc-auth-coverage`, and (only if a new verb) `orpc-naming` `APPROVED_VERBS`. `deploy:gate` runs `format:check && lint && typecheck && test`, so these gate the deploy.

B's DoD adds: standalone recording clips end-to-end (no coordinate), promote is re-runnable + copies + seeds, mixtape #1 preserved through add-column+backfill, the recordings key is not linkable from any public surface.

## Panel corrections folded (both designs)

Confirmed-correct and kept: R2 cross-/same-bucket `CopyObject` is real (staff D6); presigned-GET Range works for ffmpeg + `<video>` _if_ B ever needs a private bucket (staff D7); the coverage/naming/tier deltas are correctly located and `deploy:gate` is `format+lint+typecheck+test`, not typecheck-only (staff D8, correcting a stale team note). Rejected from the draft: the private bucket (product D2), the parallel `{startMs,label}` cue shape (clip-domain D2), "the cue rail is reuse" (clip-domain D3), "omit the coordinate" as a shipped default (product D3 — Design A keeps it; B only omits for genuinely-never-public sets).

## Decisions to resolve before handoff

1. **The fork (top of doc): populations of never-published captures?** No → Design A. Yes → Design B. _Recommendation: A._
2. **(A) Status name:** `staged` (recommended) vs `unpublished` vs `footage`.
3. **(A) Coordinate commitment:** confirm you're comfortable that staging-for-clipping commits a Log-ID coordinate (reclaimable only by not-reusing a deleted one). At 54 total, recommended yes.

## Reuse (do not rebuild)

The changing Track-ID overlay + `resolveClipTracks`, the ffmpeg clip cut + brand frame, the multipart R2 presign machinery, the mint + distribute paths, the cue rail (A reuses it wholesale; B reuses only its rendering), the IG distribution leg (clip-to-instagram RFC). This RFC — in its recommended form — is a **status value + one `stage` command**, not a new subsystem.
