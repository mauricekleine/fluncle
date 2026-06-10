# Roadmap

Open ends we'll pick from when starting new work. Not a commitment or an order of operations — a living reference list. Add to it freely; move items into a PR when they get picked up.

## Now — the track enrichment pipeline (in order)

The active work: the async enrichment half of the [track lifecycle](./track-lifecycle.md). These are the next steps, **in order**. Everything below the `---` divider is unsorted.

**Built so far:**

- **Phase 1** — fast sync add + Log ID + sync metadata + the generic `fluncle admin track update`.
- **Audio analysis (Phase 2)** — built as a self-contained, zero-dependency `scripts/analyze-track.ts` inside the `fluncle-track-enrichment` skill (not the video pipeline, so it installs standalone). FFT chroma + **Krumhansl-Schmuckler key** (we compute what Spotify denies us; gated to `null` below a confidence floor), spectral features (centroid, sub-bass weight, mid-band flatness, onset rate), and a **sub-genre suggestion** normalized through `tags.ts`. Stores the raw feature vector (`features_json`) for the future classifier. Output written back via `fluncle admin track update` (bpm/key/tags as `auto`; manual tags always win).
- **Local enrichment flow + skill** — the `fluncle-track-enrichment` skill is the runbook; proven end-to-end by hand on real tracks (get → analyze → update). `fluncle track get <id|log_id> --json` (public read) and the `--features` / `--tag-source auto|manual` plumbing on `track update` ship the loop.

1. **Enrichment-analysis agent on Spinup — buildable now.** The Worker `ctx.waitUntil`s a call to the Spinup runtime API with the track ID / Log ID (fire-and-forget; never blocks the add). The agent pulls track details via the `fluncle` CLI `--json`, resolves the Deezer preview, runs the analysis, and writes bpm/key/tags (as `auto`) back via `fluncle admin track update`. This half is light (ffmpeg + JS DSP) and fits Spinup's current limits (1 vCPU, 300s `/exec`). **Repo access is solved for this half:** the analysis is a self-contained skill (zero npm deps, no Fluncle imports) installable via `npx skills add <subtree>` — no repo checkout needed. What's left: **ffmpeg pinned** in the rootfs, the `fluncle` CLI installed, and the agent's admin token in Cloudflare + `.dev.vars`. Ships the audio-derived data autonomously.

2. **Video render — needs a render-capable Spinup profile.** Software-GL (SwiftShader) is viable: benchmarked locally at **~45s per 20s clip in software vs ~30s on Metal** (≈1.45×, `concurrency: 1`), so **no GPU is required** — the real cost is per-vCPU speed, not the GL path. Needs a render rootfs (Chromium + SwiftShader/Mesa/NSS/GBM/fonts + ffmpeg), likely **more than 1 vCPU**, and a confirm against the per-run cap (300s today; raise the tier if a real on-Spinup render runs long). **Open question — repo/kit access (render half only):** unlike the analysis skill, the render needs the `packages/video` kit present, and Spinup has no file persistence — so how does the agent get it (fresh checkout per run? a prebuilt image? a published package?). Then it renders **two** cuts (one with audio for review, one without for TikTok) and **uploads the bundle via the admin video endpoint** (`POST /api/admin/tracks/:id/video` / `fluncle admin track video --dir out/<log-id>`, **built**) — **the agent never holds R2 credentials; the Worker owns R2** and sets `video_url`.

3. **TikTok draft.** Once the video exists: submit a draft (audio-less cut + caption with analysis-derived hashtags, `#dnb`, and the canonical `fluncle://<log_id>` marker) via the TikTok Content Posting API — no music attached, no publish. Write any draft/post reference back via `track update`. **Open question:** the public post URL may only exist _after_ publishing, so `track update` stays the path to set it later.

4. **Show the video on the web.** Surface the R2 video as the track's preview (Through-the-Glass / One Pane); show a "processing" state in the recovered-telemetry register until `enrichment_status` is `done`. A missing video degrades to today's layout.

