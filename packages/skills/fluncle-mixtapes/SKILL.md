---
name: fluncle-mixtapes
description: >-
  Update, distribute, publish, and announce one of Fluncle's own DJ mixtapes end
  to end. Use whenever a new mixtape (DJ set / mix) is ready to go out, or when the
  task touches a set plan, a mixtape's tracklist, distribution to YouTube + Mixcloud,
  the mint-first publish lifecycle, the `F`-marked mixtape Log ID, the `/mixtapes`
  surface, a mixtape cover, the MusicBrainz DJ-mix release / Wikidata loop, or
  announcing a mixtape to the crew. Also use to pull a mixtape's ordered tracklist
  out of Rekordbox history. Triggers on "publish the mixtape", "distribute the new
  mix", "the set from last night", "get the tracklist from rekordbox", "mixtape
  #N", or a `XXX.F.ZZ` coordinate. NOT for a single finding/track (that is the
  fluncle-publish + fluncle-video skills) — a mixtape is a different object.
---

# Fluncle's Mixtapes

Use this skill to take one of Fluncle's own DJ mixtapes from a recorded set to live across the Galaxy: build the plan + tracklist, capture the take, promote it, distribute the video to YouTube and the audio to Mixcloud on Fluncle's own server-side OAuth, flip it public, and announce it to the crew. One `distribute` CLI command does the heavy lifting; the rest is a short operator checklist.

A mixtape is **Fluncle dreaming** — findings consolidated into one long recording, a checkpoint that closes a chapter. It is a first-class object on the Log ID spine but **not a finding**: it carries its own `F`-marked Log ID, never increments `FOUND · N`, and stays off the admin finding board. The full object model — identity, the lifecycle, hosting/licensing, covers, machine-awareness, the per-surface fan-out — lives in **[references/spine-model.md](references/spine-model.md)**. Read it once to understand the object; this file is the repeatable per-mixtape workflow. Canon (PRODUCT.md / DESIGN.md / the `copywriting-fluncle` voice) arbitrates the words and the look.

The internal plumbing is **already built and live** (tables, minting, `/log` mixtape flavor, `/mixtapes`, schema/RSS/llms.txt awareness, the admin editor, the cover endpoint, the `distribute` command). This skill operates it; it does not rebuild it.

## One-time setup (per Mac)

Two durable OAuth grants, stored **server-side** so the CLI stays a thin client:

- `fluncle admin auth youtube` — opens Google's consent screen; the refresh token is stored in `youtube_auth`. **At the consent screen pick the `@fluncle` channel (a Brand Account), not a personal Google account** — the wrong identity fails the upload with `youtubeSignupRequired`. The `@fluncle` channel must be phone-verified (done) or uploads over 15 min fail at insert.
- `fluncle admin auth mixcloud` — prints a Mixcloud authorize URL; approve, and the callback exchanges the code into `mixcloud_auth`. The CLI fetches this token just-in-time at upload (only the bytes are CLI-side). Re-run if a later upload reports an invalid token. Secrets live on Cloudflare (`MIXCLOUD_CLIENT_ID/SECRET`; the redirect is derived from the request origin, no var).

For the Rekordbox tracklist step, also cache the database key once (see that step).

## The per-mixtape runbook

### A. Record + archive

1. Record the set.
2. Capture the assets: the audio master, the mixtape video, any teaser clips (raw material you don't want to re-shoot — and the Fluncle Studio clip pipeline can cut more later from a **recording**'s set video on R2: the `recordings` table + `mixtape_clips`, `fluncle admin recordings …` + `fluncle admin clips list|cut`, `/admin/studio/<recordingId>` + `/admin/clips`, the `fluncle-studio-clip` cron; see `docs/fluncle-studio.md`).
3. Archive the raw assets to the operator path (R2), like a finding's analysis archive.

> **The one publish path (RFC plan→recording→mixtape §7 / Wave 3-D).** Every mixtape goes through a recording: upload the set as a recording, promote it (mints the coordinate + stages the set video), then distribute. The clip-first path is:
>
> 1. `fluncle admin recordings create --title "…" --video <set>.mov` — creates a coordinate-less recording and stages the set video to its own R2 key.
> 2. Clip it in the Studio at `/admin/studio/<recordingId>` — author the cue tracklist (add each track, mark it at the playhead) and cut framed 9:16 clips. They land in `/admin/clips` grouped under the recording. Un-promoted, a clip points home to `fluncle.com` (no `fluncle://` coordinate — coordinates are for published mixtapes only).
> 3. When ready to publish: `fluncle admin recordings promote <recordingId>` → then `distribute` (§C). Promote is idempotent (mint-or-reuse): it mints the mixtape from the recording (seeding its tracklist), copies the set video to `<logId>/set.mp4`, and flips `setVideoAt`. The recording's existing clips keep working; re-cut a clip to gain the new `fluncle://<logId>` coordinate.

