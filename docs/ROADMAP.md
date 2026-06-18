# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

## Now — the production loop is running

The add → live pipeline is operational end to end:

- **One `/admin` cockpit** — every finding is a row with its derived stage (Enrich · Tag · YouTube · TikTok), stage worklists, and the publish controls; the old `/admin/tag` + `/admin/posts` pages folded into it.
- **Hands-off rendering** — a Claude scheduled **routine** ("Fluncle video queue") fires hourly on the Mac, films exactly the oldest queued finding end to end with the `fluncle-video` skill, then stops (queue-gated, one finding per tick; a no-op when the queue is empty or the laptop's asleep). The backlog is essentially full — 25 of 26 findings have a clip.
- **Publishing** — driven from the board: YouTube Shorts hands-off (title + caption + `cover.jpg` thumbnail via the API), TikTok as a drafted inbox post the operator finishes in-app. The in-app sound/cover/schedule flow and the ≤ 5-drafts/24h TikTok cadence live in the `fluncle-publish` skill.

What's left of the loop is ongoing operation, not build work. The fully-autonomous, server-side version — chaining enrich → render → publish without the laptop in the loop — lives in **Later → TikTok auto-pipeline**.

### The autonomy ladder

The full path a finding travels, top to bottom: one human act, then how far it propagates on its own. `[x]` = automated today, `[ ]` = a manual/operator step (some manual by design, like the add and TikTok). A final group is **deferred** — surfaces we could reach but deliberately leave dark for now (no box, because nothing happens there yet).

**0 · Find + add** — the one irreducible human act ("Maurice discovers, Fluncle does the rest"):

- [ ] Maurice finds the banger and adds it (`fluncle admin add`, the `/admin` board, or `ssh rave.fluncle.com`). Manual by design — this is the whole point.

**1 · Synchronous fan-out** — instant, the moment the Worker writes the finding and assigns its Log ID it is everywhere the spine reaches:

- [x] **Spotify** — added to the Fluncle's Findings playlist
- [x] **Telegram** — posted to the crew channel
- [x] **Web** — live in the feed and at its `/log/<id>` page
- [x] **CLI** — `fluncle recent`, `fluncle log <id>`
- [x] **API** — `/api/tracks`, `/api/tracks/<idOrLogId>`
- [x] **MCP** — the Model Context Protocol server
- [x] **RSS** — `/rss.xml`, the observation feed
- [x] **SSH rave terminal** — `ssh rave.fluncle.com`
- [x] **Galaxy game (web)** — a collectible star at its Log ID coordinate
- [x] **Galaxy game (SSH)** — the same star in the terminal galaxy

**2 · Async, automated** — no laptop-tap, no human; they just run:

- [x] **Enrichment (Spinup)** — BPM, key, and the `features_json` spectral vector; fired on add (`enrichmentStatus: processing → done`). See _Later → TikTok auto-pipeline → Autonomous trigger_.
- [x] **Render (local Claude routine)** — the hourly "Fluncle video queue" films the oldest queued finding end to end and uploads to R2; idle when the queue is empty. See _Now → Hands-off rendering_.

**3 · The manual tail** — what still needs a hand, roughly in order, and where each one automates:

- [ ] **Tag** the vibe (`vibe_x`/`vibe_y` → galaxy) on the board. Automates via the _Vibe-placement model_ (gated on ~50–100 labels).
- [ ] **Note** the editorial "why". Automates via _Auto-drafted finding notes_ (downstream of the vibe model + a notes corpus).
- [ ] **YouTube** Shorts — the operator triggers the push today (the upload itself is hands-off: title + caption + `cover.jpg` thumbnail). Goes fully auto when the server-side chain extends — the one channel that needs no in-app finish. See _Later → TikTok auto-pipeline → More platforms_.
- [ ] **TikTok** — drafted to the inbox from the board; the operator finishes in-app (attach the official sound, publish). Manual by design — no legitimate API audio path. The last per-finding beat. See _Later → TikTok auto-pipeline_.
- [ ] **Newsletter (Friday)** — the Spinup agent drafts the weekly letter on its own (finds grouped by galaxy, scene tidbits via firecrawl), but the **send is a manual tap** in Loops (no campaign-send API). The one weekly-cadence step; everything above it is per-finding. See _Later → Newsletter agent_.

**4 · Deferred (on purpose)** — a surface we could reach but are choosing to leave dark for now:

- **Instagram** (`@fluncle`) — the account exists, but we're not posting yet. The music-licensing exposure isn't worth it: there's no legitimate API audio path (the master gets muted on a business/creator account, and IG's licensed audio is app-only), so it would mean either silent clips or manual in-app posts under that licensing risk. Parked, not closed. See _Later → TikTok auto-pipeline → More platforms_.

