# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

## Now — content backlog

Render a stack of videos so there's a schedulable backlog on TikTok: breathing room to roll out features without the feed going quiet. Uses the built local loop end-to-end; no new code.

- Find every track with no video, oldest first (`fluncle admin queue --json`) — the render queue.
- Render a **diverse** batch — spread vehicles via the ledger and assign a distinct visual family per render (parallel renders converge on a shared attractor; broaden refs, don't let them).
- Per track: `ship --vehicle` → `fluncle admin track video` (R2, incl. `cover.jpg`) → `fluncle admin track draft` (TikTok inbox).
- The operator finishes each by hand in the app — paste caption (`note.txt`), add the official sound, set the cover, schedule. The backlog is a queue of ready inbox drafts to space out over days. Drive it from the **`/admin/posts` board** (shipped, PR #13): per-platform status, push/re-push, copy-caption, mark published/failed, and asset downloads (cover + cuts) for AirDrop — built to use one-handed on a phone.
- **Hard cap: ≤ 5 inbox drafts per 24h (TikTok-side).** TikTok rejects the 6th pending (`SELF_ONLY`) post in any rolling 24-hour window; the failure is asynchronous (the CLI + Postiz report success, TikTok bounces it downstream, surfaced only as a Postiz error). So draft at most 5/day, push the rest on following days, and re-push any that bounced after 24h. Unpublished drafts sitting in the inbox count against the budget — the operator publishing/clearing them frees it. (Full detail in the `fluncle-publish` skill.)
- **YouTube Shorts runs alongside (live, no manual finish, no daily cap).** The same finding posts to YouTube as a direct public Short — title + caption + `cover.jpg` thumbnail all carry through the API, so it goes up hands-off (one tap on the board, or `--platform youtube`). A second distribution surface for the same backlog; only TikTok needs the in-app finish + the 5/24h ceiling. (Content ID typically _claims_ short clips — they stay up, the rights holder monetizes — accepted; reach over revenue.)

## Next — surface what we make, and tidy reliability

### Log IDs in search + AI answers (AEO/GEO) — off-site thread

The on-site layer shipped (per-finding `/log/<id>` pages with definitional prose + `MusicRecording` identifiers, the `/log` index, sitemap enumeration, the `/about` entity/FAQ surface, one canonical description everywhere). What remains is off-site and slower:

- **AI crawlers: verified allowed (2026-06-11), keep the regression check.** The dashboard confirms verified AI crawlers pass (ClaudeBot 24 allowed requests, 38 crawls answered 200, the sitemap the most-crawled path); the earlier 403s were Cloudflare's spoof-detection rejecting fake-UA probes, not a block. Managed robots.txt is OFF. Still worth a recurring check of the live `/robots.txt` + the AI Crawl Control crawler policies (Cloudflare can re-flip defaults silently).
- **Submit + monitor.** Sitemap submitted to GSC and Bing (2026-06-11); watch the _set_ of log pages move to Indexed (count ≈ archive size); verify bare-token retrieval (`004.7.2I`, `fluncle://004.7.2I`) lands the log page. Check Fluncle is present in Brave Search. Indexing and AI citation are weeks-out outcomes — monitoring, not ship gates.
- **Third-party corroboration: the anchors exist (2026-06-11).** MusicBrainz artist `53346748-1357-45c0-a847-9d248b65d655` (Person, homepage/TikTok/Telegram links) and Wikidata item `Q140169844` (instance of human, official website, MusicBrainz artist ID, TikTok + Telegram usernames); both are in the `/about` `sameAs` set. Remaining: authentic presence where dnb lives (r/DnB and friends — participate, don't fabricate), and enrich the Wikidata item as facts accumulate.

### A Fluncle DJ mix — breadcrumbs + a real MusicBrainz release

Maurice DJs, so a one-night hour-long mix of the findings is low-effort, on-brand (a selector mixing is curation-as-performance — unlike an AI-made original, which fights the persona), and feeds several threads at once. Home it on **Mixcloud**, which is properly licensed (direct deals with the majors + indies like Ninja Tune / XL via Merlin): it plays legally and pays the featured artists, within the Featured-Artist / SRPC limits (≤ 4 tracks per artist, ≤ 3 per album, tracklist required — trivial for a varied D&B set). Mirror to **YouTube** for reach (Content ID claims it: the video stays up but the labels monetize it — good for reach, not revenue, with a minor regional-block / strike risk); **SoundCloud** is patchier (takedown risk — secondary). The required **tracklist is the breadcrumb**: write it as the findings, each with its `fluncle://<log-id>` coordinate and a `/log/<id>` link (Mixcloud tracklist; YouTube description + chapters) — owned surfaces and authentic scene presence pointing back at fluncle.com, which directly advances the off-site thread's "authentic presence where dnb lives". Then add the mix to **MusicBrainz as a DJ-mix release** (Fluncle as the mix artist, tracklist = the real recordings): the on-brand way to make the MusicBrainz artist substantial and settle the "is this a real artist" question — no AI original needed. Not urgent — a fun night's work when there's time.

### Private preview archive — move to a non-public bucket

Shipped (PR #6): enrichment stores the exact official 30s preview used for the feature vector at an operator-only path (`analysis/previews/<log-id>/<sha256>.<ext>`), excluded from every public DTO/UI/RSS/sitemap and from `/api/preview` (public playback stays live-only: stored Deezer → refreshed-by-ISRC → iTunes, `Cache-Control: no-store`; R2 is never the playback source). **Open follow-up:** it currently lives in the public `fluncle-videos` bucket, so its privacy rests only on the unguessable key — move it to a dedicated **non-public** R2 bucket before relying on it as training input. The columns stay inert until the first archive write, so there's runway. (Training consumer: the vibe-placement model below.)

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

**The entity spine (landed, PR #7).** The world is now data-driven: stars, set-dressing, hazards, and projectiles are one typed `Entity` model with a per-kind behavior table (`game/types.ts` + `sim.ts`), backed by the pure-state tests it was missing (`sim.test.ts`, `entities.test.ts`). Riding that spine: Roadster + UFO set-dressing, the black-hole teleport network (gravity in, slingshot out — never a restart; subsumes the old worm-hole idea), asteroid waves + an auto-clearing laser, the amen-break intro + master volume toggle, and the gate-screen OG image (`packages/media`). Every hazard routes through the fuel economy; the dry-tank tow stays the one true failure. This is the same sim spine the SSH RFC reuses wholesale.

**Near polish:**

- **Announce to the crew:** post the game to Telegram + the Friday letter once the near-polish lands. (The `/galaxy` sitemap entry and the gate-screen OG image already shipped.)
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

**SSH version (the flex)** — scoped in [docs/galaxy-ssh-rfc.md](./galaxy-ssh-rfc.md); **landed in code (PR #13)**. The approach pivoted: instead of compiling `sim.ts` to WASM (Javy/QuickJS → wazero), the SSH galaxy is a **Go port** of the sim (`apps/ssh/internal/galaxy` — engine/placement/projection) kept in lockstep by **parity tests** against the JS source (`apps/web/src/game/parity-fixtures.test.ts` + testdata), wired into the terminal (`screenGalaxy` / `handleGalaxyKey` in `apps/ssh/main.go`). The same _sim_ inside `ssh rave.fluncle.com`, then: a top-down scope renderer, the read-the-log orbit card with an OSC-8 Spotify link, audio-less as flavor ("the audio didn't survive the trip out here — it's still playing back on Earth"), telemetry in the deepest Depth-Gradient register taken from the shipped strings ("Pulled under. Flung across the galaxy." · "Home, junglist."). Map knowledge is portable across surfaces — the Log ID spine paying off. The working Go port + parity harness resolve the old PASS/KILL spikes (SSH input latency; the engine model) and the "confirm realtime input + frame rate" question. Remaining is the SSH experience polish + the deploy to rave.fluncle.com (the SSH app's own step); the Minimum Lovable galaxy ships whole, with QR / Kitty-input / ambient-crew as named fast-follows.

**Persistence:** a player's collected bangers want to survive a refresh — that's the user-accounts item below; session-only until then.

### User accounts

Persistent per-user state — the thing that unlocks saved progress (e.g. a player's collected bangers in the Galaxy game), and likely personalization elsewhere. Out of scope for any current MVP; called out here so features that _want_ persistence (the game, future surfaces) have a known home to defer to rather than half-building it inline.

### TikTok auto-pipeline (the capstone) + Spinup automation

"Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com` and the system enriches → renders → captions → pushes a draft automatically; the human steps stay manual on purpose (attach the official sound, finish, publish). The draft-publishing layer runs today by hand — now through the **`/admin/posts` board** (per-platform status, push, copy-caption, asset downloads). What's left to make it autonomous:

- **Render-capable Spinup profile.** Software-GL (SwiftShader) is viable (~1.45× Metal, no GPU needed); needs a render rootfs (Chromium + SwiftShader / Mesa / fonts + ffmpeg), likely >1 vCPU, and a check against the per-run cap. **Open question:** how the agent gets the `packages/video` kit, since Spinup has no persistence — fresh checkout per run, a prebuilt image, or a published package?
- **Autonomous trigger — the enrich step is live (commit `05a3f81`).** The enrichment-analysis agent runs on Spinup (hermes harness; `analyze-track` is a self-contained skill, no repo checkout — ffmpeg + the `fluncle` CLI bound), and the Worker fires its async `runs.create` on track-add: admin-gated, Worker-only, via `@getspinup/sdk` (inline `await`, since this TanStack version doesn't expose Cloudflare's `ctx.waitUntil`; sets `enrichmentStatus: processing`). Extending the chain to **render → publish** is the remaining autonomy, gated on the render-capable Spinup profile above.
- **Reconciliation.** Recording an outcome by hand works for any post now — the status endpoint **upserts** (PR #14), so a manually-published or cross-environment post can be marked `published` (with the live URL) even without a prior draft row. Still open: the **automatic** version — an hourly check matching recent posts to the `fluncle://<log-id>` marker and flipping `social_posts.status` itself, observed not hand-entered.
- **More platforms — YouTube done, the autopilot-ready channel; Instagram closed.** YouTube Shorts ships now (PR #13): a direct public upload (title + caption + `cover.jpg` thumbnail) via the per-platform push, recorded in `social_posts`. Because it needs **no manual finish** (unlike TikTok's in-app official sound), YouTube is the one channel that can run **fully on autopilot** — once the autonomous trigger above chains enrich → render → publish, YouTube publishes hands-off with nothing left for the human. (Flagged, not urgent.) Instagram is **intentionally not automated**: there's no legitimate API audio path (the master gets muted on a business/creator account, and IG's licensed audio is app-only), so it stays a manual in-app post. Per-platform doctrine lives in `docs/track-lifecycle.md` (Phase 3) + the `fluncle-publish` skill.

### Brand & canon

- **Moodboard → canon audit (video-side remainder)** — the web overhaul resolved the web half (the logbook plate, ignition hovers, the grain architecture, and the archive grammar are in DESIGN.md now). Still open per concept: whether the video-kit proofs (texture families' full grammar, vehicle grammar, One-Sun-through-the-vehicle) get promoted into canon or stay video-local; cross-link, don't duplicate.

### Link the log pages where hyperlinks exist

Every finding now has a permanent URL (`https://www.fluncle.com/log/<log-id>`) — surfaces that can carry real links should use it: the Friday newsletter (per-track links to the log page instead of/alongside Spotify), Telegram posts (a quiet log-page link under the banger), and CLI/SSH output where a URL prints. TikTok captions stay bare-coordinate (`fluncle://<id>`) on purpose — no hyperlinks there, and the coordinate-to-site retrieval is the AEO play.

### Newsletter agent (Spinup)

The Friday newsletter agent ([docs/newsletter-agent.md](./newsletter-agent.md)) is configured on Spinup (slug `fluncle-s-newsletter-97bwtd`, hermes harness, `~anthropic/claude-haiku-latest`) and produces a complete draft: it reads the discovery window from `/api/tracks`, groups the finds by galaxy (Solar → Nebular → Lunar → Astral; unplaced finds under "Also found"), gathers scene tidbits via firecrawl, and stages a Loops campaign. **The send stays a manual operator step by design — Loops has no programmatic campaign-send (CLI / SDK / API / docs all confirm; dashboard-only), so this is not a gap to close.** Remaining: confirm the Friday cadence, and keep enough findings tagged (see the vibe-placement item) that the galaxy grouping isn't all "Also found."

### Vibe-placement model (auto-tag the map)

Findings are grouped by **vibe**, not sub-genre — the admin tagging tool (shipped; [docs/admin-tagging.md](./admin-tagging.md)) places each one on a 2-axis map stored as a coordinate: `vibe_x` = Light↔Dark mood, `vibe_y` = Floaty↔Driving energy; the quadrant is the finding's galaxy (Solar / Nebular / Lunar / Astral). Those coordinates are the **training labels** for a small model that will eventually auto-place new finds.

The dataset is already self-assembling: every placed finding is a clean row of `features_json` (the spectral vector the enrichment agent already stores — `centroidHz`, `highRatio`, `midFlatness`, `onsetRate`, `subBassRatio`) → `(vibe_x, vibe_y)`. Inputs and labels are both captured today; nothing extra is needed to build it.

**Deliberately NOT auto-suggested yet.** With no trained model, any suggestion would be a hand heuristic — and pre-filling the marker would _anchor_ the operator and bias the very labels the model needs (the same imprecision we deleted with the old sub-genre `suggestTags`). Manual placement from the audio is the clean ground truth; collect that first.

The plan:

- **Revisit at ~50–100 placements.** As of 2026-06-11 there are 26 findings; the operator is labeling the backlog around 2026-06-12, so a first dataset is days away. Once there's a meaningful set, **start training a small model** `features → (vibe_x, vibe_y)` — k-nearest-neighbours over the feature vector or ridge regression is plenty at this scale (no infra needed) — and measure what accuracy is achievable with what we have. The early read tells us whether the audio features carry enough signal or whether the feature set needs widening.
- **Once a model is confident, extend the enrichment skill with it.** Add the prediction to `packages/skills/fluncle-track-enrichment` (`analyze-track.ts`) so enrichment emits a suggested `(vibe_x, vibe_y)`; the tagging tool pre-fills it and the operator **verifies/adjusts**, and those corrections feed back as active-learning data. That auto-tag-then-verify loop is the long-term win — switched on only after the clean manual labels exist.

Unnecessarily fun — that's the point.
