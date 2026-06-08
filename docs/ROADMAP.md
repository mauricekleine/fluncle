# Roadmap

Open ends we'll pick from when starting new work. Not a commitment or an order of operations — a living reference list. Add to it freely; move items into a PR when they get picked up.

## Now — the track enrichment pipeline (in order)

The active work: the async enrichment half of the [track lifecycle](./track-lifecycle.md). Phase 1 (fast sync add + Log ID + sync metadata + the generic `fluncle admin track update`) is built. These are the next steps, **in order**. Everything below the `---` divider is unsorted.

1. **Audio analysis in the kit (Phase 2).** Add a frequency-domain pass to `packages/video/src/pipeline/analyze-audio.ts` (it's time-domain only today): musical **key** via Krumhansl-Schmuckler chroma (we compute what Spotify denies us), plus spectral features — centroid/brightness, sub-bass weight, mid-band flatness. Derive a **sub-genre suggestion** (liquid ↔ neuro ↔ jungle), normalized through `tags.ts`. Prototyped: these separate the styles on the real signal. Output feeds `fluncle admin track update` (bpm, key, tags as `auto`).

2. **Local enrichment flow + skill — prove it end-to-end by hand first.** Document the flow as a local agent runbook/skill before moving it to Spinup:
   - List requirements: keys/creds (Spotify, Deezer, the Fluncle admin token, the video-upload endpoint, TikTok).
   - The flow: `fluncle ... --json` to pull track details → fetch the preview from Deezer → run the spectro analysis → `fluncle admin track update` (bpm/key/tags) → render the video with Remotion (the `fluncle-video` skill is the instructions). Run it manually on a real track and confirm the whole chain works.

3. **Spinup agent — the async runner.** Move the proven flow onto Spinup, triggered from the add:
   - Add the agent's API key to Cloudflare + local `.dev.vars`.
   - The Worker `ctx.waitUntil`s a call to the Spinup runtime API with the track ID / Log ID (fire-and-forget; never blocks the add).
   - The agent pulls track details via the `fluncle` CLI `--json`, resolves the Deezer preview, runs the analysis, and writes bpm/key/tags back via `fluncle admin track update`.
   - **Open question — repo/kit access.** Spinup has no file persistence, so how does the agent get `packages/video` (Remotion + the kit) to render? (Fresh checkout per run? a prebuilt image with the kit + ffmpeg? a published package?) Resolve before the video step.
   - Renders the video (Remotion, needs `ffmpeg`) and **uploads it via a new admin API endpoint** (e.g. `POST /api/admin/tracks/:id/video`) — **the agent never holds R2 credentials; the Worker owns the R2 connection** and sets `video_url`. Upload **two** cuts: one with audio (operator review) and one without audio (TikTok).
   - Submits a **TikTok draft**: the audio-less video + a caption with analysis-derived hashtags, standard ones like `#dnb`, and the canonical `fluncle://<log_id>` marker. Via the TikTok Content Posting API (creds needed); no music attached, no publish.
   - Writes `video_url` (and any draft reference) back via `track update`. **Open question:** the public TikTok post URL may only exist _after_ publishing — so `track update` stays the easy path to set the post URL later.

4. **Show the video on the web.** Surface the R2 video as the track's preview (Through-the-Glass / One Pane); show a "processing" state in the recovered-telemetry register until `enrichment_status` is `done`. A missing video degrades to today's layout.

5. **Later — the small classifier.** Train it on the accumulated `manual`-labeled tags ({audio features → sub-genre}). Gloriously, unnecessarily fun; that's the point.

---

_Unsorted below — bigger arcs and reference detail. The build sequencing lives in **Now** above._

## TikTok auto-pipeline (the capstone)

The full vision: "Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com`, and the system resolves metadata, resolves a legal preview, analyzes the audio, renders a 9:16 video, writes a caption, and pushes a TikTok **draft** — fully automatic. The only human steps stay manual on purpose: attach the official TikTok sound (the pipeline suggests the start offset from the drop analysis), then publish. That keeps all music licensing inside TikTok's ecosystem — preview audio is for analysis only, never uploaded.

The **Now** section above sequences the build (analysis → video → R2-via-endpoint → TikTok draft); this section is the broader vision and the parts that come _after_ a draft exists. What it adds beyond the Now sequence:

- **Pipeline orchestration + status lifecycle.** A per-track state machine (`queued → preview_resolved → analyzed → rendering → rendered → draft_pushed → awaiting_publish → posted_verified`, plus `needs_review / stale_draft / failed`) and the `social_posts` storage to back it. Triggered from a track being added, not a manual agent run.
- **Caption + public marker generation.** Captions in Fluncle's voice (VOICE.md) with artist/track/Spotify link/hashtags; the post carries the discovery's **canonical log identifier** (see the logbook section below) as both an on-screen/caption marker and the key for publication reconciliation. This replaces the brief's bespoke `rave://7F3A` / `transmission FLN-...` markers — there is one identity per discovery, used everywhere.
- **TikTok Content Posting API integration.** A TikTok developer app, OAuth for `@fluncle`, draft upload (video + caption, no music, no publish), and the token storage that needs (`TIKTOK_CLIENT_ID/SECRET`, access + refresh tokens).
- **Reconciliation agent.** An hourly check that matches recent TikTok posts to public markers and flips `social_post.status` to `posted_verified` with the live URL — so publication state is observed, not hand-tracked.
- **Text overlays from verified facts.** Artist / track / year burned into the render (label/genre optional), reusing the video kit's facts-with-sources discipline.

Explicitly out of scope for V1 (per the brief): automatic publishing, Instagram, YouTube Shorts, performance/engagement analytics. The one human action stays: choose song, attach official sound, press publish.

## The logbook — Fluncle as a traveler's archive

The largest item, the one the others point at. The full vision: Fluncle is a cosmonaut keeping a logbook; every discovery is a **log entry** with a permanent, surface-independent identity; the banger is the artifact attached to an observation. **Chosen direction: a co-equal reframe** — the log becomes as central as the music, not a cosmetic layer. That means real canon surgery (PRODUCT.md, VOICE.md, DESIGN.md all get edits), not a bolt-on. The music-first product and the warm uncle don't get deleted; they get a second, equally-weighted axis — the journey — built alongside them.

**The spine — one canonical identifier per discovery.** The load-bearing primitive: `fluncle://<id>` is the true identity of a discovery, and every surface is just a representation of it.

```
fluncle://241.7.3A
  ├─ https://fluncle.com/log/241.7.3A     (web: a log page, not a row)
  ├─ on-screen overlay + caption           (TikTok)
  ├─ <guid>fluncle://241.7.3A</guid>       (RSS: the observation feed)
  ├─ fluncle log 241.7.3A                  (CLI)
  ├─ ssh rave.fluncle.com 241.7.3A         (SSH: the recovered terminal)
  └─ social_post reconciliation key        (TikTok pipeline, above)
```

- This **subsumes the TikTok capstone's marker** — there is one identity per discovery, doing the trail and the reconciliation at once. No separate `rave://` scheme.
- **Identifier design.** Derive it deterministically from real facts (e.g. discovery date + a sequence + a check character) so it reads "recovered, not generated" but stays reconstructable and reconcilable — better than a random code, and the date/coordinate/stardate ambiguity comes for free. Opaque to users, meaningful to the system. The exact `241.7.3A` shape and what it encodes is a design decision to settle when picked up.
- **New surfaces it implies:** `/log/<id>` pages on the web (the log as the object: observation, recovered artifact, related logs), RSS as the observation feed, and possibly Discord. The website becomes an archive you browse, not only a feed you scroll.

**The canon surgery (codebase + canon still arbitrate the words).** A co-equal reframe edits the canon; it does not let the brief overrule it. When this is picked up:

- **PRODUCT.md** — evolve the thesis so the log/observation is a primary object and the banger is its artifact, while keeping publishing operator-controlled, music-first, and Fluncle's Findings intact. The journey and the music are co-equal, not one over the other.
- **VOICE.md** — formalize the logbook register as the deep end of the existing **Depth Gradient**: SSH / the archive / RSS speak as a "recovered terminal from a research vessel" (exploratory, scientific, a little lonely), while the warm bruv uncle still holds the surface (web, Telegram, email). Metabolize the brief's vocabulary through the existing ban list: **"transmission" and "signal" stay out**; adopt **log, observation, discovery, archive, recovered, artifact, sector**. "Banger" stays the primary word — the log frames the banger, never demotes it.
- **DESIGN.md** — a log page and archive view as new panes on the cosmos (Through-the-Glass, One Pane still apply); the identifier rendered as a typographic object (Oxanium, tabular, the instrument-panel calm).

## Brand & web

- **Website overhaul from the moodboard.** Revisit fluncle.com against `packages/video/moodboard/MOODBOARD.md` — the texture families, the Retint Rule, the first-party collages, the One-Sun stage-light grammar. The video kit has pushed the visual language well past where the web currently sits; pull the web up to match (within DESIGN.md's rules — this is evolution, not a second system).
- **Audit moodboard → canon docs.** Review whether anything proven out in the moodboard and the video kit (texture families, the Retint Rule, vehicle grammar, the One-Sun-through-the-vehicle clarification) should be promoted into [DESIGN.md](../DESIGN.md), [PRODUCT.md](../PRODUCT.md), or [VOICE.md](../VOICE.md) — or stay video-local. The risk to weigh: keeping doctrine in one place vs. bloating the canon with things only the video surface needs. Decide per concept; cross-link rather than duplicate.
  - **Includes the logbook reframe.** The co-equal reframe above is the heaviest canon decision on the list: PRODUCT.md gains a co-primary "log/observation" thesis, VOICE.md formalizes the logbook register as the deep end of the Depth Gradient (and re-skins the narrative brief's vocabulary through the ban list — "transmission"/"signal" out, log/observation/discovery/archive/sector in), and DESIGN.md gains the log-page/archive panes. Resolve these as part of this audit, not piecemeal per feature.