**Audio — Track 1 is the clean master.** The OBS recording carries two audio tracks (Advanced Output records tracks 1 + 2): **Track 1 = the clean stereo mix only** (BlackHole / PC MASTER OUT, no mic — the file's default audio), **Track 2 = the isolated mic**. (A third track, mix + mic, feeds the Twitch stream but isn't recorded.) Always take the **clean Track 1** for the Mixcloud audio master and for any clip audio — it's the default stream, so `-map 0:a:0` (or no `-map` at all); Track 2 is the voice-only mic. The recording is 1080p H.264 (OBS Output (Scaled) Resolution must be 1920×1080, not 720p; keep H.264 so the clip pipeline / Cloudflare Media Transformations can read it; the master encoder is a dedicated Apple VT H264 Hardware encoder at CBR 40000, not "Use stream encoder"). Full OBS / BlackHole recording setup lives in `docs/mixtape-recording-setup.md`.

### B. Build the plan + tracklist

Pre-publish authoring is a **PLAN** — a videoless `recordings` row, not a mixtape (draft mixtapes retired; a mixtape is only ever born via `promote_recording`). A plan is just the lined-up findings plus an optional live-session date. Duration is derived from the upload at distribute time, not entered. Build the plan in `/admin/plans` (via `fluncle admin recordings create --plan`, or `kind: "plan"` on `create_recording`); the board's Mixtape cell also pencils a single finding straight into a plan ("Add to a plan").

**The handle replaces the reserved coordinate.** The plan carries an auto-minted **Galaxy-vocab handle** (e.g. `liquid-nebula-roller`) — the fixed label you name your Beatport playlist, USB folders, and Rekordbox crate with up front. Unlike the old date-derived reserved Log ID, it never drifts; the real `XXX.F.ZZ` coordinate is minted only at promote. The dream note and recorded date live on the PUBLISHED mixtape (the post-promote edit), not on the plan.

**Derive the take's cue tracklist from Rekordbox automatically.** After recording a take, run `rekordbox-derive-cues.py` to read the session history, match each track against the Fluncle catalogue, and write the ordered cue array directly to the take's `recording_cues` via `replace-cues`. This replaces the "feed the pruned list by hand" step entirely.

```bash
# One-time: quit Rekordbox, then cache the SQLCipher key.
uv run --with pyrekordbox python -m pyrekordbox download-key

# Dry-run: see the proposed cues (matched / unmatched / flagged) without writing anything.
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-derive-cues.py            # latest session
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-derive-cues.py --list     # choose a session
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-derive-cues.py --session "2026-07" --json

# Write the cues to the take once happy with the dry-run output:
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-derive-cues.py --apply <takeRecordingId>
```

The script reads the Rekordbox session in `TrackNo` order (the reliable DJ-load order) and matches each row to a Fluncle finding by normalized title+artist — the same matcher the key-backfill uses (`_fold` / `_normalize_artists` / `_split_title` / `match_key`). Three buckets: **matched** (exactly 1 finding → `findingId` set), **ambiguous** (>1 candidates → flagged, `findingId=null`), **unmatched** (no candidate → flagged, `findingId=null`). **Consecutive same-identity rows are automatically pruned** (a re-load); non-consecutive repeats are kept but flagged. `startMs` is left absent on every cue — mark each mix-in on the Studio cue rail (`C`/`X`/↑/↓ loop).

The older `rekordbox-tracklist.py` (prints a plain `Artist — Title` list for manual use) is still present and useful for a quick read-only session review; it is not the write path.

**After the cue write, attach each unmatched track as a finding** (`fluncle add <spotifyUrl>` or the `/admin` add flow) and re-run with `--apply` to fill in the remaining `findingId=null` slots. A finding that isn't in the catalogue yet is never auto-created — stay honest, add it first. Each linked finding gets its own `/log/<id>` breadcrumb in the published mixtape tracklist (the AEO/SEO play; see the spine model).

### B2. Export a plan to tools (Rekordbox playlist + Beatport + m3u8)

Once a plan recording has its cues (see §B above), export them to every tool you need before recording:

```bash
# Dry-run output: Beatport links + m3u8 + checklist, and the XML safe-fallback.
# Rekordbox must be QUIT before running — the script writes to the encrypted master.db.
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-plan-export.py <planId>

# Skip the direct DB write (text exports only — safe to run with Rekordbox open):
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-plan-export.py <planId> --no-db-write

# Skip the confirmation prompt:
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-plan-export.py <planId> --yes

# Custom XML output path:
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-plan-export.py <planId> --xml my-plan.xml
```