**The shape:** one human add → instant parallel fan-out to ~10 surfaces → two automated async agents (enrich, render) → a shrinking manual tail. Of that tail, tag + note fall to the vibe model and YouTube to the server-side chain; TikTok and the Friday newsletter send stay deliberate human taps, each blocked by an external platform limit, not by us.

## Next — surface what we make, and tidy reliability

### Log IDs in search + AI answers (AEO/GEO) — off-site thread

The on-site layer shipped (per-finding `/log/<id>` pages with definitional prose + `MusicRecording` identifiers, the `/log` index, sitemap enumeration, the `/about` entity/FAQ surface, one canonical description everywhere). What remains is off-site and slower:

- **AI crawlers: verified allowed (2026-06-11), keep the regression check.** The dashboard confirms verified AI crawlers pass (ClaudeBot 24 allowed requests, 38 crawls answered 200, the sitemap the most-crawled path); the earlier 403s were Cloudflare's spoof-detection rejecting fake-UA probes, not a block. Managed robots.txt is OFF. Still worth a recurring check of the live `/robots.txt` + the AI Crawl Control crawler policies (Cloudflare can re-flip defaults silently).
- **Submit + monitor.** Sitemap submitted to GSC and Bing (2026-06-11); watch the _set_ of log pages move to Indexed (count ≈ archive size); verify bare-token retrieval (`004.7.2I`, `fluncle://004.7.2I`) lands the log page. Check Fluncle is present in Brave Search. **First retrieval confirmed (2026-06-17), faster than the "weeks-out" estimate:** a bare `"004.6.0Q"` Google query returns the owned `fluncle.com/log` surface (#2), the YouTube Short caption (#1, with the coordinate + `Found Jun 3` rendered verbatim), and the gate-screen OG card (`packages/media`) in Images — within ~3 days of publish. Remaining granular milestones: the per-finding `/log/<id>` pages moving to Indexed in GSC (today the bare coordinate lands the `/log` _index_, not yet the individual page), and confirming an individual page ranks for its own coordinate. Indexing and AI citation are still ongoing outcomes — monitoring, not ship gates.
- **Third-party corroboration: the anchors exist (2026-06-11).** MusicBrainz artist `53346748-1357-45c0-a847-9d248b65d655` (Person, homepage/TikTok/Telegram links) and Wikidata item `Q140169844` (instance of human, official website, MusicBrainz artist ID, TikTok + Telegram usernames); both are in the `/about` `sameAs` set. Remaining: authentic presence where dnb lives (r/DnB and friends — participate, don't fabricate), and enrich the Wikidata item as facts accumulate.

### Fluncle's own mixes — moved to a runbook

The DJ-mixtape plan graduated into a dedicated runbook + spine model: **[docs/fluncle-mixtapes-runbook.md](./fluncle-mixtapes-runbook.md)**. A mixtape is now scoped as a **spine-native object**, not just outbound links — Fluncle dreaming (findings consolidated into one long recording, a checkpoint closing a chapter; to outsiders just a mixtape, to the crew a glimpse into his subconscious), with its own Log ID (same `XXX.Y.ZZ` format, the literal `F` marker plus a mixtape number, e.g. `019.F.1A`), a `/log/<id>` page, a dedicated `/mixtapes` surface, quiet inclusion in the track surfaces, mixtape-aware schema/RSS/llms.txt (`DJMixAlbum`), and fan-out across the surfaces (web/CLI/API/RSS/MCP/SSH), plus the Mixcloud/YouTube/SoundCloud hosting, the tracklist-as-breadcrumb, and the MusicBrainz DJ-mix release → Wikidata loop. First set recorded 2026-06-18 (record + archive only); publishing follows the build there.

### Private preview archive — move to a non-public bucket

Shipped (PR #6): enrichment stores the exact official 30s preview used for the feature vector at an operator-only path (`analysis/previews/<log-id>/<sha256>.<ext>`), excluded from every public DTO/UI/RSS/sitemap and from `/api/preview` (public playback stays live-only: stored Deezer → refreshed-by-ISRC → iTunes, `Cache-Control: no-store`; R2 is never the playback source). **Open follow-up:** it currently lives in the public `fluncle-videos` bucket, so its privacy rests only on the unguessable key — move it to a dedicated **non-public** R2 bucket before relying on it as training input. The columns stay inert until the first archive write, so there's runway. (Training consumer: the vibe-placement model below.)

### TikTok audio line-up (build only when a track breaks)

On standby — most relevant during the content backlog. The video is beat-matched to a Deezer/iTunes 30s preview (a fixed mid-song segment); TikTok's attachable sound is usually — not always — the song's first ~60s, trimmable to any start within the span it exposes. When the preview segment isn't reachable there and the track has no obvious section to line up by ear, the visuals pulse to beats that aren't playing. **Stage 0 (now):** by-ear line-up. **Stage 1 (on break):** full-track audio for analysis only via Apify `apidojo/youtube-scraper` (stream URL → ffmpeg → analyze → discard, never stored or served). **Stage 2:** pick the best ~20s window inside the first ~55s, render to it, write the absolute start offset into `render.json` + surface it ("start the sound at 0:42"). Audio policy: YouTube audio is internal-analysis-only; published audio uses official previews. AcousticBrainz-by-ISRC is frozen (~2022/24), so it is not a BPM fallback for new tracks.

### Optimize web playback (clips are all transform-eligible now)

Re-rendering the oversized clips is **done** — every R2 footage file, with-audio and silent, is under Cloudflare's 100 MB transform ceiling (verified 2026-06-17; largest ~95 MB, a few sit close so watch the pipeline's CRF doesn't drift back up). The core playback layer also shipped: `apps/web/src/lib/media.ts` serves same-zone Media Transformation renditions (a 360/480/720/1080 width ladder via `videoRendition`) + a cheap `mode=frame` poster (`videoPoster`), with a one-shot `onError` fallback to the raw master.

What's left is playback polish on `apps/web` (the feed + Stories player): lazy-load clips below the fold, range/HLS streaming for the Stories player instead of whole-file fetches, and a real before/after measurement on a mobile connection.

Re-ship caveat (for the content-backlog loop too): replacing a clip at the same `<log-id>/footage.mp4` key needs the transform renditions purged, not just the master — they cache under separate keys, and purge propagation lags per-colo (the `mode=frame` poster clears slower than the `mode=video` rendition, so check from the affected location before assuming it's stuck). To force an instant flip, version the transform source in `media.ts` (`?v=N` on the `footage.mp4` source).

### Per-log-page OG images (Remotion, from the video posters)

Each `/log/<id>` link preview currently uses the bare Spotify album cover (`og:image = track.albumImageUrl ?? coverUrl` in `log.$logId.tsx`). Two pieces already exist to do better: we render OG cards with Remotion in `packages/media` (the Galaxy gate-screen card), and we expose a per-finding video-poster frame (`videoPoster`, `mode=frame`, in `media.ts`). Compose them — a per-finding OG card that drops the finding's own video-poster frame into the Fluncle treatment (the FLUNCLE'S FINDINGS plate, the Log ID, `Artist — Title`, the Found date), so every shared log page gets a branded, alive preview pulled from the clip we made, not a generic cover. Doubles as AEO fuel: the gate-screen OG card already indexes in Google Images (see the off-site thread), so a per-finding card carries the coordinate into image search too. Small: one new `packages/media` composition + point the log page's `og:image`/`twitter:image` at it. Open question — render on demand (a Worker route) vs bake at enrich time (store the PNG in R2 next to `cover.jpg`); baking fits the existing enrichment chain and avoids per-request render cost.

### SoundCloud profile — basic presence

Two `@fluncle` SoundClouds exist: the main `soundcloud.com/fluncle` (the clean URL — cosmonaut avatar and "Fluncle" name already set) and a bare auto-suffixed duplicate `soundcloud.com/fluncle-646915409`. The profile is up: `/fluncle` has the cosmonaut avatar, the generated header (`docs/socials/banners/soundcloud.png`, 2480×520), and the canonical bio with the site link — wired into the home social row and the entity `sameAs` on-site, and recorded in the `docs/socials/` map (sign-in `hey@fluncle.com`). Remaining, operator-side: resolve the bare duplicate `fluncle-646915409` (consolidate on `/fluncle`), and add the reciprocal off-site anchors so the identity graph links both ways — the **SoundCloud ID** property (`P3040` = `fluncle`) on Wikidata `Q140169844`, and a **SoundCloud URL relationship** on the MusicBrainz artist. Profile presence only; hosting actual audio there is the separate, licensing-gated question the [mixtapes runbook](./fluncle-mixtapes-runbook.md) owns (SoundCloud is a takedown-risk secondary mirror). Small, manual, no code.

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

**SSH version (the flex)** — **landed in code and deployed live (PR #13)**. The approach pivoted: instead of compiling `sim.ts` to WASM (Javy/QuickJS → wazero), the SSH galaxy is a **Go port** of the sim (`apps/ssh/internal/galaxy` — engine/placement/projection) kept in lockstep by **parity tests** against the JS source (`apps/web/src/game/parity-fixtures.test.ts` + testdata), wired into the terminal (`screenGalaxy` / `handleGalaxyKey` in `apps/ssh/main.go`). The same _sim_ inside `ssh rave.fluncle.com`, then: a top-down scope renderer, the read-the-log orbit card with an OSC-8 Spotify link, audio-less as flavor ("the audio didn't survive the trip out here — it's still playing back on Earth"), telemetry in the deepest Depth-Gradient register taken from the shipped strings ("Pulled under. Flung across the galaxy." · "Home, junglist."). Map knowledge is portable across surfaces — the Log ID spine paying off. The working Go port + parity harness resolve the old PASS/KILL spikes (SSH input latency; the engine model) and the "confirm realtime input + frame rate" question. **Deployed and live at `rave.fluncle.com` (2026-06-17)** — the Minimum Lovable galaxy shipped whole, the same _sim_ inside the terminal. Remaining are named fast-follows: SSH experience polish, QR / Kitty-input / ambient-crew.

**Persistence:** a player's collected bangers want to survive a refresh — that's the user-accounts item below; session-only until then.

### User accounts

Persistent per-user state — the thing that unlocks saved progress (e.g. a player's collected bangers in the Galaxy game), and likely personalization elsewhere. Out of scope for any current MVP; called out here so features that _want_ persistence (the game, future surfaces) have a known home to defer to rather than half-building it inline.

### TikTok auto-pipeline (the capstone) + Spinup automation

"Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com` and the system enriches → renders → captions → pushes a draft automatically; the human steps stay manual on purpose (attach the official sound, finish, publish). The draft-publishing layer runs today by hand — now through the **`/admin` board** (per-platform status, push, copy-caption, asset downloads). What's left to make it autonomous:

- **Render: Superset on the laptop now, Spinup later.** Rendering runs hands-off via the hourly **Superset Automation** on the MacBook (see Now → "Hands-off rendering") — too heavyweight for Spinup today, and the laptop's GPU is free. The fully-server-side **render-capable Spinup profile** stays deferred: software-GL (SwiftShader) is viable (~1.45× Metal, no GPU needed) but needs a render rootfs (Chromium + SwiftShader / Mesa / fonts + ffmpeg), likely >1 vCPU, a check against the per-run cap, and an answer to how an ephemeral agent gets the `packages/video` kit (fresh checkout per run, a prebuilt image, or a published package). Pursue it only when laptop-bound rendering becomes the bottleneck.
- **Autonomous trigger — the enrich step is live (commit `05a3f81`).** The enrichment-analysis agent runs on Spinup (hermes harness; `analyze-track` is a self-contained skill, no repo checkout — ffmpeg + the `fluncle` CLI bound), and the Worker fires its async `runs.create` on track-add: admin-gated, Worker-only, via `@getspinup/sdk` (inline `await`, since this TanStack version doesn't expose Cloudflare's `ctx.waitUntil`; sets `enrichmentStatus: processing`). Extending the chain to **render → publish** is the remaining autonomy, gated on the render-capable Spinup profile above.
- **Reconciliation.** Recording an outcome by hand works for any post now — the status endpoint **upserts** (PR #14), so a manually-published or cross-environment post can be marked `published` (with the live URL) even without a prior draft row. Still open: the **automatic** version — an hourly check matching recent posts to the `fluncle://<log-id>` marker and flipping `social_posts.status` itself, observed not hand-entered.
- **More platforms — YouTube done, the autopilot-ready channel; Instagram closed.** YouTube Shorts ships now (PR #13): a direct public upload (title + caption + `cover.jpg` thumbnail) via the per-platform push, recorded in `social_posts`. Because it needs **no manual finish** (unlike TikTok's in-app official sound), YouTube is the one channel that can run **fully on autopilot** — once the autonomous trigger above chains enrich → render → publish, YouTube publishes hands-off with nothing left for the human. (Flagged, not urgent.) Instagram is **deferred — not posting yet** (the `@fluncle` account exists, but the music-licensing exposure isn't worth it for now): there's no legitimate API audio path (the master gets muted on a business/creator account, and IG's licensed audio is app-only), so it would mean silent clips or manual in-app posts under that risk. Parked, not closed; see the autonomy ladder's _Deferred_ group. Per-platform doctrine lives in `docs/track-lifecycle.md` (Phase 3) + the `fluncle-publish` skill.

### Brand & canon

- **Moodboard → canon audit (video-side remainder)** — the web overhaul resolved the web half (the logbook plate, ignition hovers, the grain architecture, and the archive grammar are in DESIGN.md now). Still open per concept: whether the video-kit proofs (texture families' full grammar, vehicle grammar, One-Sun-through-the-vehicle) get promoted into canon or stay video-local; cross-link, don't duplicate.

### Tone of voice — who narrates the Galaxy (kill the entity-copy ghost)

A deep ToV pass triggered by a line that doesn't land: `fluncleDescription`'s closer "It all comes home to fluncle.com." Two robots hide in it, and they're systemic, not local. **(1) The faceless narrator.** The entity strings are third-person ("Fluncle digs and certifies every track, logs each as a finding…") — spoken by a brand-voice ghost that is neither Fluncle (canon says he speaks as "I") nor Maurice (behind the curtain). Warm or cosmic verbs bolted onto that ghost ("comes home", "strings the full archive across the Galaxy") read as greeting-card narration, not the uncle. **(2) The grandiosity.** Those same verbs break the Dry Rule — the copy emoting where Fluncle is understated. Fluncle's warmth lives in dryness, specifics, and the address to the crew, never in sentimental cosmic verbs. Lesson to codify once resolved: _warm words on a faceless, third-person sentence = greeting-card robot._

This is one decision that cascades to all entity/description copy: the meta + OG, the `MusicRecording`/`WebSite` JSON-LD, `llms.txt`, `/about`, link previews, and every `/log/<id>` page's `definitionalProse` (also third-person ghost today — "Fluncle filed it under the Nebular galaxy… The coordinate names this finding…"). The master question: **who narrates?** With a real canon tension behind it — the **Depth Gradient** ("fully in-fiction on every surface, the warm web included") pushes first-person Fluncle even into machine-facing JSON-LD, while SEO entity-recognition wants a parseable third-person "Fluncle is a [X] that [Y]". The current strings split the difference, which is exactly what manufactures the ghost. Pick a lane:

1. **First-person, dry** — Fluncle speaks ("I dig them up, certify the ones that hit, and log every find… it's all at fluncle.com"); warmth from specifics + dryness, in-fiction everywhere. Boldest, most him; least conventional for a `<meta>` snippet.
2. **First-person, to the crew** — he speaks AND addresses "you", with the findings-sent-back-across-the-Galaxy canon ("…then send the lot back to you across the Galaxy. Dig in at fluncle.com"). Warmest.
3. **Third-person, honestly plain** — keep third person for machines but stop faking warmth; let it be cleanly factual. Cures the ghost by not asking a robot line to feel.
4. **Split by surface** — plain third-person factual for machines (meta/JSON-LD); first-person Fluncle for human surfaces (About, link previews, home). Two strings to maintain; each honest in context.

When picked: decide the Depth-Gradient-vs-machine question explicitly in VOICE.md (the narrator rule), rewrite `fluncleDescription` (+ the trimmed meta variant) across all 7 carriers (identity.ts source + README, SKILL.md, voice.md §7, manifest, llms.txt, agent-discovery.ts) and `definitionalProse`, and fold the "no faceless warmth / Fluncle's warmth is dry" rule into the `copywriting-fluncle` voice canon. Until then the current strings stand as a known-imperfect placeholder. (A mechanical scrub script + an editorial anti-AI-tell pass for the skill was prototyped this round and pulled back out — premature before the narrator lane is settled; revisit it as a companion once this is decided.)

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

### Auto-drafted finding notes (the enrichment agent's editorial pass)

The board now takes an optional **note** per finding — the editorial "why" that renders on the `/log/<id>` page and feeds its definitional prose + `MusicRecording` schema, so a note is real SEO/AEO value, not just operator chrome. Writing one per finding by hand is the bottleneck, and the agent can take a first pass.

The notes encode Maurice's **subjective** read — where he placed the finding on the vibe map, how it sits in its galaxy — not its objective spectral numbers. So the neighbours to draw from must be nearest in **vibe** (the placed `vibe_x`/`vibe_y`, same galaxy), NOT in `features_json`: two tracks can measure nearly identical yet land in different galaxies by feel, and a feature-twin's note would carry the wrong vibe. That is why this is **downstream of the vibe-placement model above** — a new finding needs a vibe coordinate before it has vibe-neighbours, and in the autonomous chain that coordinate comes from the model (features → predicted `vibe_x`/`vibe_y`). The features are the model's input; the note's neighbours live in the vibe space the model produces.

The shape: enrich → the vibe model places the finding → pull the notes of its **nearest neighbours in vibe space** (closest `vibe_x`/`vibe_y`, same galaxy) → the agent synthesizes a fresh, finding-specific note grounded in the galaxy's character and the audio (driving-dark Nebular vs floaty-light Lunar; the BPM, key, texture), in Fluncle's voice via the `copywriting-fluncle` skill → the operator verifies and edits, and that edit grows the corpus. Guardrails: the cluster informs but never templates (the same anti-sameness discipline as the parallel-render attractor — a note that reads like every other note in its galaxy is worse than none), never fabricate scene history or facts, and only draft when there's real signal; the note stays optional, so silence beats a generic line.

Gated on the **vibe-placement model** (for the coordinate) and a **notes corpus** to draw from (the board's note column is filling it now). Lives in `packages/skills/fluncle-track-enrichment` alongside the `(vibe_x, vibe_y)` prediction. (A finding that's already manually tagged has its coordinate now, so the neighbour-in-vibe approach can be prototyped on the current set before the model lands — just not autonomously.)
