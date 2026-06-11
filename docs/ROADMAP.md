# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

## Now — content backlog

Render a stack of videos so there's a schedulable backlog on TikTok: breathing room to roll out features without the feed going quiet. Uses the built local loop end-to-end; no new code.

- Find every track with no video (`fluncle recent --json`, `video_url` null).
- Render a **diverse** batch — spread vehicles via the ledger and assign a distinct visual family per render (parallel renders converge on a shared attractor; broaden refs, don't let them).
- Per track: `ship --vehicle` → `fluncle admin track video` (R2, incl. `cover.jpg`) → `fluncle admin track draft` (TikTok inbox).
- The operator finishes each by hand in the app — paste caption (`note.txt`), add the official sound, set the cover, schedule. The backlog is a queue of ready inbox drafts to space out over days.

## Next — surface what we make, and tidy reliability

### Log IDs in search + AI answers (AEO/GEO) — off-site thread

The on-site layer shipped (per-finding `/log/<id>` pages with definitional prose + `MusicRecording` identifiers, the `/log` index, sitemap enumeration, the `/about` entity/FAQ surface, one canonical description everywhere). What remains is off-site and slower:

- **AI crawlers: verified allowed (2026-06-11), keep the regression check.** The dashboard confirms verified AI crawlers pass (ClaudeBot 24 allowed requests, 38 crawls answered 200, the sitemap the most-crawled path); the earlier 403s were Cloudflare's spoof-detection rejecting fake-UA probes, not a block. Managed robots.txt is OFF. Still worth a recurring check of the live `/robots.txt` + the AI Crawl Control crawler policies (Cloudflare can re-flip defaults silently).
- **Submit + monitor.** Sitemap to GSC and Bing Webmaster Tools; watch the _set_ of log pages move to Indexed (count ≈ archive size); verify bare-token retrieval (`004.7.2I`, `fluncle://004.7.2I`) lands the log page. Check Fluncle is present in Brave Search. Indexing and AI citation are weeks-out outcomes — monitoring, not ship gates.
- **Third-party corroboration (the highest GEO lever).** Sequenced: a MusicBrainz entry for the selector/playlist first (the structural anchor), then a Wikidata item citing it (a bare self-made item risks deletion), then authentic presence where dnb lives (r/DnB and friends — participate, don't fabricate). Update the `/about` `sameAs` set as each lands.
- **Bios.** Paste the canonical description (`apps/web/src/lib/identity.ts`) verbatim into the Spotify / Telegram / TikTok bios so the entity reads identically everywhere.

### Link out to the socials — CLI + SSH remainder

The web side shipped (the socials cluster on the home plate, TikTok links on the log pages and feed rows). Remaining: the CLI + SSH sign-offs and any other non-web surface that should point at [@fluncle on TikTok](https://www.tiktok.com/@fluncle) and the rest of [docs/socials.md](./socials.md).

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

### Fluncle's Galaxy — the game (v1 live)

v1 shipped 2026-06-10 at [galaxy.fluncle.com](https://galaxy.fluncle.com) (same Worker, `/galaxy` route): behind-the-ship 8-bit flight where every banger is a star at its Log ID coordinate, the nearest uncollected preview fades in by distance and pans by bearing, reaching a star parks you in an orbit listening moment that refuels the tank, dry tank means towed home at `0/N`, and `N/N` opens the fly-home win with a credits roll of the full log. Touch + keyboard, Esc pause, the `window.fluncle` flight computer easter egg, audio through the same-origin `/api/preview/:idOrLogId` proxy (source-agnostic: a future R2 `preview_url` drops in unchanged). Shares the Log ID spine with the logbook reframe; the shipped design decisions live in the code and git history. What's ahead:

**Near polish:**

- **Meta touches:** add `/galaxy` to `sitemap.xml`; a game-specific OG image (a gate-screen still) so shared galaxy.fluncle.com links pop; announce to the crew (Telegram + the Friday letter) once the polish lands.
- **Economy tuning from a real full clear** (10–15 min target): burn rates, refuel dwell, cruise/boost speeds — one human playthrough of all stars decides.
- **Real-device mobile pass:** thumb zones on actual glass, safe-areas, the dynamic address bar, performance on a mid phone.
- **SFX pass:** the square-wave kit is deliberately minimal (thrust, ping, log chime, alarm); richer 8-bit voices when it itches.
- **Boot cinematic upgrade** (v1 is minimal + skippable) and the sprite menagerie beyond the two heroes.

**The expanding frontier (the content engine):** the Log ID sector is days since the Fluncle epoch and maps to distance from Earth, deliberately uncompressed — the galaxy literally grows outward as findings land, full clears get longer, and that pressure is what future content answers: new home planets as forward bases / respawn + refuel hubs, asteroids in the long empty stretches, black holes (danger, or warps that shortcut the old sectors), aliens/UFOs, derelicts and lore nodes. The further from Earth, the stranger the universe — near space is the warm early catalogue, the frontier is the new-and-scary flicker. The world is data-driven, so entities slot in without re-architecting; expansion features should be motivated by outward growth, never bolted on.

**Easter eggs, hazards & set dressing (ideas backlog)** — content to fill the widening void as the frontier pushes out (each new finding's higher sector sits further from Earth, so the galaxy auto-expands with the catalogue):

- A floating **Tesla Roadster** drifting by — a derelict to fly past (the canonical space-junk wink).
- **Black holes with real gravity** — fall past the point of no return and you can't escape; the run restarts. (Distinct from the warp-shortcut black holes above — these are pure hazard.)
- **Asteroid waves** — and, by extension, **ship lasers** to shoot through them (the game's first offensive verb).
- **Worm holes** — shortcut to the far side of the galaxy.
- **UFOs flying by** — encounters; the further out, the stranger.
- **Other planets** — forward bases / refuel hubs (overlaps the new-home-planet idea above).

**SSH version (the flex):** the same game inside `ssh rave.fluncle.com`, audio-less by nature, with proximity rendered as signal-strength telemetry ("carrier detected… 71%… LOCK") — a lonely operator reading instruments, limitation as flavor. Confirm realtime input + frame rate over SSH before committing.

**Persistence:** a player's collected bangers want to survive a refresh — that's the user-accounts item below; session-only until then.

### User accounts

Persistent per-user state — the thing that unlocks saved progress (e.g. a player's collected bangers in the Galaxy game), and likely personalization elsewhere. Out of scope for any current MVP; called out here so features that _want_ persistence (the game, future surfaces) have a known home to defer to rather than half-building it inline.

### TikTok auto-pipeline (the capstone) + Spinup automation

"Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com` and the system enriches → renders → captions → pushes a draft automatically; the human steps stay manual on purpose (attach the official sound, finish, publish). The draft-publishing layer runs today by hand — what's left to make it autonomous:

- **Render-capable Spinup profile.** Software-GL (SwiftShader) is viable (~1.45× Metal, no GPU needed); needs a render rootfs (Chromium + SwiftShader / Mesa / fonts + ffmpeg), likely >1 vCPU, and a check against the per-run cap. **Open question:** how the agent gets the `packages/video` kit, since Spinup has no persistence — fresh checkout per run, a prebuilt image, or a published package?
- **Enrichment-analysis agent on Spinup** — buildable now, lighter (ffmpeg + JS DSP, fits current limits); the analysis is a self-contained skill (no repo checkout). Needs ffmpeg pinned in the rootfs, the `fluncle` CLI installed, and the admin token bound.
- **Autonomous trigger.** The Worker `ctx.waitUntil`s the agent on add; it chains enrich → video → publish instead of the manual runs.
- **Reconciliation.** An hourly check matching recent posts to the `fluncle://<log-id>` marker, flipping `social_posts.status` to `published` with the live URL — observed, not hand-entered.
- **More platforms.** YouTube Shorts / Instagram Reels — connect in Postiz, add platform sections to the `fluncle-publish` skill (verify each supports a true draft vs auto-publish).

### Brand & canon

- **Moodboard → canon audit (video-side remainder)** — the web overhaul resolved the web half (the logbook plate, ignition hovers, the grain architecture, and the archive grammar are in DESIGN.md now). Still open per concept: whether the video-kit proofs (texture families' full grammar, vehicle grammar, One-Sun-through-the-vehicle) get promoted into canon or stay video-local; cross-link, don't duplicate.

### Newsletter agent (Spinup)

The Friday newsletter agent ([docs/newsletter-agent.md](./newsletter-agent.md)) exists on Spinup but is stopped and unconfigured. To go live: enable its capabilities (the `loops` + `firecrawl` CLIs with their secrets), confirm the core instructions, and wire a Friday schedule; it reads the discovery window from `/api/tracks` and sends via Loops. Dry-run one issue end-to-end before letting it send.

### Sub-genre classifier

Train a small classifier on the accumulated `manual`-labeled tags ({audio features → sub-genre}); the `features_json` vectors are already stored for exactly this. Unnecessarily fun — that's the point.
