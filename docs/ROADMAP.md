# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

## Now — content backlog

Render a stack of videos so there's a schedulable backlog on TikTok: breathing room to roll out features without the feed going quiet. Uses the built local loop end-to-end; no new code.

- Find every track with no video (`fluncle recent --json`, `video_url` null).
- Render a **diverse** batch — spread vehicles via the ledger and assign a distinct visual family per render (parallel renders converge on a shared attractor; broaden refs, don't let them).
- Per track: `ship --vehicle` → `fluncle admin track video` (R2, incl. `cover.jpg`) → `fluncle admin track draft` (TikTok inbox).
- The operator finishes each by hand in the app — paste caption (`note.txt`), add the official sound, set the cover, schedule. The backlog is a queue of ready inbox drafts to space out over days.

## Next — surface what we make, and tidy reliability

### Video on the web + fluncle.com Stories

Surface the R2 video as the track's preview (Through-the-Glass / One Pane), with a "processing" state in the recovered-telemetry register until enrichment is `done`; a missing video degrades to today's layout. Build the **Stories** swipe interface on top — flick through recent findings, a clip per track. Audio is the **official Deezer/iTunes preview** (distributed by the providers for preview playback), never YouTube-sourced. Uses `footage.mp4` + `cover.jpg` as the still and the `fluncle://<log-id>` spine (each story is a log entry).

### Track-add ISRC fallback (reliability)

The Log ID seeds from the recording's ISRC. When Spotify omits the ISRC at add time the track stores a null ISRC and can end up a bare `#NN` ordinal instead of a coordinate. Fix at the source: in the add flow, when Spotify returns no ISRC, look it up from Deezer (search → `/track/{id}` carries it) before computing the Log ID. Also let the generic `track update` set `isrc`/`logId` (auto-gen the Log ID when missing) so any straggler is fixable without a direct DB write.

### TikTok audio line-up (build only when a track breaks)

On standby — most relevant during the content backlog. The video is beat-matched to a Deezer/iTunes 30s preview (a fixed mid-song segment); TikTok's attachable sound is usually — not always — the song's first ~60s, trimmable to any start within the span it exposes. When the preview segment isn't reachable there and the track has no obvious section to line up by ear, the visuals pulse to beats that aren't playing. **Stage 0 (now):** by-ear line-up. **Stage 1 (on break):** full-track audio for analysis only via Apify `apidojo/youtube-scraper` (stream URL → ffmpeg → analyze → discard, never stored or served). **Stage 2:** pick the best ~20s window inside the first ~55s, render to it, write the absolute start offset into `render.json` + surface it ("start the sound at 0:42"). Audio policy: YouTube audio is internal-analysis-only; published audio uses official previews. AcousticBrainz-by-ISRC is frozen (~2022/24), so it is not a BPM fallback for new tracks.

## Later — the bigger arcs

### Fluncle's Galaxy — the logbook reframe

The largest arc, the one the others point at. A **co-equal reframe**: Fluncle is a cosmonaut keeping a logbook, every discovery a **log entry** with a permanent, surface-independent identity (`fluncle://<id>`), the banger the artifact attached to an observation. The log becomes as central as the music — real canon surgery, not a bolt-on; the music-first product and the warm uncle keep their weight, the journey is the second axis.

One identity, many representations:

```
fluncle://241.7.3A
  ├─ fluncle.com/log/241.7.3A    (web: a log page, not a row)
  ├─ on-screen overlay + caption (TikTok)
  ├─ <guid> in the RSS feed       (the observation feed)
  ├─ fluncle log 241.7.3A         (CLI)
  ├─ ssh rave.fluncle.com 241…    (the recovered terminal)
  └─ social_post reconciliation key
```

The spine (the Log ID) already runs across surfaces; what's ahead:

- **New surfaces:** `/log/<id>` pages (the log as object — observation, recovered artifact, related logs), RSS as the observation feed, possibly Discord. The site becomes an archive you browse, not only a feed you scroll. This subsumes the auto-pipeline's reconciliation marker — one identity does the trail and the reconciliation.
- **Canon surgery (resolve as one decision, not piecemeal):** PRODUCT.md gains a co-primary log/observation thesis; VOICE.md formalizes the logbook register as the deep end of the Depth Gradient (SSH / archive / RSS speak as a "recovered terminal," the warm uncle still holds web / Telegram / email; "transmission" and "signal" stay banned, adopt log / observation / discovery / archive / recovered / artifact / sector; "banger" stays primary); DESIGN.md gains the log-page / archive panes (Oxanium, tabular, instrument-panel calm).

### Fluncle's Galaxy — the game

A playable, oldskool terminal-UI space game where the galaxy is literally our findings: every banger is a star at its Log ID coordinate, you fly a ship (steer left/right, spacebar boosts, fuel drains), and you refuel by flying to a star and logging the banger. On the web the nearest star's 30s preview fades in by distance — discovery as a game loop; in SSH the same game runs audio-less with proximity as signal telemetry. Web-first, parallax pseudo-3D, 8-bit sprites (image-gen, curated), session-only state, win by collecting all current bangers. A foundation to hide more in later (asteroids, black holes, UFOs, planets). Shares the Log ID spine with the logbook reframe; motivates user accounts (below, out of scope for the MVP). Full notes + direction: [docs/galaxy-game.md](./galaxy-game.md).

### User accounts

Persistent per-user state — the thing that unlocks saved progress (e.g. a player's collected bangers in the Galaxy game), and likely personalization elsewhere. Out of scope for any current MVP; called out here so features that _want_ persistence (the game, future surfaces) have a known home to defer to rather than half-building it inline.

### TikTok auto-pipeline (the capstone) + Spinup automation

"Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com` and the system enriches → renders → captions → pushes a draft automatically; the human steps stay manual on purpose (attach the official sound, finish, publish). The draft-publishing layer runs today by hand — what's left to make it autonomous:

- **Render-capable Spinup profile.** Software-GL (SwiftShader) is viable (~1.45× Metal, no GPU needed); needs a render rootfs (Chromium + SwiftShader / Mesa / fonts + ffmpeg), likely >1 vCPU, and a check against the per-run cap. **Open question:** how the agent gets the `packages/video` kit, since Spinup has no persistence — fresh checkout per run, a prebuilt image, or a published package?
- **Enrichment-analysis agent on Spinup** — buildable now, lighter (ffmpeg + JS DSP, fits current limits); the analysis is a self-contained skill (no repo checkout). Needs ffmpeg pinned in the rootfs, the `fluncle` CLI installed, and the admin token bound.
- **Autonomous trigger.** The Worker `ctx.waitUntil`s the agent on add; it chains enrich → video → publish instead of the manual runs.
- **Reconciliation.** An hourly check matching recent posts to the `fluncle://<log-id>` marker, flipping `social_posts.status` to `published` with the live URL — observed, not hand-entered.
- **More platforms.** YouTube Shorts / Instagram Reels — connect in Postiz, add platform sections to the `fluncle-publish` skill (verify each supports a true draft vs auto-publish).

### Brand & web overhaul

- **Website overhaul from the moodboard** — pull fluncle.com up to where the video kit's visual language now sits (texture families, the Retint Rule, first-party collages, the One-Sun stage-light grammar), within DESIGN.md: evolution, not a second system. Reference `packages/video/moodboard/MOODBOARD.md`.
- **Moodboard → canon audit** — decide per concept whether moodboard / video-kit proofs (texture families, Retint Rule, vehicle grammar, One-Sun-through-the-vehicle) get promoted into DESIGN.md / PRODUCT.md / VOICE.md or stay video-local; cross-link, don't duplicate. Resolve the logbook reframe above as part of this same audit.

### Newsletter agent (Spinup)

The Friday newsletter agent ([docs/newsletter-agent.md](./newsletter-agent.md)) exists on Spinup but is stopped and unconfigured. To go live: enable its capabilities (the `loops` + `firecrawl` CLIs with their secrets), confirm the core instructions, and wire a Friday schedule; it reads the discovery window from `/api/tracks` and sends via Loops. Dry-run one issue end-to-end before letting it send.

### Sub-genre classifier

Train a small classifier on the accumulated `manual`-labeled tags ({audio features → sub-genre}); the `features_json` vectors are already stored for exactly this. Unnecessarily fun — that's the point.