5. **Later — the small classifier.** Train it on the accumulated `manual`-labeled tags ({audio features → sub-genre}) — the `features_json` vectors are already being stored for exactly this. Gloriously, unnecessarily fun; that's the point.

## Now (parallel) — video render pipeline, local end-to-end (high priority)

Ship per-track videos by hand to build traction now; automation lands in parallel. The video agent runs **locally** (the `fluncle-video` skill, not Spinup — render is too hardware-heavy for the microVM for now). Two halves: fix render QUALITY, then close the SHIP loop.

**Quality — three regressions in the 2026-06-08 clips (`spears`, `wings`) vs the polished 06-07 batch:**

1. **Flat, "HTML-like" scenes (`spears`).** _Not_ an HTML fallback — it's a real GPU shader (`dither8` + film grain + smoothstep edges all present). The flatness is the **geometry**: thin, hard-edged, repetitive vertical spear-shafts on a sparse low-contrast field read like a CSS bar-chart, not the lush layered depth of the good clips. Fix is doctrine + a taste gate — favour organic depth, soft falloff, and atmospheric layering over thin hard primitives; reject flat/CSS-like geometry before shipping (always view frames — Maurice's video taste).

2. **Glitchy "dancing" motion (`wings`).** The shader subtracts a snappy, non-monotonic audio value from a **position** coordinate (`flow = radius*3 − u_time*0.85 − u_rise*1.4 − u_lift*0.6`; `u_lift` rises then decays on every beat), so the feathers jump forward and snap back — visible back-and-forth. Compounded by 21 high-frequency streaks that temporally alias as they move, and `spread = energy` wobbling the fan width. Rule to bake in: **audio reactivity modulates brightness/width/intensity, never position** — motion coordinates stay monotonic/continuous; damp or clamp audio terms; keep procedural detail low-frequency enough (or softened) to avoid temporal shimmer. Worth a shared helper (monotonic motion + additive-only audio shimmer).

3. **Fixed text that fights the scene.** `FloatingType` already allows a colour override, caller-placed position, and bakes in a contrast guarantee (scrim + ink halo) — but the agent repeats the same defaults (gold/cream/stardust) and the same placements on every track, so the type neither blends with the chosen aesthetic nor varies (e.g. gold "selected by Fluncle" over the gold plume). Fix: derive the text ink from the scene's palette within DESIGN bounds (a palette-aware colour helper, still contrast-guaranteed), and vary placement within the moodboard/DESIGN safe zones — **bounded, not fixed**.

**Systemic prevention:** a per-clip quality gate before "shippable" — render the key stills (ignition / mid / close), view them, and check a short list (organic depth · smooth monotonic motion · text blends + legible · inside safe margins). The video sibling of enrichment's "honest null" discipline.

**Ship loop — the local end-to-end is built; what remains is render quality + web surfacing:**

