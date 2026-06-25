# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

## Now — the production loop is running

The add → live pipeline is operational end to end:

- **One `/admin` cockpit** — every finding is a row with its derived stage, the board split into the **Agents** lane (Last.fm · Discogs · Enrich · Context · Note · Observation · Video — what runs on its own) and the **Yours** lane (Tag · YouTube · TikTok · Mixtape — the human tail), with stage worklists and the publish controls; the old `/admin/tag` + `/admin/posts` pages folded into it. The stage grid is `board-model.ts` `STEP_DEFS`.
- **Deterministic per-finding enrichment (off the agent)** — the per-finding pipeline is `--no-agent` Hermes-box sweeps, not a Sonnet agent: `enrich` (BPM/key/spectral vector), `context-note` (Firecrawl facts → distilled prose + a `Texture:` line, now uniform across the archive), `note` (the auto-authored editorial "why", voice-gated, fill-empty-only — #141), `observation` (the recovered-audio script + the bespoke-voice render), and `backfill` (the Discogs/Last.fm catalogue sweeps). Moving the whole pipeline off the agent saves ~$20/day, and the **only agent cron left is the Friday newsletter**. All of them run live on the box today — `enrich` + `context-note` every 5 min, `note` every 10 min, `observation` hourly, `backfill` every 30 min (see _Hermes automation_).
- **Hands-off rendering** — the `fluncle-render` box cron (hourly) conducts a render of the oldest queued finding on the scale-to-zero rave-03 box.ascii box, ships it to R2, then parks the box (queue-gated, one finding per tick; a no-op when the queue is empty). Renders are now music-reactive — the signal-chain dials + the global-vs-internal motion law + the author-time composition lint shipped (see _Brand & canon → Video aliveness_).
- **Publishing** — driven from the board: YouTube Shorts hands-off (title + caption via the API), TikTok as a drafted inbox post the operator finishes in-app, with `fluncle-social-capture` flipping a captured TikTok draft → published once its URL appears. The in-app sound/cover/schedule flow and the ≤ 5-drafts/24h TikTok cadence live in the `fluncle-publish` skill.

What's left of the loop is ongoing operation, not build work. The last autonomy gap — auto-advancing render → publish so the chain runs without an operator beat between steps — lives in **Later → TikTok auto-pipeline**.

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

**2 · Async, automated** — no laptop-tap, no human; they just run (the per-finding sweeps are `--no-agent` Hermes-box crons — deterministic or one-`claude -p`-call hybrids, no Sonnet agent; all live on the box — see _Hermes automation_):

- [x] **Enrichment (Hermes box cron)** — BPM, key, and the `features_json` spectral vector. A new find lands at `enrichment_status: pending` (queue-eligible, no on-add push); the box's `fluncle-enrich` `--no-agent` cron (every 5 min, drains `admin tracks enrich --queue`) enriches it within minutes (`pending → done`, or `failed` when no preview). Spinup decommissioned (#104).
- [x] **Context note (Hermes box cron)** — the `fluncle-context-note` `--no-agent` sweep (every 5 min) triggers `context_track`; the Worker runs the Firecrawl search + the Haiku note-distill and writes the quiet `context_note` (distilled facts + a `Texture:` line). Zero LLM tokens on the box.
- [x] **Note (Hermes box cron)** — the `fluncle-note` hybrid sweep (every 10 min) auto-authors the public editorial `note` from the `context_note` fuel via one `claude -p` call (subscription auth, `copywriting-fluncle` skill), voice-gated, **fill-empty-only** so an operator note is never clobbered (#141).
- [x] **Observation (Hermes box cron)** — the `fluncle-observation` hybrid sweep (hourly) `claude -p`-authors the recovered-audio script, then the Worker voice-gates + renders the cloned Cartesia voice to R2.
- [x] **Render (Hermes box cron)** — the hourly `fluncle-render` conductor wakes the scale-to-zero rave-03 box.ascii box, renders the oldest queued finding, uploads to R2, and parks the box; idle when the queue is empty. See _Now → Hands-off rendering_.

**3 · The manual tail** — what still needs a hand, roughly in order, and where each one automates:

- [ ] **Tag** the vibe (`vibe_x`/`vibe_y` → galaxy) on the board. The head of the tail — the one subjective placement everything downstream leans on. Automates via the _Vibe-placement model_ (gated on ~50–100 labels).
- [ ] **Note** the editorial "why". The auto-note now drafts a first pass per finding (§2 above, fill-empty-only); the operator still verifies/edits, and those edits grow the corpus. A richer vibe-neighbour version is downstream of the vibe model — see _Auto-drafted finding notes_.
- [ ] **YouTube** Shorts — the operator triggers the push today (the upload itself is hands-off: title + caption). Goes fully auto when the render → publish auto-advance lands — the one channel that needs no in-app finish. See _Later → TikTok auto-pipeline → More platforms_.
- [ ] **TikTok** — drafted to the inbox from the board; the operator finishes in-app (attach the official sound, publish), then `fluncle-social-capture` flips the captured draft → published on its own. Manual by design — no legitimate API audio path. The last per-finding beat. See _Later → TikTok auto-pipeline_.
- [ ] **Newsletter (Friday)** — the Hermes Friday cron (the one agent cron left) drafts the weekly edition and persists it (finds grouped by galaxy, scene tidbits via Firecrawl), but the **send is an operator tap** on a Discord Send/Hold button (`send_edition` is operator-tier — the agent token 403s, so the cron never auto-sends). The one weekly-cadence step; everything above it is per-finding. See _Later → Newsletter — open follow-ups_.

**4 · Deferred (on purpose)** — a surface we could reach but are choosing to leave dark for now:

- **Instagram** (`@fluncle`) — the account exists, but we're not posting yet. The music-licensing exposure isn't worth it: there's no legitimate API audio path (the master gets muted on a business/creator account, and IG's licensed audio is app-only), so it would mean either silent clips or manual in-app posts under that licensing risk. Parked, not closed. See _Later → TikTok auto-pipeline → More platforms_.

**The shape:** one human add → instant parallel fan-out to ~10 surfaces → a deterministic async pipeline (enrich, context, note, observation, render — off the agent) → a shrinking manual tail. Of that tail, tag falls to the vibe model and YouTube to the render → publish auto-advance; TikTok and the Friday newsletter send stay deliberate human taps, each blocked by an external platform limit, not by us.

## Next — surface what we make, and tidy reliability

### From Earth to Orbit — the factory arc (the big next feature)

The marquee next build, and unusually grounded for a vision — it's connective tissue over systems that already exist. Source brainstorm: [docs/factory-to-orbit-brief.md](./factory-to-orbit-brief.md) (non-canonical; code + canon win on conflict). It makes Fluncle's currently-invisible lifecycle **the product** — a finding's life, made playable: **Found** (on Earth) → **assembled** (the Factory line) → **launched** (into orbit) → **collected** (in the Galaxy). Three views of one world, joined by the finding travelling through them and the `@fluncle/sprites` system as the shared visual language; the `launch` generalizes the Earth→`/galaxy` rocket bridge so every finished finding makes that trip.

Phased so the standalone win ships first and the hard, account-touching parts come later — each later phase behind a go/no-go, and **collection deliberately decoupled from public accounts**:

- **1 · Public `/factory` page — the goal, and it stands completely alone.** A full-screen, left-to-right conveyor where a finding rides a **station per lifecycle stage** (intake → spectrograph → press → recording booth → render bay → dispatch dock → address printer → launch pad), each a distinct sprite-system machine. The state is **real, not faked**: each finding's belt position derives from the same enrichment/publish fields `/status` and the admin board already read (exposed on `/api/tracks`, likely via one tidy `/api/factory` view). **Queues are the point** — findings pile up in front of the slow stations, so the render/enrich backlog becomes physical and honest. **Poll-first** (`/api/tracks`, near-realtime, zero new infra); graduate to a Durable-Object WebSocket only if true push earns it. Independent of sprite generation and accounts. Ship it **scruffy but real** — a proven near-realtime sync is the bar, then iterate hard on feel; expect a lot of it. The design risk here is **canon, not data**: the public app is quiet and cover-led and a moving conveyor is busy by nature, so execute calm (slow, dark, one warm light per station, no dashboard chrome — the way `/earth` already holds the register).
- **2 · Per-track sprite generation — gated on a spike.** An automation that mints a unique pixel sprite per finding (seed: cover art + the vibe placement / four galaxies). This is the one place we want **variety inside the consistency** — and that's exactly the hard, unproven problem: AI generation converges on a shared attractor, so a ~10-sprite spike must prove real variety that still reads as one family **before** the arc commits to it.
- **3 · Collectable sprites in the Galaxy game — private collection.** Each finding becomes a star/sprite you fly to and **collect**, plus a binder-style collection page (empty outlines that fill in on collect). This rides the **existing** private account layer + the Log-ID-keyed progress store (`apps/web/src/game/progress.ts`) — **collection is independent of public accounts**; it works with what ships today.
- **4 · Public accounts + profiles — an optional later flip.** Only if shareable public collections earn it; gated on the Public marginalia RFC (see _User accounts_). Not a prerequisite for anything above.

### Hermes automation — the box crons (live)

The Hermes box is the queue-driven runner for the per-finding pipeline, and the cutover is **complete (2026-06-23)** — every per-finding cron runs `--no-agent` on the box, with only the Friday newsletter still an agent job. The source of truth is `docs/agents/hermes/cron/` (`jobs.json` for the agent jobs, `scripts/` for the `--no-agent` sweeps); the operator manages them on the devbox via the **fluncle-hermes-operator** skill (`hermes cron create/edit …`). Operating doc + roles: [docs/agents/hermes-agent.md](./agents/hermes-agent.md).

The crons running on the box:

- **`fluncle-context-note`** (`--no-agent`, `every 5m`) — drains the no-context queue (`admin tracks context --queue`) and triggers `context_track` per finding. The Worker runs the Firecrawl search + the Haiku note-distill (#129) + the quiet `context_note` write, so the box only triggers (zero LLM tokens on the box). Idempotent per finding. Source: `scripts/context-sweep.{sh,ts}`.
- **`fluncle-note`** (hybrid `--no-agent`, `every 10m`) — auto-authors the public editorial `note` from the `context_note` fuel via one `claude -p` call (subscription auth, `copywriting-fluncle` skill), voice-gated, **fill-empty-only** (never clobbers an operator note — #141, `docs/agents/note-agent.md`). Source: `scripts/note-sweep.{sh,ts}`.
- **`fluncle-observation`** (hybrid `--no-agent`, `every 60m`) — a deterministic queue/gather/deliver sweep with ONE `claude -p` authoring step in the middle (Claude Code, subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`, read-only tools + the `copywriting-fluncle` skill — zero OpenRouter tokens). Drains `admin tracks observe --queue`, reads each finding's metadata (`track get`), `claude -p` authors the recovered-audio script, then `observe --script-file` posts it for the Worker to voice-gate + render (the cloned Cartesia voice, R2 upload). Cap 3/tick (paid renders). Replaces the old full-agent observation cron. Source: `scripts/observe-sweep.{sh,ts}`.
- **`fluncle-backfill`** (`--no-agent`, `every 30m`) — paces the two Worker-side catalogue backfills (Discogs resolve + Last.fm love), the Worker carrying the per-finding reliability state + Retry-After backoff. See _Catalogue backfills_ below.
- **`fluncle-render`** (`--no-agent` conductor, `every 60m`) — the video render conductor: the Hermes box has no GPU, so it wakes the scale-to-zero `box.ascii` render box (rave-03), triggers a detached `@fluncle-video` render of the oldest queued finding _there_ via a remote `claude -p`, ships it to R2 (sets `video_url`), then parks the box. One render at a time; never posts to social (agent-scoped token → publish routes 403). Source: `scripts/render-conductor.sh` + `provision-rave-03.sh` + `render-detached.sh`.
- **`fluncle-social-capture`** (`--no-agent`, `every 10m`, #182) — one `curl` POST to the agent-tier `capture_post_urls`; the Worker drains the "pushed but no public URL" backlog across YouTube + TikTok (poll Postiz's `/missing`, build each permalink from the native content id, record `url`, link the release-id), flipping a captured TikTok inbox draft `draft` → `published`. Idempotent. Source: `scripts/social-capture-sweep.sh`.
- **`fluncle-newsletter`** (agent, `0 15 * * 5`, Europe/Amsterdam box clock) — authors + persists the Friday edition, then offers the operator a Discord Send/Hold button (persist-then-offer; never auto-sends).

Spinup is gone and `fluncle-render` was wired 2026-06-24; ongoing operation is a verify pass per job, not build work. Two Hermes follow-ups stay separate from the cron wiring:

- **Agent CLI self-update (the version-notice half is done).** The `fluncle` CLI already prints an "update available" notice when it's behind the published npm version (#48, `apps/cli/src/update-notifier.ts`) — a plain win for npm/brew users. The open half is Hermes-specific: guide the agent in `SOUL.md` to update itself when it sees the notice, so the box tracks releases without a manual rebuild. First confirm whether this is even needed — the `fluncle-pin-watch` host timer already re-bakes the pinned box CLI on a `main` change (the pull-model rebuild), which may make a runtime in-container self-update moot.
- **Non-root-in-container (defense-in-depth, low priority).** Run the agent as a non-root user with the token out of its readable env. Now that the token is `agent`-scoped this no longer guards the publish boundary — it only protects the agent's own surface and the token value from a fully-compromised agent, plus hardens against a container escape. Worth doing before any wider/public allow-list; not a blocker for the current private/trusted setup.

### Catalogue backfills — drain the small back-catalogue (monitoring)

The per-finding enrichments fire **going forward** only — a new add gets enriched, observed, and music-graph-resolved on its way through. The existing catalogue is drained by the `fluncle-backfill` cron (built + wired + running + rate-limit-hardened — #119, c870140): the two Worker-paced sweeps (Discogs resolve + Last.fm love), the reliability columns that gate already-done rows, and Retry-After backoff so a 429 cools down instead of storming. What's left here is just **watching the small catalogue drain** — confirm each pipeline's back-catalogue empties out and stays empty. (If album-art → R2 ingestion ships, it rides the same sweep shape.)

### Observation pipeline — reliability + shape

Two finetunes on the same pipeline / column-family — group them; both run against accumulated real notes.

- **Expose the empty-context retry path. (Resolved.)** The `context_status` marker (`pending` / `resolved` / `empty` / `failed`) shipped (#129, `schema.ts contextStatus`, migration 0032): a confirmed-empty Firecrawl fetch is distinct from never-attempted, the status-aware queue skips `empty`/`resolved`, and the server-side `retryEmptyContext` flag (`tracks.ts`, threaded through the `admin-tracks` oRPC contract + tests) widens the net. The widen pass is now **operationally reachable**: `--retry-empty` on `fluncle admin tracks context --queue` (threaded `contextQueueCommand` → `retryEmptyContext` query param, focused test in `admin-tracks.test.ts`) and the on-box context sweep (`scripts/context-sweep.{sh,ts}` — `RETRY_EMPTY=1` / a `--retry-empty` arg widens step 1; routine 60m cron unchanged, a separate rarely-fired cron carries the flag). A rare "facts may have appeared upstream" pass can now actually be triggered.
- **Context-notes shape finetune.** A tuning pass on the distill prompt (`observation.ts distilContextNote`) against accumulated real notes — which Firecrawl facts are worth keeping, how the distilled prose + the one-line `Texture:` shape reads, and how cleanly it fuels a grounded observation script (a noisy note makes a worse spoken observation). The distill + Texture shape is live (#129/#136); this is the quality pass on top of it.

### Audio observation — voice-guide finetune

The pipeline is live and proven end to end (first render: `020.0.5L` — Ownglow "Do U?", a real grounded observation on its `/log` page); the bespoke Fluncle voice is live (id in `observation.ts`). What remains is **script craft**, not the voice itself:

- **Finetune the Recovered-audio voice guide.** Tighten the writing guide for the _spoken_ observation: the arc (sensory → mood → connection → log ID → artist/title), line length and pacing for a heard surface (a clunky line can't be skimmed past), how hard the cosmos-sauce should ride out loud, never naming earthly geography, and where "too purple" begins. Fold Maurice's notes from the real renders back into the `copywriting-fluncle` voice reference (`packages/skills/copywriting-fluncle`) + `observation-agent.md`. (SSML is no longer a lever — `<break>` tokens were stripped (#150); Cartesia paces on punctuation now.)

### Optimize web playback — mobile win VERIFIED (2026-06-25)

The playback layer is in place: every R2 footage file is under Cloudflare's 100 MB transform ceiling (watch the pipeline's CRF doesn't drift back up — the largest sit close to ~95 MB), and `apps/web/src/lib/media.ts` serves same-zone Media Transformation renditions (a 360/480/720/1080 width ladder via `videoRendition`, plus the squared-master `videoCrop` centre-crops) + a cheap `mode=frame` poster (`videoPoster`), with a one-shot `onError` fallback to the raw master.

**The before/after measurement is done and the win holds** (full numbers + methodology: [docs/scratch/mobile-playback-measurement.md](./scratch/mobile-playback-measurement.md)) — a throttled-mobile (DevTools Slow-4G / Fast-4G, 390×844 dpr3, cache off) capture on live prod across two squared findings (`020.0.5L`, `020.2.3D`) and both surfaces (`/log`, Stories). The MT rendition is the lighter, faster path on every axis: the **1080 portrait crop is ~50–62% of the raw master's wire weight** (e.g. 51.6 MB vs 82.95 MB for `020.0.5L`), and a smaller pane rung drops it far further (the 720 crop is ~10 MB). The **MT `mode=frame` poster paints the first visual in ~0.7 s / ~134 KB on Fast-4G** (~4 s on Slow-4G), so the pane is never blank. And the rendition reaches a **playable video frame ~34% faster than the raw master** at Fast-4G (2 943 ms vs 4 478 ms for `020.0.5L`) — the master's bigger 1920² frames need more leading bytes to decode. The poster-first + deferred-fetch + range-stream design verified on real throttled mobile.

One **honest caveat the data surfaced**, and the only remaining thread: **`/log` mobile requests the native 1080×1920 crop regardless of pane size** (`log-footage.tsx` calls `videoCrop(logId, "portrait")` with no width, unlike Stories which passes the measured `renditionWidth`). At 1080 over a true 400 Kbps link the clip is too heavy to decode a frame inside 100 s, and the stall watchdog makes it worse by bailing the slow-but-progressing crop to the even-heavier master. Nothing is broken (the poster carries the visual; Fast-4G is fine), but the muted loop is effectively dormant on the slowest connections. The small, well-scoped fix — have `/log` mobile pass a pane-sized ladder rung (the 720 crop is ~5× lighter) the way Stories already does, and revisit the watchdog's bail-to-master on a constrained link — is captured in the scratch doc's follow-up. That's an optimization, not a blocker; the verify-the-win item itself is **closed**.

Re-ship purge is **solved** (#152): a re-render now purges the stale transform renditions (not just the master), and the `?v=N` versioned `footage.mp4` source in `media.ts` already forces an instant flip when an immediate cut is needed — so replacing a clip at the same key no longer strands listeners on the old rendition.

### Log IDs in search + AI answers (AEO/GEO) — off-site thread

The on-site layer shipped (per-finding `/log/<id>` pages with definitional prose + `MusicRecording` identifiers, the `/log` index, sitemap enumeration, the `/about` entity/FAQ surface, one canonical description everywhere). What remains is off-site and slower:

- **AI crawlers: verified allowed (2026-06-11), keep the regression check.** The dashboard confirms verified AI crawlers pass (ClaudeBot 24 allowed requests, 38 crawls answered 200, the sitemap the most-crawled path); the earlier 403s were Cloudflare's spoof-detection rejecting fake-UA probes, not a block. Managed robots.txt is OFF. Still worth a recurring check of the live `/robots.txt` + the AI Crawl Control crawler policies (Cloudflare can re-flip defaults silently).
- **Submit + monitor.** Sitemap submitted to GSC and Bing (2026-06-11), and IndexNow auto-submission shipped (#168 — `indexnow.ts`, the key-file route, and the `publish.ts` fan-out POST each finding's `/log/<id>` to Bing + Yandex on publish, so the Bing/Yandex half is now hands-off; Google still rides the GSC sitemap). Watch the _set_ of log pages move to Indexed (count ≈ archive size); verify bare-token retrieval (`004.7.2I`, `fluncle://004.7.2I`) lands the log page. Check Fluncle is present in Brave Search. **First retrieval confirmed (2026-06-17), faster than the "weeks-out" estimate:** a bare `"004.6.0Q"` Google query returns the owned `fluncle.com/log` surface (#2), the YouTube Short caption (#1, with the coordinate + `Found Jun 3` rendered verbatim), and the gate-screen OG card (`packages/media`) in Images — within ~3 days of publish. Remaining granular milestones: the per-finding `/log/<id>` pages moving to Indexed in GSC (today the bare coordinate lands the `/log` _index_, not yet the individual page), and confirming an individual page ranks for its own coordinate. Indexing and AI citation are still ongoing outcomes — monitoring, not ship gates.
- **Video indexing confirmed (2026-06-22).** Google indexed its first Fluncle footage video — `/log/004.1.9E`'s `VideoObject` structured data (video URL `found.fluncle.com/004.1.9E/footage.mp4`), crawled Jun 17, now surfacing in the GSC Video-indexing report. The on-site video-SEO layer is live end to end: findings can now appear in Google Video search and as video thumbnails, a third indexing axis (text → image → video). 1 of N today (only that page re-crawled so far); the rest fill in as the `/log` pages are re-crawled.
- **Third-party corroboration: the anchors exist (2026-06-11).** MusicBrainz artist `53346748-1357-45c0-a847-9d248b65d655` (Person, homepage/TikTok/Telegram links) and Wikidata item `Q140169844` (instance of human, official website, MusicBrainz artist ID, TikTok + Telegram usernames); both are in the `/about` `sameAs` set. Remaining: authentic presence where dnb lives (r/DnB and friends — participate, don't fabricate), and enrich the Wikidata item as facts accumulate.

### Developer & discovery surfaces — the long tail

The machine- and developer-facing surfaces mapped in [docs/surfaces-doctrine.md](./surfaces-doctrine.md) (dig, versioned contract-first API, the Fumadocs `/docs` hub, feeds, CLI distribution, SSH deep-links) are live. What's open:

- **The non-gating tail:** the `today` dig label, a public changelog, a Docker image, broader data-graph anchors (Discogs, Last.fm, ListenBrainz), and directory listings (Product Hunt, Internet Archive, a Hugging Face dataset). Each becomes a registry entry in [docs/surfaces-doctrine.md](./surfaces-doctrine.md) when one earns its keep.

### Fluncle Lens (Chrome extension) — submitted, in review

Fluncle Lens (`apps/extension`) — an MV3 extension that detects `fluncle://<coord>` Log IDs anywhere on the web and turns each into a link to its `/log/<coord>` page — was **submitted to the Chrome Web Store and is in compliance review** (2026-06-21). It's the first browser surface riding the Log ID spine. The `<all_urls>` content-script match triggers a **"Broad Host Permissions" in-depth review** — expected and justified (a coordinate can appear on any page), so the review runs long by design. Listing specifics (category Entertainment, privacy policy at the real `/privacy` route, the bundle/icon/screenshot pointers, and the privacy-form answers that recur on every version update) are captured operator-side.

Open:

- **Post-approval announce + fan-out.** When it clears review, fold it into the surface map — a quiet line to the crew (Telegram / the Friday letter), a mention on `/about` and the `/docs` developer surfaces. It's a net-new public surface the autonomy-ladder §1 fan-out list doesn't yet name. Pre-stage it as a `@fluncle/registry` surface entry ready to flip the moment it goes live (so /status, the homepage dev-row, llms.txt, and the sitemap all light up at once — see the `fluncle-surfaces` runbook).
- **Future features.** Beyond Log-ID linkification, any richer Lens behaviour is open-ended — translate ideas into Fluncle's terms when picked up (canon wins per `AGENTS.md`; the source brainstorm leaned on banned words like "signals").
- **Run-from-source meanwhile.** Pre-approval Maurice is the only user, running it unpacked from `apps/extension/dist/` — fine until it's live; the store build is `bun run --cwd apps/extension bundle`.

### Tor `.onion` surfaces — web onion LIVE, SSH onion deferred

The Fluncle web onion is **live** on the rave VPS — a web onion proxying `www.fluncle.com` (carrying API/RSS/MCP as free riders), gated on `WEB_ONION_HOSTNAME`, with the `Onion-Location` header surfacing the ".onion available" pill in Tor Browser and a Cloudflare WAF/IP bypass so the proxy's origin fetch isn't blocked. Deployment shape + key custody: `docs/tor.md`. What's open:

- **The rave SSH onion (deferred).** A second onion identity → the SSH terminal was scoped but deferred; stand it up if the flex earns its keep.

### Database latency — evaluate Turso → Cloudflare D1

Turso (libSQL) is the source of truth, hosted in **Ireland**, so every Worker→DB read pays a cross-region hop — a real chunk of the `/log/<id>` ~896 ms cold TTFB (the Worker runs at the edge near the reader; the database doesn't). Cloudflare-native **D1** co-locates with Workers and would shrink that roundtrip. The catch is migration cost: D1 is SQLite with its own ceilings (database-size and write-throughput limits, no libSQL-only features), and the whole Drizzle data layer, migration history, and the per-worktree local-dev story (`turso dev` + `.dev/local.db`, see `docs/local-database.md`) would move with it — a real arc, not a config flip.

The near-term cheaper win already shipped — **edge-caching the `/log` HTML** (short TTL + stale-while-revalidate + purge-on-change, #41) takes the cross-region hop off the hot read path for cached pages. That makes D1 the **deeper** structural lever, not the next one: pursue it only when DB latency (not render time or asset weight) is the proven bottleneck on the paths the edge cache doesn't cover. Spike it first — confirm D1's limits fit the catalogue and access patterns, and that nothing in the current libSQL usage is load-bearing — before committing to the migration.

### radio.fluncle.com — LIVE

`radio.fluncle.com` is **live** as a **synchronized broadcast** — a shared clock + fast offset-join (#115), with clock-driven advance, boundary hysteresis, self-heal, and mute (#117); sync-verified on real devices. It plays each eligible finding's clean square master (MT-cropped to landscape on desktop / portrait on mobile, audio stripped) under its observation audio, every listener on the same schedule rather than each cycling its own. Reliability is hardened since launch: the atomic A/V sync controller + wake lock (#171) kill the double-start / desync, a tuning-in loading gate holds the full-screen takeover until the stream is ready (#184), and center-stage live-narration captions (#149) join the synced word-level observation subtitles (#140) — an accessibility + dwell win, last-word-stays-lit anti-strobe, WCAG AA. The shared media-loading stall watchdog also landed (#151, `use-video-recovery.ts` re-arms on a healthy-or-bounded window, capped by `MAX_RECOVERY_ATTEMPTS`); watch for recurrence on flaky cellular. Eligibility = `video_squared_at AND observation_audio_url`; the station fills out as the observation backfill runs (see _Catalogue backfills_).

Radio is now surfaced on the homepage too — the nav reorder (#185) gives it a first-class "listen" home (the Playlist + Radio pair), a "For the nerds" dev-surface group, a masthead Join-the-Crew, and a live status pill, so the menu no longer buries it.

### Fluncle's own mixtapes — open follow-ups

The mixtape spine, the `/admin/mixtapes` editor + on-the-fly covers, and the `fluncle admin mixtapes distribute` autopublish (video→YouTube + audio→Mixcloud on our own OAuth, mint-first) are all live. Runbook + spine model: **[packages/skills/fluncle-mixtapes](../packages/skills/fluncle-mixtapes)**. What's open:

- **Off-site (low priority).** Keep enriching Wikidata `Q140169844` as facts accumulate (the MusicBrainz DJ-mix release [`fc818504`](https://musicbrainz.org/release/fc818504-6c01-4565-be1e-d1b3657f8a7c)) — tracked in the off-site thread above.
- **SoundCloud + the MusicBrainz/Wikidata loop** stay manual by design.

Out of scope until needed: a teaser-clip-of-a-mixtape pipeline, and the Galaxy-game checkpoint body at the mixtape's sector.

### TikTok audio line-up (build only when a track breaks)

On standby — most relevant during the content backlog. The video is beat-matched to a Deezer/iTunes 30s preview (a fixed mid-song segment); TikTok's attachable sound is usually — not always — the song's first ~60s, trimmable to any start within the span it exposes. When the preview segment isn't reachable there and the track has no obvious section to line up by ear, the visuals pulse to beats that aren't playing. **Stage 0 (now):** by-ear line-up. **Stage 1 (on break):** full-track audio for analysis only via Apify `apidojo/youtube-scraper` (stream URL → ffmpeg → analyze → discard, never stored or served). **Stage 2:** pick the best ~20s window inside the first ~55s, render to it, write the absolute start offset into `render.json` + surface it ("start the sound at 0:42"). Audio policy: YouTube audio is internal-analysis-only; published audio uses official previews. AcousticBrainz-by-ISRC is frozen (~2022/24), so it is not a BPM fallback for new tracks.

### YouTube thumbnails — decided: leave them (2026-06-23)

We're **not** setting custom YouTube thumbnails — YouTube's auto-picked frame from each bespoke-shader video looks **better** than a flat `cover.jpg` plate, the grid reading as a varied, alive wall of cosmic visuals a static plate would only flatten. Decided and done; the dead thumbnail-upload branch in `pushYouTubeShort` (`apps/web/src/lib/server/postiz.ts`) has been removed — the function is now honest about pushing only title + caption and setting no thumbnail.

## Later — the bigger arcs

### Live on Twitch — the "on the decks" callout across surfaces (pulled forward)

The arc Maurice wants pulled forward. When Maurice goes live on Twitch to mix, the Galaxy should light up: a live callout that fans out across the surfaces while the stream is on and clears itself the moment it ends. The one loud moment in an otherwise quiet, cover-led product — Fluncle's in the booth, the crew gathers, then it's gone. Twitch presence is already wired (`twitchUrl` in `fluncle-links`, the home social row, the entity `sameAs`, the `docs/socials/` map); this is the live-state layer on top. The scheduled-ahead half also shipped: `/calendar.ics` publishes any mixtape's `plannedFor` as a Twitch-linked VEVENT (subscribe before it happens), so what remains here is specifically the **live-now** callout, not the calendar.

The shape:

- **Detect live state.** Twitch Helix `Get Streams` (`?user_login=fluncle`) polled on a Worker cron, or — better, push not poll — an **EventSub** subscription to `stream.online` / `stream.offline` hitting a Worker webhook. Store a small transient "live" flag (KV or a row) with the stream title/start; surfaces read it, and `stream.offline` (or a poll miss) clears it so nothing goes stale.
- **Fan out, then auto-clear.** A tasteful banner/callout on the web home + feed (quiet, dark, reduced-motion-safe — the calm aesthetic holds, this is the _one_ allowed loud beat), a ping to the crew on Telegram (a "live now" message with the watch link, pinned for the duration), and a line in the dry surfaces (the CLI `recent` header / the SSH MOTD). Every surface reads the same flag; when it flips off, every callout disappears on its own.
- **Voice.** In-fiction as "on the decks" / "live in the booth" / "rinsing a set live" — never "transmission", "signal", or "stream" as identity (the banned set in VOICE); "live" as the literal Twitch state is fine. Dry and warm, the crew addressed directly; the callout brags as little as the rest of the copy.

Gated on nothing structural — it's net-new surface plumbing, sized as a single arc when live mixing becomes a regular thing.

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

The spine (the Log ID) already runs across surfaces, and most of the reframe has landed — the `/log/<id>` pages (the log as object — observation, recovered artifact, related logs) and the RSS observation feed (`log_id` guid) ship, the site is an archive you browse as well as a feed you scroll, and the **canon surgery has landed** across PRODUCT.md (the co-primary log/observation thesis), VOICE.md + the `copywriting-fluncle` voice reference (the Depth-Gradient refit — "transmission"/"signal" retired, "recovered"/"sector"/"archive" adopted), and DESIGN.md (the log-page grammar). What's still genuinely open:

- **Discord as a log surface (deferred).** A Discord representation of the log spine — the one surface from the identity map not yet stood up; pick it up if it earns its keep.

### Fluncle's Galaxy — the game (v1 live)

v1 is live at [galaxy.fluncle.com](https://galaxy.fluncle.com) (same Worker, `/galaxy` route): behind-the-ship 8-bit flight where every banger is a star at its Log ID coordinate. The world is data-driven — stars, set-dressing, hazards, and projectiles are one typed `Entity` model with a per-kind behavior table (`game/types.ts` + `sim.ts`) — and the black-hole teleport network, asteroid waves + auto-clearing laser, the amen-break intro, and the gate-screen OG image (`packages/media`) all ride it; every hazard routes through the fuel economy, the dry-tank tow stays the one true failure. Shares the Log ID spine with the logbook reframe, and is the same sim the SSH version reuses. What's ahead:

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
- **Multiplayer — a shared galaxy (idea, 2026-06-24 scribble)** — open the single-pilot universe to the crew: other players' dots on the **radar** in your sector, their trails / recently-flown **tracks**, and a sense of which stars are **popular** (most-visited across everyone) so the catalogue's hotspots show on the map. Each pilot picks a **custom spaceship** from a small palette (the scribble guessed ~5 colours). Ties to **persistence / accounts** (identity + a shared-state layer) and reuses the existing radar. A big social direction — unscoped; capture-for-later, picked up once the single-player frontier is polished.

**SSH version (the flex)** — live at `ssh rave.fluncle.com`: a Go port of the sim (`apps/ssh/internal/galaxy`) kept in lockstep with the JS source by parity tests (`apps/web/src/game/parity-fixtures.test.ts`), the same _sim_ inside the terminal — top-down scope renderer, the read-the-log orbit card with an OSC-8 Spotify link, audio-less as flavor, telemetry in the deepest Depth-Gradient register. Map knowledge is portable across surfaces — the Log ID spine paying off. Remaining are named fast-follows: SSH experience polish, QR / Kitty-input / ambient-crew.

**Persistence:** web private accounts now sync lifetime Galaxy progress (`me-galaxy.ts` + `game/progress.ts`) without changing active-run cargo; anonymous play stays first-class. The only remainder — cross-surface SSH/CLI login for synced markers — is tracked once under _User accounts → Cross-surface account login_, not duplicated here.

### User accounts

The private web account layer is live (Better Auth email/password + username, `/account`, private Galaxy lifetime progress, saved findings, signed-in submission ownership, export/delete, durable rate limits, hard separation from admin auth). Anonymous browse, submit, RSS, MCP, CLI, SSH, and Galaxy play stay unchanged. Follow-ups, deliberately separate from that first slice:

- **Cross-surface account login:** CLI/SSH device login for synced Galaxy lifetime markers, saved findings, and own submissions. User tokens must stay separate from `FLUNCLE_API_TOKEN`, and SSH stays anonymous by default.
- **Authenticated MCP tools:** only if there is a concrete agent use case; keep the existing MCP server/card anonymous until a dedicated auth contract, CORS/header behavior, and failure model exist.
- **Public marginalia RFC:** public crew cards, public submission credit, crew notes, reports, moderation, and profile-like surfaces need their own RFC before implementation. Hard default remains no public writing.
- **Email/password hardening:** decide verification/reset policy, abuse thresholds, disposable-email handling, and support copy once real usage shows the pressure points.
- **Account ops polish:** keep the account env vars prominent (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`) and do a real-data privacy pass on export/delete after a few accounts exist.

### Public feature-ideas inbox — a voteable backlog (idea, 2026-06-24 scribble)

A public, voteable ideas board: visitors / the crew submit feature ideas and **upvote** the ones they want, turning this private roadmap into a public-facing signal of what to build next (the Canny / public-roadmap pattern). Reuses the existing **submission-inbox** shape (the track-submission flow is the precedent) but for ideas, with vote counts ranking the backlog. It is **public writing**, so it inherits the open questions under _User accounts → Public marginalia RFC_: moderation / abuse, **anonymous vs account-gated voting** (one vote per identity), spam, and the no-public-writing default it would deliberately relax. Unscoped capture-for-later — would want that RFC first.

### TikTok auto-pipeline (the capstone)

"Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com` and the system enriches → renders → captions → pushes a draft automatically; the human steps stay manual on purpose (attach the official sound, finish, publish). Most of the chain now runs on its own — enrichment is the `fluncle-enrich` box cron, server-side render landed as the `fluncle-render` conductor (rave-03 box.ascii), and `fluncle-social-capture` flips a captured TikTok draft → published. What's left to make it fully autonomous:

- **Auto-advance render → publish.** The render and publish steps each run on their own now, but a finding still needs an operator beat between them — render fires on its hourly tick, then the push is triggered separately from the board. Close the gap so a freshly-rendered finding auto-advances into the publish push (YouTube hands-off, TikTok to the inbox draft) without a human tap between the steps — the chain running end to end on its own.
- **More platforms — YouTube done, the autopilot-ready channel; Instagram closed.** YouTube Shorts ships now (PR #13): a direct public upload (title + caption) via the per-platform push, recorded in `social_posts`. Because it needs **no manual finish** (unlike TikTok's in-app official sound), YouTube is the one channel that can run **fully on autopilot** — once the auto-advance above chains render → publish, YouTube publishes hands-off with nothing left for the human. (Flagged, not urgent.) Instagram is **deferred — not posting yet** (the `@fluncle` account exists, but the music-licensing exposure isn't worth it for now): there's no legitimate API audio path (the master gets muted on a business/creator account, and IG's licensed audio is app-only), so it would mean silent clips or manual in-app posts under that risk. Parked, not closed; see the autonomy ladder's _Deferred_ group. Per-platform doctrine lives in `docs/track-lifecycle.md` (Phase 3) + the `fluncle-publish` skill.

### Fluncle Studio — clip a set, auto-distribute the clips

The mixtape is the one fully-manual capstone: Maurice goes live on Twitch, records the set, and distributes it — video → YouTube, audio → Mixcloud + SoundCloud (already partly automated via the `fluncle-mixtapes` skill). The **next big slice** turns that one long set into many short posts: a **"Fluncle Studio"** `/admin` page that takes a full rendered video (a mixtape set, or any clip source) and cuts **clips** from it — pick in/out points, frame the vertical crop, caption — then **auto-distributes** them to socials (Instagram first, via **Postiz**, which supports it; other platforms follow). It is the clipping + distribution layer the archive doesn't have yet — today the set lives as one object and there is no clipping item.

This extends the "Yours → Agents" migration one more step: clip-farming a set is currently a fully-manual act with no tooling. Caveats to carry in when it's picked up — the **Instagram music-licensing** exposure noted under _TikTok auto-pipeline → More platforms_ (a DJ set still carries the tracks' copyright, so short-clip framing or accepting the risk is an operator call), and the clip pipeline should reuse the `packages/video` ship/transform machinery (the two-master + Cloudflare Media Transformations model) rather than reinventing the encode. For now this is a placeholder — the slice itself is unscoped.

### Brand & canon

- **Moodboard → canon audit (video-side remainder)** — the web overhaul resolved the web half (the logbook plate, ignition hovers, the grain architecture, and the archive grammar are in DESIGN.md now). Still open per concept: whether the video-kit proofs (texture families' full grammar, vehicle grammar, One-Sun-through-the-vehicle) get promoted into canon or stay video-local; cross-link, don't duplicate.
- **Video aliveness — shipped.** Part I landed (`9d12806`): music-reactive renders via the signal-chain dials + the global-vs-internal motion law + an author-time composition lint; the proposed Part II (an LLM judge in the render loop) was prototyped and dropped; grain diversity shipped (#145 — six grain families, the `video_grain` ledger column, the skill doctrine).

### Newsletter — open follow-ups

The Friday newsletter ([docs/agents/newsletter-agent.md](./agents/newsletter-agent.md)) is authored + persisted by the `fluncle-newsletter` Hermes cron (see _Hermes automation_), with the editions model (#102) persisting each edition's content at draft time, the galaxy grouping (#124), the public `/newsletter` archive + `/newsletter/<n>` edition pages (#130), and the `/admin/newsletter` operator front-end (#130/#132) all live. What's open:

- **Confirm the Friday cadence** on a real tick — the cron is live, so this is a monitoring item: watch one real Friday 15:00 Amsterdam run to confirm it fires, authors only on a non-empty window, and re-offers an unsent draft rather than double-authoring.
- **Keep findings tagged.** The galaxy grouping (Solar → Nebular → Lunar → Astral, `editions.ts GALAXY_ORDER`) is only as full as the Tag step — its coverage depends on findings carrying a vibe placement, so it rides the _Vibe-placement model_ item rather than standing alone; an untagged finding falls to "Also found."
- **Spine-native edition page (the deeper remainder).** The `/newsletter` archive + per-edition pages ship (#130); what's still open is making an edition **spine-native like a mixtape** — a marked Log ID, a `/log/<id>` edition page, and quiet feed / RSS inclusion — so an edition is a finding-shaped object in the Galaxy, not just an archived email. The persisted payload is the clean source to render it from.
- **Newsletter cron output polish.** Tighten the `jobs.json` step-7 `clarify` summary to the exact "Drafted _<subject>_ — N tracks + M mixtapes, send pending" line, with an explicit "don't dump reasoning to the channel" rail (the cron was observed delivering its raw chain-of-thought on the 2026-06-22 manual trigger; the Send button stays for the live Friday context). Also confirm the Firecrawl scene-`tidbits` populate on a real tick — they came back empty on the first run (the email renders fine without them, but they're the extra scene color).

### Vibe-placement model (auto-tag the map)

Findings are grouped by **vibe**, not sub-genre — the admin tagging tool (shipped; [docs/admin-tagging.md](./admin-tagging.md)) places each one on a 2-axis map stored as a coordinate: `vibe_x` = Light↔Dark mood, `vibe_y` = Floaty↔Driving energy; the quadrant is the finding's galaxy (Solar / Nebular / Lunar / Astral). Those coordinates are the **training labels** for a small model that will eventually auto-place new finds.

The dataset is already self-assembling: every placed finding is a clean row of `features_json` (the spectral vector the enrichment agent already stores — `centroidHz`, `highRatio`, `midFlatness`, `onsetRate`, `subBassRatio`) → `(vibe_x, vibe_y)`. Inputs and labels are both captured today; nothing extra is needed to build it.

**Deliberately NOT auto-suggested yet.** With no trained model, any suggestion would be a hand heuristic — and pre-filling the marker would _anchor_ the operator and bias the very labels the model needs (the same imprecision we deleted with the old sub-genre `suggestTags`). Manual placement from the audio is the clean ground truth; collect that first.

The plan:

- **Revisit at ~50–100 placements.** As of 2026-06-11 there are 26 findings; the operator is labeling the backlog around 2026-06-12, so a first dataset is days away. Once there's a meaningful set, **start training a small model** `features → (vibe_x, vibe_y)` — k-nearest-neighbours over the feature vector or ridge regression is plenty at this scale (no infra needed) — and measure what accuracy is achievable with what we have. The early read tells us whether the audio features carry enough signal or whether the feature set needs widening.
- **Once a model is confident, extend the enrichment skill with it.** Add the prediction to `packages/skills/fluncle-track-enrichment` (`analyze-track.ts`) so enrichment emits a suggested `(vibe_x, vibe_y)`; the tagging tool pre-fills it and the operator **verifies/adjusts**, and those corrections feed back as active-learning data. That auto-tag-then-verify loop is the long-term win — switched on only after the clean manual labels exist.

Unnecessarily fun — that's the point.

### Auto-drafted finding notes — v1 shipped, the vibe-neighbour refinement open

The board takes an optional **note** per finding — the editorial "why" that renders on the `/log/<id>` page and feeds its definitional prose + `MusicRecording` schema, so a note is real SEO/AEO value, not just operator chrome. **The v1 auto-note shipped (#141, `docs/agents/note-agent.md`):** a context-note-grounded first pass authored by one `claude -p` call (subscription auth, `copywriting-fluncle` voice), voice-gated, **fill-empty-only** so an operator note is never clobbered, running as the `fluncle-note` box cron. The operator still verifies/edits, and those edits grow the corpus. What remains here is the richer **vibe-neighbour** version below — layering the notes of a finding's nearest neighbours in vibe space _into_ the live context-grounded generation (not replacing it), a longer-term autonomous refinement gated on the vibe-placement model.

The notes encode Maurice's **subjective** read — where he placed the finding on the vibe map, how it sits in its galaxy — not its objective spectral numbers. So the neighbours to draw from must be nearest in **vibe** (the placed `vibe_x`/`vibe_y`, same galaxy), NOT in `features_json`: two tracks can measure nearly identical yet land in different galaxies by feel, and a feature-twin's note would carry the wrong vibe. That is why this is **downstream of the vibe-placement model above** — a new finding needs a vibe coordinate before it has vibe-neighbours, and in the autonomous chain that coordinate comes from the model (features → predicted `vibe_x`/`vibe_y`). The features are the model's input; the note's neighbours live in the vibe space the model produces.

The shape: enrich → the vibe model places the finding → pull the notes of its **nearest neighbours in vibe space** (closest `vibe_x`/`vibe_y`, same galaxy) → the agent synthesizes a fresh, finding-specific note grounded in the galaxy's character and the audio (driving-dark Nebular vs floaty-light Lunar; the BPM, key, texture), in Fluncle's voice via the `copywriting-fluncle` skill → the operator verifies and edits, and that edit grows the corpus. Guardrails: the cluster informs but never templates (the same anti-sameness discipline as the parallel-render attractor — a note that reads like every other note in its galaxy is worse than none), never fabricate scene history or facts, and only draft when there's real signal; the note stays optional, so silence beats a generic line.

Gated on the **vibe-placement model** (for the coordinate) and a **notes corpus** to draw from (the board's note column is filling it now). Lives in `packages/skills/fluncle-track-enrichment` alongside the `(vibe_x, vibe_y)` prediction. (A finding that's already manually tagged has its coordinate now, so the neighbour-in-vibe approach can be prototyped on the current set before the model lands — just not autonomously.)

The v1 shipped because the clean distilled `context_note` (firecrawl facts + the `Texture:` line) is a strong input that sidesteps the vibe-model gate: the context note supplies the FACTUAL spine the old soup-notes never could (label, scene, character), the galaxy/vibe placement keeps it subjective rather than generic fact-recitation, and the copywriting skill keeps it on-brand. The vibe-neighbour model stays the longer-term autonomous refinement on top of it.
