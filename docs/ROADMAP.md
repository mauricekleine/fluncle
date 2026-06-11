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
- **Submit + monitor.** Sitemap submitted to GSC and Bing (2026-06-11); watch the _set_ of log pages move to Indexed (count ≈ archive size); verify bare-token retrieval (`004.7.2I`, `fluncle://004.7.2I`) lands the log page. Check Fluncle is present in Brave Search. Indexing and AI citation are weeks-out outcomes — monitoring, not ship gates.
- **Third-party corroboration: the anchors exist (2026-06-11).** MusicBrainz artist `53346748-1357-45c0-a847-9d248b65d655` (Person, homepage/TikTok/Telegram links) and Wikidata item `Q140169844` (instance of human, official website, MusicBrainz artist ID, TikTok + Telegram usernames); both are in the `/about` `sameAs` set. Remaining: authentic presence where dnb lives (r/DnB and friends — participate, don't fabricate), and enrich the Wikidata item as facts accumulate.

### Link out to the socials — CLI + SSH remainder

The web side shipped (the socials cluster on the home plate, TikTok links on the log pages and feed rows). Remaining: the CLI + SSH sign-offs and any other non-web surface that should point at [@fluncle on TikTok](https://www.tiktok.com/@fluncle) and the rest of [docs/socials.md](./socials.md).

### Private preview archive for analysis

Public preview playback stays live-only through `/api/preview/:idOrLogId`: stored Deezer URL, refreshed Deezer by ISRC, then iTunes fallback, with `Cache-Control: no-store`. Do **not** make R2 the playback source and do not write an R2 URL into `preview_url`. Instead, preserve the exact official 30s preview used for the enrichment feature vector at an operator-only archive path in R2. The archive is private analysis/model-training input for the future sub-genre classifier, not public media, not downloadable, not streamed, and never full-song audio. Backfill can archive one freshly resolved preview per existing finding as a best-effort backlog repair; it may differ from the bytes an older enrichment analyzed.

### Admin sub-genre tagging UI (the classifier's training data)

The CLI is too tedious for bulk human sub-genre labeling; build a fast **admin-gated** web tool on fluncle.com to tag song-by-song. Layout: **left** = the track (cover art first, a play/pause control below it on the official preview); **right** = a short form of shadcn **checkbox cards**, one per sub-genre (card title = the sub-genre, subtitle = a one-line description), multi-select. **Save / Next** writes `manual` tags via the admin API and auto-advances to the next track with no human label yet, **oldest-first**; a toggle reveals tracks already labeled. A side list of all tracks (with labeled/unlabeled state) lets you step prev/next from the work area or scroll and click straight into a specific song. This is the deliberate human-label surface that produces the `manual` tags the **Sub-genre classifier** (below) trains on — build it before betting on the classifier. Needs: admin auth on a web route (not just the CLI token), the shadcn checkbox-card component (add via the shadcn CLI), and a canonical dnb sub-genre list + descriptions (define the taxonomy as part of this). Manual tags always win over `auto` — this is where they're set, so it doubles as the fix for the classifier's over-eager `auto` tags (e.g. the neurofunk it stamps on liquid rollers like Krakota — Sea Air and Whiney — Nightfall): pick the right sub-genres here and the `manual` write supersedes the wrong chips.

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

v1 shipped 2026-06-10 at [galaxy.fluncle.com](https://galaxy.fluncle.com) (same Worker, `/galaxy` route): behind-the-ship 8-bit flight where every banger is a star at its Log ID coordinate, the nearest uncollected preview fades in by distance and pans by bearing, reaching a star parks you in an orbit listening moment that refuels the tank, dry tank means towed home at `0/N`, and `N/N` opens the fly-home win with a credits roll of the full log. Touch + keyboard, Esc pause, the `window.fluncle` flight computer easter egg, audio through the same-origin `/api/preview/:idOrLogId` proxy (live Deezer/iTunes only; archived previews are not a playback source). Shares the Log ID spine with the logbook reframe; the shipped design decisions live in the code and git history. What's ahead:

**Frontier extension (landed 2026-06-11):** the world is now genuinely data-driven. Stars, set-dressing, hazards, and projectiles are one typed `Entity` model with a per-kind behavior table (`apps/web/src/game/types.ts` + `sim.ts`); the sim ships with the pure-state tests it was missing (`sim.test.ts`, `entities.test.ts`). On that spine landed: **Roadster + UFO** set-dressing (deterministic, render-only, density rising with distance); the **black hole** as a deterministic **teleport network** (one system per ~50 findings, five candidate slots, the session seed picks which is live and which four are its exits — gravity draws you in, the horizon flings you to a survivable exit with a slingshot fuel top-up, never a restart; this folds in the old worm-hole idea); **asteroid waves + an auto-clearing laser** (the offensive verb — the playthrough blessed it, so it is simply part of the galaxy, no flag; rocks cost fuel, never instakill; bolts only ever hit rocks); the **amen-break intro** riding the gate-tap unlock + a **master volume toggle** top-right (a first-party 8-bit amen breakbeat ships — drums only, clearance-clean, synthesized by `packages/media/scripts/generate-amen.py`; swappable anytime); and the **OG image** via a new `packages/media` Remotion image-render package. The dry-tank tow stays the one true failure; every hazard routes through the fuel economy.

**Near polish:**

- **Meta touches:** ✅ `/galaxy` in the sitemap (was already there; now asserted), ✅ the gate-screen OG image (`packages/media` → `public/galaxy/og.png`). Still ahead: announce to the crew (Telegram + the Friday letter) once the polish lands.
- **Bespoke sprites:** the new bodies (Roadster, UFO, asteroid) draw on procedural fallbacks today; the bespoke Nano-Banana PNGs (same workflow as ship/earth, see `docs/galaxy-sprites.md`) drop into `public/galaxy/` over them. The black hole is procedural by design.
- **Economy tuning from a real full clear** (10–15 min target): burn rates, refuel dwell, cruise/boost speeds, plus the new frontier dials — black-hole influence/pull radii and system count, asteroid wave density, laser cooldown, amen volume/fade. One human playthrough decides (out of agent scope by design).
- **Real-device mobile pass:** thumb zones on actual glass, safe-areas, the dynamic address bar, performance on a mid phone (now with more entities + the film pass).
- **SFX pass:** the square-wave kit gained warp / bolt / asteroid-hit voices; richer 8-bit when it itches.
- **Boot cinematic upgrade** (v1 is minimal + skippable).

**The expanding frontier (the content engine):** the Log ID sector is days since the Fluncle epoch and maps to distance from Earth, deliberately uncompressed — the galaxy literally grows outward as findings land, full clears get longer, and that pressure is what future content answers. The entity spine now makes this real: set-dressing and hazard density already rise with distance from Earth, and the black-hole network scales with the catalogue. Still ahead: **new home planets as forward bases / respawn + refuel hubs** (overlaps persistence), derelicts and lore nodes. The further from Earth, the stranger the universe — near space is the warm early catalogue, the frontier is the new-and-scary flicker.

**Backlog (still open):**

- **Worm holes as a distinct entity** — deferred: the black-hole teleport network now carries the "shortcut to the far side" flavor; a separate worm-hole only if it earns its own navigation.
- **Other planets / forward bases** — future, tied to persistence (refuel hubs / respawn points out on the frontier).
- **The bespoke sprite menagerie** beyond the heroes (see Near polish).

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

### Link the log pages where hyperlinks exist

Every finding now has a permanent URL (`https://www.fluncle.com/log/<log-id>`) — surfaces that can carry real links should use it: the Friday newsletter (per-track links to the log page instead of/alongside Spotify), Telegram posts (a quiet log-page link under the banger), and CLI/SSH output where a URL prints. TikTok captions stay bare-coordinate (`fluncle://<id>`) on purpose — no hyperlinks there, and the coordinate-to-site retrieval is the AEO play.

### Newsletter agent (Spinup)

The Friday newsletter agent ([docs/newsletter-agent.md](./newsletter-agent.md)) exists on Spinup but is stopped and unconfigured. To go live: enable its capabilities (the `loops` + `firecrawl` CLIs with their secrets), confirm the core instructions, and wire a Friday schedule; it reads the discovery window from `/api/tracks` and sends via Loops. Dry-run one issue end-to-end before letting it send.

### Sub-genre classifier

Train a small classifier on the accumulated `manual`-labeled tags ({audio features → sub-genre}); the `features_json` vectors are already stored for exactly this. Unnecessarily fun — that's the point.