The script does five things in one pass:

1. **Rekordbox playlist (direct DB write — the star).** Matches each plan cue to the operator's collection by normalized title+artist (the same matcher as the derivation script), creates a playlist named with the plan's Galaxy-vocab slug inside a "Fluncle Plans" folder, adds matched tracks in cue order, and commits. Backs up `master.db` to `master.db.bak-<timestamp>` before writing. Unmatched cues are skipped with a warning; the operator can buy them on Beatport first and re-export.
2. **Rekordbox XML (`<slug>.xml`).** A safe no-write fallback the operator can import into Rekordbox via File → Import Playlist without touching the encrypted DB. Always emitted.
3. **Beatport search links.** One `beatport.com/search?q=…` URL per cue — click to buy. No open add-to-cart API (partner-gated).
4. **m3u8.** An ordered reference list (metadata only, no local file paths).
5. **Checklist.** Plain numbered `Artist — Title` list; paste into Rekordbox USB folder names, Beatport cart, or a note.

**Safety:** the script prints a clear instruction to quit Rekordbox before asking for confirmation; `--yes` / `-y` skips the prompt. `--no-db-write` skips the DB write entirely and only emits the text formats — safe to run with Rekordbox open. The XML export (step 2) never touches `master.db` regardless. If pyrekordbox can't open the DB (wrong key, running Rekordbox), the script falls back to text-only output.

### C. Promote the recording, then distribute

The unified publish path (RFC plan→recording→mixtape §7 / Wave 3-D) is:

**1. Promote the recording** — this mints the coordinate AND stages the set video:

```bash
fluncle admin recordings promote <recordingId>
```

`promote` is **idempotent** (mint-or-reuse): it mints the `XXX.F.ZZ` Log ID, copies the set-video rendition from `recordings/<id>/set.mp4` to `<logId>/set.mp4`, and flips `setVideoAt` so the `/log` player + video SEO light up. The mixtape is now in `distributing` state (coordinate committed, public surfaces stay hidden until a platform link lands).

**2. Distribute** — push the promoted mixtape to platforms:

```bash
fluncle admin mixtapes distribute <idOrLogId> --video <mixtape>.mp4 --audio <master>
```

`distribute` is **push-only**: it operates on an already-minted (`distributing` or `published`) mixtape and errors when the coordinate hasn't been minted (promote the recording first). The `--audio <master>` must be the **clean mix (Track 1, no mic)** — extract it from the OBS `.mov` first: `ffmpeg -i <recording>.mov -map 0:a:0 -c:a libmp3lame -b:a 320k <master>.mp3` (Track 2 is the isolated mic — see §A). The `--video` can be the raw `.mov` or a clean-audio cut — your call on whether the YouTube video carries your voice.

Omit a flag to target one platform. The **first successful platform link flips it `published`** — so a public mixtape always has somewhere to listen. It is **idempotent per platform**: re-running a `distributing` or `published` mixtape reuses its Log ID.

- **YouTube** always lands **unlisted** (made public in a separate gate); title + description ending in `fluncle://<logId>` + a cued chapter block; the wide cover set best-effort as the thumbnail; resumes on a mid-upload token expiry or dropped session.
- **Mixcloud** publishes **listed/public immediately**; full-quality master, square cover, a per-track `sections[]` tracklist from members. Add `--unlisted` to keep it private (a test run, or a cautious first upload to flip by hand). **Test with real-length audio**: a full mixtape is a licensed _show_, but a short clip is classified as an unlicensed _track_ and copyright-blocked. Watch the Featured-Artist / SRPC limits (see the spine model's Hosting section); observe, don't pre-lint.

Each leg records into `mixtape_social_posts` — the single source of truth for a mixtape's listen links. The public `externalUrls` (mixcloud/youtube/soundcloud) derives from the `published` rows there; there are no `mixtapes.*_url` columns. SoundCloud has no `distribute` leg — set it manually from the admin editor (it too becomes a `mixtape_social_posts` row).

**Set video on `/log`** is automatic via `promote`. Once promoted, the mixtape `/log/<logId>` page shows the set video as the hero (replacing the cover) and it is crawled/indexed (a `<video:video>` sitemap entry + a VideoObject + og:video). No extra flag needed.

> **Retired flags (Wave 3-D):** `distribute --set-video` and the `draft`-to-`distributing` mint that `distribute` used to perform are both retired. The set video is staged by `promote`, and the coordinate is minted there too. There is now one publish path: record → upload as a recording → promote → distribute.

### D. Make YouTube public

The one recurring human gate: the Studio's **Make YouTube public** button (`/admin/studio/<recordingId>`, in the Live distribution block), or `fluncle admin mixtapes publish-youtube <idOrLogId>` (server-side `videos.update`).

### D2. Re-sync cues → live YouTube chapters + Mixcloud sections

The tracklist cues are often refined **after** a set is already live (the initial upload rarely has precise jump points — see the Rekordbox note in §B, which writes order + identity, not timestamps). Once you mark or change cues on a **published** mixtape, re-push the derived metadata to the platforms **without re-uploading the audio**. Two equivalent entry points hit the **same server-side ops**:

- **Fluncle Studio button** — author cues on the recording's `/admin/studio/<recordingId>` cue editor (a promoted mixtape's set is its recording's Studio), then hit **Re-sync from cues** (in the left pane's "Live distribution" block, shown only once the recording is promoted). It fires **both** platform ops the set is distributed to, confirm-gated (it edits live public content), with a ✓ / error per platform. It only appears once the set is published and enables once there's ≥1 cue.
- **CLI**:

