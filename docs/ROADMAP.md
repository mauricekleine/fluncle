# Roadmap

Open ends we'll pick from when starting new work. Not a commitment or an order of operations — a living reference list. Add to it freely; move items into a PR when they get picked up.

## Now — the track enrichment pipeline (in order)

The active work: the async enrichment half of the [track lifecycle](./track-lifecycle.md). These are the next steps, **in order**. Everything below the `---` divider is unsorted.

**Built so far:**

- **Phase 1** — fast sync add + Log ID + sync metadata + the generic `fluncle admin track update`.
- **Audio analysis (Phase 2)** — built as a self-contained, zero-dependency `scripts/analyze-track.ts` inside the `fluncle-track-enrichment` skill (not the video pipeline, so it installs standalone). FFT chroma + **Krumhansl-Schmuckler key** (we compute what Spotify denies us; gated to `null` below a confidence floor), spectral features (centroid, sub-bass weight, mid-band flatness, onset rate), and a **sub-genre suggestion** normalized through `tags.ts`. Stores the raw feature vector (`features_json`) for the future classifier. Output written back via `fluncle admin track update` (bpm/key/tags as `auto`; manual tags always win).
- **Local enrichment flow + skill** — the `fluncle-track-enrichment` skill is the runbook; proven end-to-end by hand on real tracks (get → analyze → update). `fluncle track get <id|log_id> --json` (public read) and the `--features` / `--tag-source auto|manual` plumbing on `track update` ship the loop.

1. **Enrichment-analysis agent on Spinup — buildable now.** The Worker `ctx.waitUntil`s a call to the Spinup runtime API with the track ID / Log ID (fire-and-forget; never blocks the add). The agent pulls track details via the `fluncle` CLI `--json`, resolves the Deezer preview, runs the analysis, and writes bpm/key/tags (as `auto`) back via `fluncle admin track update`. This half is light (ffmpeg + JS DSP) and fits Spinup's current limits (1 vCPU, 300s `/exec`). **Repo access is solved for this half:** the analysis is a self-contained skill (zero npm deps, no Fluncle imports) installable via `npx skills add <subtree>` — no repo checkout needed. What's left: **ffmpeg pinned** in the rootfs, the `fluncle` CLI installed, and the agent's admin token in Cloudflare + `.dev.vars`. Ships the audio-derived data autonomously.

2. **Video render — needs a render-capable Spinup profile.** Software-GL (SwiftShader) is viable: benchmarked locally at **~45s per 20s clip in software vs ~30s on Metal** (≈1.45×, `concurrency: 1`), so **no GPU is required** — the real cost is per-vCPU speed, not the GL path. Needs a render rootfs (Chromium + SwiftShader/Mesa/NSS/GBM/fonts + ffmpeg), likely **more than 1 vCPU**, and a confirm against the per-run cap (300s today; raise the tier if a real on-Spinup render runs long). **Open question — repo/kit access (render half only):** unlike the analysis skill, the render needs the `packages/video` kit present, and Spinup has no file persistence — so how does the agent get it (fresh checkout per run? a prebuilt image? a published package?). Then it renders **two** cuts (one with audio for review, one without for TikTok) and **uploads via a new admin endpoint** (e.g. `POST /api/admin/tracks/:id/video`) — **the agent never holds R2 credentials; the Worker owns R2** and sets `video_url`.

3. **TikTok draft.** Once the video exists: submit a draft (audio-less cut + caption with analysis-derived hashtags, `#dnb`, and the canonical `fluncle://<log_id>` marker) via the TikTok Content Posting API — no music attached, no publish. Write any draft/post reference back via `track update`. **Open question:** the public post URL may only exist _after_ publishing, so `track update` stays the path to set it later.

4. **Show the video on the web.** Surface the R2 video as the track's preview (Through-the-Glass / One Pane); show a "processing" state in the recovered-telemetry register until `enrichment_status` is `done`. A missing video degrades to today's layout.