- **Two cuts per track** — the with-audio review cut + an **audio-less** cut (the official sound is attached by hand in the TikTok app, keeping licensing inside TikTok). _Built_ — the ship step produces both under `out/<log-id>/`.
- **Upload to R2** — `POST /api/admin/tracks/:id/video` / `fluncle admin track video --dir out/<log-id>` takes the whole bundle (footage / footage-silent / poster / note), stores it at `<log-id>/<name>`, and sets `video_url`; **the Worker owns R2, the agent never holds R2 creds**. _Built._
- **Caption generation** — VOICE.md voice, analysis-derived + `#dnb` hashtags, the canonical `fluncle://<log_id>` marker (`note.txt`). _Built._
- **TikTok draft** — `fluncle admin track draft` pushes the silent cut + caption to the TikTok inbox via Postiz (`SELF_ONLY`/`UPLOAD`); status tracked in `social_posts` via `track social`. _Built_ — see the capstone section + the `fluncle-publish` skill. Note: the inbox/UPLOAD flow carries the **video file only** — the caption does not transfer (the app shows a `#Postiz` placeholder), so the operator pastes it from `note.txt` in-app. Inherent to the flow, not a bug.
- **Profile-grid cover** — a dedicated, grid-legible cover (`cover.tsx` + `render-cover.ts`): loud centered `Artist — Title` over a clean late frame of the track's own footage, carrying the ink-halo contrast guarantee. Produced as `cover.jpg` by `ship`. The operator AirDrops it to Photos and sets it via TikTok's **Edit post → Edit cover** (uploadable from the phone within 7 days of posting; desktop uploads can't set a cover). _Built._
- **On-video safe zones** — the telemetry stamp moved clear of TikTok's top chrome + in-app search bar (TypePlate `SAFE_TOP` 150→300); identity stays lower-left. _Built._
- **Still open:** the render-quality regressions above; **TikTok audio line-up** (below); and **surfacing the video on the web** (it degrades gracefully today). The Spinup agent stays off for now; the local `fluncle-video` → `track video` → `track draft` loop runs by hand.

**TikTok audio line-up — open (staged; build only when a track breaks).** The video is beat-matched to a Deezer/iTunes 30s preview, which is a fixed mid-song segment; TikTok's attachable official sound is usually (not always) the song's first ~60s, and you trim it to any start within whatever span TikTok exposes. So when the preview segment isn't reachable in that span — and the track has no obvious section to line up by ear — the visuals pulse to beats that aren't playing. **Stage 0 (now):** preview audio + by-ear line-up; works when the track has a recognizable section near the preview (e.g. Nobody Else's strong opener). **When a track breaks — Stage 1:** full-track audio for analysis only via Apify `apidojo/youtube-scraper` (grab the `streamingData` audio URL → ffmpeg pull → analyze → discard, never stored or served). **Stage 2:** pick the best ~20s window inside the song's first ~55s, render to it, and write the absolute start offset into `render.json` + surface it ("set the sound to start at 0:42") so line-up is deterministic. Audio policy: YouTube audio is internal-analysis-only; published audio (web Stories, below) uses official previews. AcousticBrainz-by-ISRC is frozen (~2022/24 cutoff), so it is not a BPM fallback for new tracks — hence YouTube for full-audio analysis.

---

_Unsorted below — bigger arcs and reference detail. The build sequencing lives in **Now** above._

## Newsletter agent (Spinup) — not yet live

The Friday newsletter agent ([docs/newsletter-agent.md](./newsletter-agent.md)) exists on Spinup — the "Fluncle's Newsletter" agent the enrichment agent was modelled on — but is **stopped and not fully configured**. To bring it live: enable its capabilities (the `loops` + `firecrawl` CLIs) with their secrets bound, confirm the core instructions, and wire a **schedule** so it runs each Friday. It reads the discovery window from `/api/tracks` and sends via Loops. Dry-run one issue end-to-end before letting it send. Until then, no Friday send happens from the agent.

## Track add — ISRC fallback (prevents Log ID stragglers)

The Log ID seeds from the recording's ISRC (falling back to the Spotify id). When Spotify's track metadata omits the ISRC at add time, the track stores a null ISRC — and if it never gets a Log ID, it shows as a bare `#NN` ordinal instead of a coordinate (e.g. Dawn Wall — Spears, backfilled by hand from Deezer's `GBIGR1531001` → `009.7.6X`). Root-cause fix: in the add flow, when Spotify returns no ISRC, look it up from Deezer (search → `/track/{id}` carries the ISRC) before computing the Log ID and enriching, so every finding stays ISRC-seeded and coordinate-bearing. (Also: the generic `track update` admin path can't set `isrc`/`logId` today — add it there too, with Log ID auto-gen when missing, so future stragglers are fixable without a direct DB write.)

## TikTok auto-pipeline (the capstone)

The full vision: "Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com`, and the system resolves metadata + a legal preview, analyzes the audio, renders a 9:16 video, writes a caption, and pushes a social **draft** — fully automatic. The only human steps stay manual on purpose: attach the official TikTok sound, then publish. Preview audio is for analysis only, never uploaded.

**Built (the draft-publishing layer is live):** per-platform `social_posts` state, the **Postiz** adapter (one API key; drafts to the TikTok inbox via `content_posting_method: UPLOAD` + `SELF_ONLY`), the caption (`note.txt` — audio-derived hashtags + the `fluncle://<log-id>` marker), and the CLI (`track draft` / `track social`). See [track-lifecycle.md](./track-lifecycle.md) Phase 3 + the `fluncle-publish` skill. We chose **Postiz over a direct TikTok Content Posting API integration** — no app audit, no OAuth/token storage on our side, and YouTube/Instagram come along for free.

What's left to reach the fully-automatic capstone:

- **Autonomous trigger.** Today the operator runs `track video` then `track draft` by hand. The future single Spinup agent chains enrich → video → publish, fired from a track being added (`ctx.waitUntil`), not a manual run. Blocked on the Spinup render profile (see Now).
- **Reconciliation.** An hourly check that matches recent posts to the `fluncle://<log-id>` marker and flips `social_posts.status` to `published` with the live URL — so publication state is observed, not hand-entered. Today the operator records status + URL manually via `track social`.
- **More platforms.** YouTube Shorts / Instagram Reels — connect them in Postiz, add platform sections to the `fluncle-publish` skill; same `social_posts` table + CLI. (Verify each supports a true draft vs. auto-publish.)
- **Text overlays from verified facts.** _Built._ Artist / track / label+year and the Found date / Log ID are burned into the render by the `TypePlate` (fixed identity lower-left, telemetry upper-right, scene-derived ink, ink-halo contrast guarantee), plus the grid `Cover`. Render-safe facts only (Spotify metadata); the fluncle-video skill owns it.

The one human action always stays: choose song, attach official sound, press publish.

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

- **fluncle.com Stories.** A swipe-through, Snapchat-stories-style interface on the web to flick through recent findings and listen to a clip per track. Audio is the **official Deezer/iTunes preview** (distributed by the providers for preview playback), never YouTube-sourced audio — see the internal-vs-published split in the audio line-up plan above. Pairs with per-track video surfacing (the R2 `footage.mp4` + the new `cover.jpg` as the still), and leans on the Log ID spine (each story is a `fluncle://<log-id>`). A missing video/clip degrades to today's layout.
- **Website overhaul from the moodboard.** Revisit fluncle.com against `packages/video/moodboard/MOODBOARD.md` — the texture families, the Retint Rule, the first-party collages, the One-Sun stage-light grammar. The video kit has pushed the visual language well past where the web currently sits; pull the web up to match (within DESIGN.md's rules — this is evolution, not a second system).
- **Audit moodboard → canon docs.** Review whether anything proven out in the moodboard and the video kit (texture families, the Retint Rule, vehicle grammar, the One-Sun-through-the-vehicle clarification) should be promoted into [DESIGN.md](../DESIGN.md), [PRODUCT.md](../PRODUCT.md), or [VOICE.md](../VOICE.md) — or stay video-local. The risk to weigh: keeping doctrine in one place vs. bloating the canon with things only the video surface needs. Decide per concept; cross-link rather than duplicate.
  - **Includes the logbook reframe.** The co-equal reframe above is the heaviest canon decision on the list: PRODUCT.md gains a co-primary "log/observation" thesis, VOICE.md formalizes the logbook register as the deep end of the Depth Gradient (and re-skins the narrative brief's vocabulary through the ban list — "transmission"/"signal" out, log/observation/discovery/archive/sector in), and DESIGN.md gains the log-page/archive panes. Resolve these as part of this audit, not piecemeal per feature.
