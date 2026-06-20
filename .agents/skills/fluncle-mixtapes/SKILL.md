---
name: fluncle-mixtapes
description: >-
  Update, distribute, publish, and announce one of Fluncle's own DJ mixtapes end
  to end. Use whenever a new mixtape (DJ set / mix) is ready to go out, or when the
  task touches a mixtape draft, its tracklist, distribution to YouTube + Mixcloud,
  the mint-first publish lifecycle, the `F`-marked mixtape Log ID, the `/mixtapes`
  surface, a mixtape cover, the MusicBrainz DJ-mix release / Wikidata loop, or
  announcing a mixtape to the crew. Also use to pull a mixtape's ordered tracklist
  out of Rekordbox history. Triggers on "publish the mixtape", "distribute the new
  mix", "the set from last night", "get the tracklist from rekordbox", "mixtape
  #N", or a `XXX.F.ZZ` coordinate. NOT for a single finding/track (that is the
  fluncle-publish + fluncle-video skills) — a mixtape is a different object.
---

# Fluncle's Mixtapes

Use this skill to take one of Fluncle's own DJ mixtapes from a recorded set to live across the Galaxy: build the draft + tracklist, distribute the video to YouTube and the audio to Mixcloud on Fluncle's own server-side OAuth, flip it public, and announce it to the crew. One `distribute` CLI command does the heavy lifting; the rest is a short operator checklist.

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
2. Capture the assets: the audio master, the mixtape video, any teaser clips (capture clips even though the clip-of-a-mixtape pipeline isn't built — raw material you don't want to re-shoot).
3. Archive the raw assets to the operator path (R2), like a finding's analysis archive.

### B. Build the draft + tracklist

A draft is **just the operator-authored subset**: a recorded date (defaults to today), an optional dream note, and the tracklist. Duration is derived from the upload at distribute time, not entered. Build the draft in `/admin/mixtapes` (or via `fluncle admin mixtapes create`).

**Get the tracklist from Rekordbox.** Rekordbox logs the set in load order, which is the reliable signal — track identity and order. Run:

```bash
# One-time: quit Rekordbox, then cache the SQLCipher key.
uv run --with pyrekordbox python -m pyrekordbox download-key

# Then, with Rekordbox quit:
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-tracklist.py            # latest session
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-tracklist.py --list     # choose a session
uv run packages/skills/fluncle-mixtapes/scripts/rekordbox-tracklist.py --plain    # bare "Artist — Title" lines
```

The script prints the ordered `Artist — Title` list and flags `DUP` rows. **Prune the spurious rows by hand**: a track loaded during soundcheck or cued and never aired shows up as a history row just like a played one, and re-loading a track makes a second row. There is no reliable timestamp tell — Rekordbox's per-row time is the deck-LOAD time, which precedes the audible mix-in by a variable lead, so the script shows it as dim reference only and never as a cue offset. **The skill writes track order + identity, not jump-to timestamps.** If precise per-track cue points are ever wanted, capture them another way (mark them against the final video).

Feed the pruned list into the tracklist: attach each track as a **member finding** (`fluncle admin mixtapes members <idOrLogId> ...`, or the `/admin` add-to-mixtape flow). A track that isn't a finding yet gets added as a finding first. Each member links to its own `/log/<id>` — the tracklist is the breadcrumb and the AEO/SEO play (see the spine model).

### C. Distribute

```bash
fluncle admin mixtapes distribute <idOrLogId> --video <mixtape>.mp4 --audio <master>
```

Omit a flag to target one platform. The command is **mint-first**: a `draft` mints the `XXX.F.ZZ` Log ID + number + title into a non-public `distributing` state (the cover renders, public surfaces stay hidden), the uploads carry the committed Log ID, and the **first successful platform link flips it `published`** — so a public mixtape always has somewhere to listen. It is **idempotent per platform**: re-running resumes a `distributing` mixtape and reuses its Log ID.

- **YouTube** always lands **unlisted** (made public in a separate gate); title + description ending in `fluncle://<logId>` + a cued chapter block; the wide cover set best-effort as the thumbnail; resumes on a mid-upload token expiry or dropped session.
- **Mixcloud** publishes **listed/public immediately**; full-quality master, square cover, a per-track `sections[]` tracklist from members. Add `--unlisted` to keep it private (a test run, or a cautious first upload to flip by hand). **Test with real-length audio**: a full mixtape is a licensed *show*, but a short clip is classified as an unlicensed *track* and copyright-blocked. Watch the Featured-Artist / SRPC limits (see the spine model's Hosting section); observe, don't pre-lint.

Each leg records into `mixtape_social_posts` and dual-writes `mixtapes.{youtube,mixcloud}_url`.

### D. Make YouTube public

The one recurring human gate: the `/admin/mixtapes` **Make YouTube public** button, or `fluncle admin mixtapes publish-youtube <idOrLogId>` (server-side `videos.update`).

### E. Mirror + anchor (manual, optional)

- **SoundCloud** — paste the link via the editor when you have it (API registration is externally gated). The data model accepts it with no rework.
- **MusicBrainz** — add the mixtape as a DJ-mix release (Fluncle the mix artist, tracklist = the real recordings). This is what makes the MusicBrainz artist substantial.
- **Wikidata** — link the release on `Q140169844` to close the off-site loop.

### F. Announce (draft in the `copywriting-fluncle` voice)

Telegram crew channel → Friday newsletter (a mixtape inside the week's window already rides along) → website/home surfacing → a CLI/SSH line where output prints URLs.

### G. Verify

Every surface resolves `fluncle://<id>`: feed checkpoint row, `/mixtapes` index, the `/log` page, the API / RSS / MCP / CLI / SSH resolvers, the `llms.txt` Mixtapes section. Every tracklist link lands the right `/log/<id>`. The structured data validates as a `DJMixAlbum`. Watch the `/admin/mixtapes` Distribution strip; a failed leg stays retryable (re-run `distribute`).

## Limits + crash recovery

YouTube `videos.insert` is metered in the **Video Uploads bucket (~100/day)**, 256 GB / 12 h per video — a non-issue at this cadence; Content ID will claim the mix (it stays up, labels monetize). Because the Log ID is committed before upload, a crash between a successful PUT and finalize leaves a live unlisted video with the right coordinate; re-running may create a duplicate unlisted video to delete in YouTube Studio.

## Pointers

- Object model, identity, hosting/licensing, covers, lifecycle, the fan-out map, open questions: **[references/spine-model.md](references/spine-model.md)**.
- Distribution design + the mint-first reshape: `docs/rfcs/mixtape-autopublish-rfc.md` (retired planning doc, kept for the rationale).
- Voice for titles, notes, and announce copy: the `copywriting-fluncle` skill.
- Cover art iteration: the `fluncle-video` kit; backgrounds rendered by `bun run --cwd packages/media render:mixtape-bg`.