5. **Later — the small classifier.** Train it on the accumulated `manual`-labeled tags ({audio features → sub-genre}) — the `features_json` vectors are already being stored for exactly this. Gloriously, unnecessarily fun; that's the point.

---

_Unsorted below — bigger arcs and reference detail. The build sequencing lives in **Now** above._

## Newsletter agent (Spinup) — not yet live

The Friday newsletter agent ([docs/newsletter-agent.md](./newsletter-agent.md)) exists on Spinup — the "Fluncle's Newsletter" agent the enrichment agent was modelled on — but is **stopped and not fully configured**. To bring it live: enable its capabilities (the `loops` + `firecrawl` CLIs) with their secrets bound, confirm the core instructions, and wire a **schedule** so it runs each Friday. It reads the discovery window from `/api/tracks` and sends via Loops. Dry-run one issue end-to-end before letting it send. Until then, no Friday send happens from the agent.

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
- **Identifier design — built.** The Log ID shipped as `sector.orbit.mark` (e.g. `007.8.1B`): days since the Fluncle epoch (2026-05-30) + a deterministic hash of the recording's ISRC. Permanent, stored, and surfaced across web/CLI/SSH/video (`log-id.ts`; [track-lifecycle.md](./track-lifecycle.md)). The spine exists — what's left in this section is the _surfaces_ it unlocks (below) and the co-equal canon reframe.
- **New surfaces it implies:** `/log/<id>` pages on the web (the log as the object: observation, recovered artifact, related logs), RSS as the observation feed, and possibly Discord. The website becomes an archive you browse, not only a feed you scroll.

**The canon surgery (codebase + canon still arbitrate the words).** A co-equal reframe edits the canon; it does not let the brief overrule it. When this is picked up:

- **PRODUCT.md** — evolve the thesis so the log/observation is a primary object and the banger is its artifact, while keeping publishing operator-controlled, music-first, and Fluncle's Findings intact. The journey and the music are co-equal, not one over the other.
- **VOICE.md** — formalize the logbook register as the deep end of the existing **Depth Gradient**: SSH / the archive / RSS speak as a "recovered terminal from a research vessel" (exploratory, scientific, a little lonely), while the warm bruv uncle still holds the surface (web, Telegram, email). Metabolize the brief's vocabulary through the existing ban list: **"transmission" and "signal" stay out**; adopt **log, observation, discovery, archive, recovered, artifact, sector**. "Banger" stays the primary word — the log frames the banger, never demotes it.
- **DESIGN.md** — a log page and archive view as new panes on the cosmos (Through-the-Glass, One Pane still apply); the identifier rendered as a typographic object (Oxanium, tabular, the instrument-panel calm).

## Brand & web

- **Website overhaul from the moodboard.** Revisit fluncle.com against `packages/video/moodboard/MOODBOARD.md` — the texture families, the Retint Rule, the first-party collages, the One-Sun stage-light grammar. The video kit has pushed the visual language well past where the web currently sits; pull the web up to match (within DESIGN.md's rules — this is evolution, not a second system).
- **Audit moodboard → canon docs.** Review whether anything proven out in the moodboard and the video kit (texture families, the Retint Rule, vehicle grammar, the One-Sun-through-the-vehicle clarification) should be promoted into [DESIGN.md](../DESIGN.md), [PRODUCT.md](../PRODUCT.md), or [VOICE.md](../VOICE.md) — or stay video-local. The risk to weigh: keeping doctrine in one place vs. bloating the canon with things only the video surface needs. Decide per concept; cross-link rather than duplicate.
  - **Includes the logbook reframe.** The co-equal reframe above is the heaviest canon decision on the list: PRODUCT.md gains a co-primary "log/observation" thesis, VOICE.md formalizes the logbook register as the deep end of the Depth Gradient (and re-skins the narrative brief's vocabulary through the ban list — "transmission"/"signal" out, log/observation/discovery/archive/sector in), and DESIGN.md gains the log-page/archive panes. Resolve these as part of this audit, not piecemeal per feature.