```bash
# Mark/adjust cues first on the Fluncle Studio cue rail (the `set_mixtape_cues` /
# `update_mixtape_cue` ops — the old `mixtapes members` draft command retired):
# …then re-sync the derived metadata to the live platforms:
fluncle admin mixtapes resync <idOrLogId>                    # both platforms it's distributed to
fluncle admin mixtapes resync <idOrLogId> --youtube          # only YouTube
fluncle admin mixtapes resync <idOrLogId> --mixcloud         # only Mixcloud
```

`resync` regenerates the exact same metadata `distribute` builds — the YouTube description (dream note + `fluncle://<logId>` + the cued chapter block, YouTube's ≥3-chapters/first-at-0:00/≥10s-spacing rules honored) and the Mixcloud `sections[]` — from the mixtape's **current** cues, and pushes them to the already-uploaded video + cloudcast. **Both legs are server-side ops** (`resync_mixtape_youtube` / `resync_mixtape_mixcloud`); the CLI and the Studio button are thin triggers over the one path:

- **YouTube** (`videos.list` to read the live snippet, then `videos.update` on `part=snippet`): it refreshes **only** the description; the title, category, tags, and the video itself are read back and preserved untouched.
- **Mixcloud** edits the cloudcast in place via its edit endpoint (`POST /upload/<user>/<slug>/edit/`, all upload fields except `mp3`), run **server-side** in the Worker with the stored `mixcloud_auth` token (the sections edit is bytes-free, so — unlike the multi-GB upload, which stays CLI-direct — it belongs server-side). Posting the `sections-*` fields overwrites the whole tracklist with the fresh cue set; name/description/picture are left alone.

It is **operator-only** (it edits live published content — the agent token 403s) and **idempotent** (re-run any time; the cloudcast key/url never change, so there's nothing to re-finalize). With no `--youtube`/`--mixcloud` flag it re-syncs every platform the mixtape is distributed to. SoundCloud is manual — out of scope.

### E. Mirror + anchor (manual, optional)

- **SoundCloud** — paste the link via the editor when you have it (API registration is externally gated). The data model accepts it with no rework.
- **MusicBrainz** — add the mixtape as a DJ-mix release (Fluncle the mix artist, tracklist = the real recordings). This is what makes the MusicBrainz artist substantial.
- **Wikidata** — link the release on `Q140169844` to close the off-site loop.

### F. Announce (draft in the `copywriting-fluncle` voice)

Telegram crew channel → Friday newsletter (a mixtape inside the week's window already rides along) → website/home surfacing → a CLI/SSH line where output prints URLs.

### G. Verify

Every surface resolves `fluncle://<id>`: feed checkpoint row, `/mixtapes` index, the `/log` page, the API / RSS / MCP / CLI / SSH resolvers, the `llms.txt` Mixtapes section. Every tracklist link lands the right `/log/<id>`. The structured data validates as a `DJMixAlbum`. Watch the Studio's Live distribution block (`/admin/studio/<recordingId>`); a failed leg stays retryable (re-run `distribute`).

## Limits + crash recovery

YouTube `videos.insert` is metered in the **Video Uploads bucket (~100/day)**, 256 GB / 12 h per video — a non-issue at this cadence; Content ID will claim the mix (it stays up, labels monetize). Because the Log ID is committed before upload, a crash between a successful PUT and finalize leaves a live unlisted video with the right coordinate; re-running may create a duplicate unlisted video to delete in YouTube Studio.

## Pointers

- Object model, identity, hosting/licensing, covers, lifecycle, the fan-out map, open questions: **[references/spine-model.md](references/spine-model.md)**.
- Voice for titles, notes, and announce copy: the `copywriting-fluncle` skill.
- Cover art iteration: the `fluncle-video` kit; backgrounds rendered by `bun run --cwd packages/media render:mixtape-bg`.
