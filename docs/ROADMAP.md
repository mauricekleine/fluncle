# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

## Now — the production loop is running

The add → live pipeline is operational end to end:

- **One `/admin` cockpit** — every finding is a row with its derived stage, the board split into the **Agents** lane (Last.fm · Discogs · Enrich · Context · Note · Observation · Video — what runs on its own) and the **Yours** lane (Tag · YouTube · TikTok · Mixtape — the human tail), with stage worklists and the publish controls; the old `/admin/tag` + `/admin/posts` pages folded into it. The stage grid is `board-model.ts` `STEP_DEFS`.
- **Deterministic per-finding enrichment (off the agent)** — the per-finding pipeline is `--no-agent` Hermes-box sweeps, not a Sonnet agent: `enrich` (BPM/key/spectral vector), `context-note` (Firecrawl facts → distilled prose + a `Texture:` line, now uniform across the archive), `note` (the auto-authored editorial "why", voice-gated, fill-empty-only — #141), `observation` (the recovered-audio script + the bespoke-voice render), and `backfill` (the Discogs/Last.fm catalogue sweeps). Moving the whole pipeline off the agent saves ~$20/day, and the **only agent cron left is the Friday newsletter**. All of them run live on the box today — `enrich` + `context-note` every 5 min, `note` every 10 min, `observation` hourly, `backfill` every 30 min (see _Hermes automation_).
- **Hands-off rendering** — a Claude scheduled **routine** ("Fluncle video queue") fires hourly on the Mac, films exactly the oldest queued finding end to end with the `fluncle-video` skill, then stops (queue-gated, one finding per tick; a no-op when the queue is empty or the laptop's asleep). Renders are now music-reactive — the signal-chain dials + the global-vs-internal motion law + the author-time composition lint shipped (see _Brand & canon → Video aliveness_).
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

**2 · Async, automated** — no laptop-tap, no human; they just run (the per-finding sweeps are `--no-agent` Hermes-box crons — deterministic or one-`claude -p`-call hybrids, no Sonnet agent; all live on the box — see _Hermes automation_):

- [x] **Enrichment (Hermes box cron)** — BPM, key, and the `features_json` spectral vector. A new find lands at `enrichment_status: pending` (queue-eligible, no on-add push); the box's `fluncle-enrich` `--no-agent` cron (every 5 min, drains `admin tracks enrich --queue`) enriches it within minutes (`pending → done`, or `failed` when no preview). Spinup decommissioned (#104).
- [x] **Context note (Hermes box cron)** — the `fluncle-context-note` `--no-agent` sweep (every 5 min) triggers `context_track`; the Worker runs the Firecrawl search + the Haiku note-distill and writes the quiet `context_note` (distilled facts + a `Texture:` line). Zero LLM tokens on the box.
- [x] **Note (Hermes box cron)** — the `fluncle-note` hybrid sweep (every 10 min) auto-authors the public editorial `note` from the `context_note` fuel via one `claude -p` call (subscription auth, `copywriting-fluncle` skill), voice-gated, **fill-empty-only** so an operator note is never clobbered (#141).
- [x] **Observation (Hermes box cron)** — the `fluncle-observation` hybrid sweep (hourly) `claude -p`-authors the recovered-audio script, then the Worker voice-gates + renders the bespoke ElevenLabs voice to R2.
- [x] **Render (local Claude routine)** — the hourly "Fluncle video queue" films the oldest queued finding end to end and uploads to R2; idle when the queue is empty. See _Now → Hands-off rendering_.

**3 · The manual tail** — what still needs a hand, roughly in order, and where each one automates:

- [ ] **Tag** the vibe (`vibe_x`/`vibe_y` → galaxy) on the board. The head of the tail — the one subjective placement everything downstream leans on. Automates via the _Vibe-placement model_ (gated on ~50–100 labels).
- [ ] **Note** the editorial "why". The auto-note now drafts a first pass per finding (§2 above, fill-empty-only); the operator still verifies/edits, and those edits grow the corpus. A richer vibe-neighbour version is downstream of the vibe model — see _Auto-drafted finding notes_.
- [ ] **YouTube** Shorts — the operator triggers the push today (the upload itself is hands-off: title + caption + `cover.jpg` thumbnail). Goes fully auto when the server-side chain extends — the one channel that needs no in-app finish. See _Later → TikTok auto-pipeline → More platforms_.
- [ ] **TikTok** — drafted to the inbox from the board; the operator finishes in-app (attach the official sound, publish). Manual by design — no legitimate API audio path. The last per-finding beat. See _Later → TikTok auto-pipeline_.
- [ ] **Newsletter (Friday)** — the Hermes Friday cron (the one agent cron left) drafts the weekly edition and persists it (finds grouped by galaxy, scene tidbits via Firecrawl), but the **send is an operator tap** on a Discord Send/Hold button (`send_edition` is operator-tier — the agent token 403s, so the cron never auto-sends). The one weekly-cadence step; everything above it is per-finding. See _Later → Newsletter — open follow-ups_.

**4 · Deferred (on purpose)** — a surface we could reach but are choosing to leave dark for now:

- **Instagram** (`@fluncle`) — the account exists, but we're not posting yet. The music-licensing exposure isn't worth it: there's no legitimate API audio path (the master gets muted on a business/creator account, and IG's licensed audio is app-only), so it would mean either silent clips or manual in-app posts under that licensing risk. Parked, not closed. See _Later → TikTok auto-pipeline → More platforms_.

**The shape:** one human add → instant parallel fan-out to ~10 surfaces → a deterministic async pipeline (enrich, context, note, observation, render — off the agent) → a shrinking manual tail. Of that tail, tag falls to the vibe model and YouTube to the server-side chain; TikTok and the Friday newsletter send stay deliberate human taps, each blocked by an external platform limit, not by us.

## Next — surface what we make, and tidy reliability

### Hermes automation — the box crons (live)

The Hermes box is the queue-driven runner for the per-finding pipeline, and the cutover is **complete (2026-06-23)** — every per-finding cron runs `--no-agent` on the box, with only the Friday newsletter still an agent job. The source of truth is `docs/agents/hermes/cron/` (`jobs.json` for the agent jobs, `scripts/` for the `--no-agent` sweeps); the operator manages them on the devbox via the **fluncle-hermes-operator** skill (`hermes cron create/edit …`). Operating doc + roles: [docs/agents/hermes-agent.md](./agents/hermes-agent.md).

The crons running on the box:

- **`fluncle-context-note`** (`--no-agent`, `every 5m`) — drains the no-context queue (`admin tracks context --queue`) and triggers `context_track` per finding. The Worker runs the Firecrawl search + the Haiku note-distill (#129) + the quiet `context_note` write, so the box only triggers (zero LLM tokens on the box). Idempotent per finding. Source: `scripts/context-sweep.{sh,ts}`.
- **`fluncle-note`** (hybrid `--no-agent`, `every 10m`) — auto-authors the public editorial `note` from the `context_note` fuel via one `claude -p` call (subscription auth, `copywriting-fluncle` skill), voice-gated, **fill-empty-only** (never clobbers an operator note — #141, `docs/agents/note-agent.md`). Source: `scripts/note-sweep.{sh,ts}`.
- **`fluncle-observation`** (hybrid `--no-agent`, `every 60m`) — a deterministic queue/gather/deliver sweep with ONE `claude -p` authoring step in the middle (Claude Code, subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`, read-only tools + the `copywriting-fluncle` skill — zero OpenRouter tokens). Drains `admin tracks observe --queue`, reads each finding's metadata (`track get`), `claude -p` authors the recovered-audio script, then `observe --script-file` posts it for the Worker to voice-gate + render (the bespoke ElevenLabs voice, R2 upload). Cap 3/tick (paid renders). Replaces the old full-agent observation cron. Source: `scripts/observe-sweep.{sh,ts}`.
- **`fluncle-backfill`** (`--no-agent`, `every 30m`) — paces the two Worker-side catalogue backfills (Discogs resolve + Last.fm love), the Worker carrying the per-finding reliability state + Retry-After backoff. See _Run the prepared catalogue backfills_ below.
- **`fluncle-newsletter`** (agent, `0 15 * * 5`, Europe/Amsterdam box clock) — authors + persists the Friday edition, then offers the operator a Discord Send/Hold button (persist-then-offer; never auto-sends).

This is "wire the prepared crons on the box," not "scope it" — the build landed; what remains is the operator's redeploy + cron creation, then a verify pass per job. Decommission the Spinup newsletter agent only after one good Friday edition ships from Hermes (prove-then-tear-down, the enrichment-cutover discipline).

Two Hermes follow-ups stay separate from the cron wiring:

- **CLI self-update, agent-owned.** Have the `fluncle` CLI print an "update available" notice when it's behind the published npm version, then guide the agent in `SOUL.md` to update itself when it sees the notice — so the box tracks releases without a manual rebuild/redeploy after every bump. (The version-notice is also a plain win for npm/brew users; the agent self-update is the Hermes-specific half.)
- **Non-root-in-container (defense-in-depth, low priority).** Run the agent as a non-root user with the token out of its readable env. Now that the token is `agent`-scoped this no longer guards the publish boundary — it only protects the agent's own surface and the token value from a fully-compromised agent, plus hardens against a container escape. Worth doing before any wider/public allow-list; not a blocker for the current private/trusted setup.

### Media-loading stall — videos occasionally stuck loading (radio + Stories)

A live defect on **two surfaces**: a video sometimes hangs on "loading" and never starts — seen on both `radio.fluncle.com` and the Stories player. It is **not radio-specific**; both surfaces draw their playback from the shared media layer (`apps/web/src/lib/media.ts` — the `videoRendition` / `videoCrop` Media-Transformation renditions + the one-shot `onError` fallback to the raw master), so the symptom is cross-surface and the fix likely lives there (or in how each player wires the rendition ladder + `onError`). Scope it as a media-layer reliability bug, not a radio bug: a fix on one surface should clear both. Worth a real reproduction (which width/colo/master, whether the `onError` fallback fires) before guessing.

### Run the prepared catalogue backfills

The per-finding enrichments fire **going forward** only — a new add gets enriched, observed, and music-graph-resolved on its way through. The existing catalogue (~26 findings) needs the one-time backfills run over it, which double as the **end-to-end test** that each pipeline works against real findings. The mechanism is **built and prepared** (#119): the two Worker-paced sweeps (Discogs resolve + Last.fm love), the **8 reliability columns** (`backfill_{discogs,lastfm}_{attempted_at,attempts,done_at,failures}`), Retry-After backoff so a 429 cools down instead of storming, and the agent-tier `fluncle-backfill` `--no-agent` cron that paces small bounded batches per tick. The box holds no vendor keys — the Worker does the resolves/loves, the cron only paces.

- **Last.fm loves** — sweep every published finding and `track.love` it on the `fluncle` account (love-on-add only catches new publishes). Free, fast, idempotent; gated only on the three `LASTFM_*` Worker secrets being set.
- **Discogs release IDs** — the hardened resolver (#46: MusicBrainz-first by ISRC, then a scored Discogs search with a tracklist-confirm gate, storing only ≥0.90-confidence matches). Confident matches store `in_release_id`/`in_master_id`; the rest stay **unresolved by design** (don't force them). `DISCOGS_USER_TOKEN` is set, so it runs whenever the sweep does. (A `candidates` admin-review tier for near-miss 0.7–0.9 matches is the natural follow-up if too many land unresolved.)
- **Context notes** (`context_note`) — Firecrawl-derived facts per finding, written by `context_track` (#86, the `observe-context` endpoint shipped as `context_track`). The agent now holds the facts before it writes the script, so the old "the script can't be grounded in facts" coupling is **solved** — the flow is context → script → render. The context-note fill runs as the `fluncle-context-note` cron (see _Hermes automation_).
- **Audio observations** — render the ElevenLabs observation per finding (`fluncle admin tracks observe`). Costs ElevenLabs credits, so a handful at a time; the bespoke voice is live, so renders are keepers (no re-render-after-voice gate any more). Runs as the hybrid `fluncle-observation` `--no-agent` sweep (deterministic queue/gather/deliver around one `claude -p` authoring step, subscription auth).
- **(If it ships)** album-art → R2 ingestion, same sweep shape.

The crons are **wired and running** (see _Hermes automation_); what remains here is watching the catalogue drain. Shape: idempotent, skip already-done rows (the reliability columns gate it), respect rate limits (Discogs ~60/min) and vendor cost (ElevenLabs), best-effort per finding. Needs the relevant Worker secrets set and the build deployed.

### Observation pipeline — reliability + shape

Two finetunes on the same pipeline / column-family — group them; both want to land once the observation + context crons are actually running and the behavior shows up in real data.

- **Mark empty-context findings (`context_status`).** `context_track` writes `context_note` **only on a non-empty Firecrawl result**, and the context queue is `context_note IS NULL`. So a finding with genuinely no recoverable facts stays NULL forever and the cron re-picks it every tick, re-burning the Firecrawl budget on a hopeless case — the same "never ran vs ran-and-found-nothing" conflation the `discogsStatus` column fixes for Discogs. Fix it the same way: a small `context_status` marker (`pending` / `resolved` / `empty` / `failed`) so a confirmed-empty fetch is distinct from never-attempted, routine runs skip `empty`/`resolved`, and a rare `--retry-empty` pass widens the net (facts can newly appear upstream). Internal-only (out of `TRACK_SELECT`), generated migration per `AGENTS.md`. Low-risk, deferred until the context cron is running and the cost shows up. (Verified: no `context_status` column exists today.)
- **Context-notes shape finetune.** A quality pass on _what_ `context_track` writes into `context_note` — which Firecrawl facts are worth keeping, how they're shaped, and how cleanly they fuel a grounded observation script (a noisy note makes a worse spoken observation). Same pipeline + column family as the empty-marker above, so finetune them together once real notes accumulate.

### Audio observation — voice-guide finetune

The pipeline is live and proven end to end (first render: `020.0.5L` — Ownglow "Do U?", a real grounded observation on its `/log` page); the bespoke Fluncle voice is live (id in `observation.ts`). What remains is **script craft**, not the voice itself:

- **Finetune the Recovered-audio voice guide.** Tighten the writing guide for the _spoken_ observation: the arc (sensory → mood → connection → log ID → artist/title), line length and pacing for a heard surface (a clunky line can't be skimmed past), `<break>` use (sparse only — dense breaks get vocalised as thinking sounds), how hard the cosmos-sauce should ride out loud, never naming earthly geography, and where "too purple" begins. Fold Maurice's notes from the real renders back into `observation-agent.md` + VOICE.md §5.

### Optimize web playback — verify the mobile win

The playback layer is in place: every R2 footage file is under Cloudflare's 100 MB transform ceiling (watch the pipeline's CRF doesn't drift back up — the largest sit close to ~95 MB), and `apps/web/src/lib/media.ts` serves same-zone Media Transformation renditions (a 360/480/720/1080 width ladder via `videoRendition`) + a cheap `mode=frame` poster (`videoPoster`), with a one-shot `onError` fallback to the raw master.

What's left is a real before/after measurement on a mobile connection: throttled-mobile bytes-on-load and time-to-first-frame on real glass. The playback paths are in place around it — the feed carries no video, the Stories player streams via range requests, and the log-page footage defers its fetch until it nears the viewport — so the open item is verifying the win, not building more deferral.

Re-ship caveat (for the content-backlog loop too): replacing a clip at the same `<log-id>/footage.mp4` key needs the transform renditions purged, not just the master — they cache under separate keys, and purge propagation lags per-colo (the `mode=frame` poster clears slower than the `mode=video` rendition, so check from the affected location before assuming it's stuck). To force an instant flip, version the transform source in `media.ts` (`?v=N` on the `footage.mp4` source).

### Log IDs in search + AI answers (AEO/GEO) — off-site thread

The on-site layer shipped (per-finding `/log/<id>` pages with definitional prose + `MusicRecording` identifiers, the `/log` index, sitemap enumeration, the `/about` entity/FAQ surface, one canonical description everywhere). What remains is off-site and slower:

- **AI crawlers: verified allowed (2026-06-11), keep the regression check.** The dashboard confirms verified AI crawlers pass (ClaudeBot 24 allowed requests, 38 crawls answered 200, the sitemap the most-crawled path); the earlier 403s were Cloudflare's spoof-detection rejecting fake-UA probes, not a block. Managed robots.txt is OFF. Still worth a recurring check of the live `/robots.txt` + the AI Crawl Control crawler policies (Cloudflare can re-flip defaults silently).
- **Submit + monitor.** Sitemap submitted to GSC and Bing (2026-06-11); watch the _set_ of log pages move to Indexed (count ≈ archive size); verify bare-token retrieval (`004.7.2I`, `fluncle://004.7.2I`) lands the log page. Check Fluncle is present in Brave Search. **First retrieval confirmed (2026-06-17), faster than the "weeks-out" estimate:** a bare `"004.6.0Q"` Google query returns the owned `fluncle.com/log` surface (#2), the YouTube Short caption (#1, with the coordinate + `Found Jun 3` rendered verbatim), and the gate-screen OG card (`packages/media`) in Images — within ~3 days of publish. Remaining granular milestones: the per-finding `/log/<id>` pages moving to Indexed in GSC (today the bare coordinate lands the `/log` _index_, not yet the individual page), and confirming an individual page ranks for its own coordinate. Indexing and AI citation are still ongoing outcomes — monitoring, not ship gates.
- **Video indexing confirmed (2026-06-22).** Google indexed its first Fluncle footage video — `/log/004.1.9E`'s `VideoObject` structured data (video URL `found.fluncle.com/004.1.9E/footage.mp4`), crawled Jun 17, now surfacing in the GSC Video-indexing report. The on-site video-SEO layer is live end to end: findings can now appear in Google Video search and as video thumbnails, a third indexing axis (text → image → video). 1 of N today (only that page re-crawled so far); the rest fill in as the `/log` pages are re-crawled.
- **Automate URL submission via IndexNow (open).** New findings are nudged into Bing by hand today (paste the sitemap's `/log/<id>` URLs into Webmaster Tools). IndexNow — one ping, consumed by Bing + Yandex — makes it hands-off: host a `{key}.txt` ownership file at the site root, then `POST` each finding's `/log/<id>` to the IndexNow API on **publish** (riding the existing Worker publish fan-out) and on any **sitemap change**, so the catalogue self-submits as it grows. Google doesn't use IndexNow (GSC already has the sitemap), so this closes specifically the Bing/Yandex half. Small Worker-side addition; no new infra.
- **Third-party corroboration: the anchors exist (2026-06-11).** MusicBrainz artist `53346748-1357-45c0-a847-9d248b65d655` (Person, homepage/TikTok/Telegram links) and Wikidata item `Q140169844` (instance of human, official website, MusicBrainz artist ID, TikTok + Telegram usernames); both are in the `/about` `sameAs` set. Remaining: authentic presence where dnb lives (r/DnB and friends — participate, don't fabricate), and enrich the Wikidata item as facts accumulate.

### Developer & discovery surfaces — the long tail

The machine- and developer-facing surfaces of `docs/public-surfaces-checklist.md` (dig, versioned contract-first API, the Fumadocs `/docs` hub, feeds, CLI distribution, SSH deep-links) are live. What's open:

- **OpenAPI default-error response.** The generated public spec (`/api/v1/openapi.json`) documents only the success response per op — add a shared default-error response (the uniform `{ code, message, ok: false }` 4xx/5xx the rails encoder emits) so the per-op `400`/`429` docs the old static file carried aren't lost.
- **The non-gating tail in the checklist:** the `today` dig label, a public changelog, a Docker image / Postman collection, broader data-graph anchors (Discogs, Last.fm, ListenBrainz), and directory listings (Product Hunt, Internet Archive, a Hugging Face dataset). Pick from `docs/public-surfaces-checklist.md` when one earns its keep.

### Fluncle Lens (Chrome extension) — submitted, in review

Fluncle Lens (`apps/extension`) — an MV3 extension that detects `fluncle://<coord>` Log IDs anywhere on the web and turns each into a link to its `/log/<coord>` page — was **submitted to the Chrome Web Store and is in compliance review** (2026-06-21). It's the first browser surface riding the Log ID spine. The `<all_urls>` content-script match triggers a **"Broad Host Permissions" in-depth review** — expected and justified (a coordinate can appear on any page), so the review runs long by design. Listing specifics (category Entertainment, privacy policy at the real `/privacy` route, the bundle/icon/screenshot pointers, and the privacy-form answers that recur on every version update) are captured operator-side.

Open:

- **Post-approval announce + fan-out.** When it clears review, fold it into the surface map — a quiet line to the crew (Telegram / the Friday letter), a mention on `/about` and the `/docs` developer surfaces. It's a net-new public surface the autonomy-ladder §1 fan-out list doesn't yet name.
- **Future features.** Beyond Log-ID linkification, any richer Lens behaviour is open-ended — translate ideas into Fluncle's terms when picked up (canon wins per `AGENTS.md`; the source brainstorm leaned on banned words like "signals").
- **Run-from-source meanwhile.** Pre-approval Maurice is the only user, running it unpacked from `apps/extension/dist/` — fine until it's live; the store build is `bun run --cwd apps/extension bundle`.

### Tor `.onion` surfaces — web onion LIVE, SSH onion deferred

The Fluncle web onion is **live** on the rave VPS — a web onion proxying `www.fluncle.com` (carrying API/RSS/MCP as free riders), gated on `WEB_ONION_HOSTNAME`, with the `Onion-Location` header surfacing the ".onion available" pill in Tor Browser and a Cloudflare WAF/IP bypass so the proxy's origin fetch isn't blocked. Deployment shape + key custody: `docs/tor.md`. What's open:

- **The rave SSH onion (deferred).** A second onion identity → the SSH terminal was scoped but deferred; stand it up if the flex earns its keep.

### Database latency — evaluate Turso → Cloudflare D1

Turso (libSQL) is the source of truth, hosted in **Ireland**, so every Worker→DB read pays a cross-region hop — a real chunk of the `/log/<id>` ~896 ms cold TTFB (the Worker runs at the edge near the reader; the database doesn't). Cloudflare-native **D1** co-locates with Workers and would shrink that roundtrip. The catch is migration cost: D1 is SQLite with its own ceilings (database-size and write-throughput limits, no libSQL-only features), and the whole Drizzle data layer, migration history, and the per-worktree local-dev story (`turso dev` + `.dev/local.db`, see `docs/local-database.md`) would move with it — a real arc, not a config flip.

Near-term the cheaper win is **edge-caching the `/log` HTML** (short TTL + stale-while-revalidate + purge-on-publish) — scoped separately. Treat D1 as the deeper structural lever: pursue it when DB latency (not render time or asset weight) is the proven bottleneck. Spike it first — confirm D1's limits fit the catalogue and access patterns, and that nothing in the current libSQL usage is load-bearing — before committing to the migration.

### radio.fluncle.com — LIVE

`radio.fluncle.com` is **live** as a **synchronized broadcast** — a shared clock + fast offset-join (#115), with clock-driven advance, boundary hysteresis, self-heal, and mute (#117); sync-verified on real devices. It plays each eligible finding's clean square master (MT-cropped to landscape on desktop / portrait on mobile, audio stripped) under its observation audio, every listener on the same schedule rather than each cycling its own. **Synced observation subtitles ship too (#140)** — word-level captions cued to the observation audio over the full-screen footage (an accessibility + dwell win, last-word-stays-lit anti-strobe, WCAG AA). Eligibility = `video_squared_at AND observation_audio_url`; the station fills out as the observation backfill runs (see _Run the prepared catalogue backfills_). The known media-loading stall is tracked above as a cross-surface bug, not a radio-specific one.

### Fluncle's own mixtapes — open follow-ups

The mixtape spine, the `/admin/mixtapes` editor + on-the-fly covers, and the `fluncle admin mixtapes distribute` autopublish (video→YouTube + audio→Mixcloud on our own OAuth, mint-first) are all live. Runbook + spine model: **[packages/skills/fluncle-mixtapes](../packages/skills/fluncle-mixtapes)**. What's open:

- **Off-site (low priority).** Keep enriching Wikidata `Q140169844` as facts accumulate (the MusicBrainz DJ-mix release [`fc818504`](https://musicbrainz.org/release/fc818504-6c01-4565-be1e-d1b3657f8a7c)) — tracked in the off-site thread above.
- **SoundCloud + the MusicBrainz/Wikidata loop** stay manual by design.

Out of scope until needed: a teaser-clip-of-a-mixtape pipeline, and the Galaxy-game checkpoint body at the mixtape's sector.

### Private preview archive — move to a non-public bucket

Enrichment stores the exact official 30s preview used for the feature vector at an operator-only path (`analysis/previews/<log-id>/<sha256>.<ext>`), excluded from every public surface. **Open:** it currently lives in the public `fluncle-videos` bucket, so its privacy rests only on the unguessable key — move it to a dedicated **non-public** R2 bucket before relying on it as training input. The columns stay inert until the first archive write, so there's runway. (Training consumer: the vibe-placement model below.)

### TikTok audio line-up (build only when a track breaks)

On standby — most relevant during the content backlog. The video is beat-matched to a Deezer/iTunes 30s preview (a fixed mid-song segment); TikTok's attachable sound is usually — not always — the song's first ~60s, trimmable to any start within the span it exposes. When the preview segment isn't reachable there and the track has no obvious section to line up by ear, the visuals pulse to beats that aren't playing. **Stage 0 (now):** by-ear line-up. **Stage 1 (on break):** full-track audio for analysis only via Apify `apidojo/youtube-scraper` (stream URL → ffmpeg → analyze → discard, never stored or served). **Stage 2:** pick the best ~20s window inside the first ~55s, render to it, write the absolute start offset into `render.json` + surface it ("start the sound at 0:42"). Audio policy: YouTube audio is internal-analysis-only; published audio uses official previews. AcousticBrainz-by-ISRC is frozen (~2022/24), so it is not a BPM fallback for new tracks.

### YouTube thumbnails — decided: leave them (2026-06-23)

We're **not** setting custom YouTube thumbnails. Looking at the live `@fluncle` Shorts grid, none of the uploads carry a `cover.jpg` plate — including ones pushed _after_ the feature landed — so the `settings.thumbnail` Postiz push (`pushYouTubeShort`, `apps/web/src/lib/server/postiz.ts`) isn't actually taking. And it doesn't matter: YouTube's auto-picked frame from each bespoke-shader video looks **better** than a flat album cover would — the grid reads as a varied, alive wall of cosmic visuals, which a static plate would only flatten.

So: the back-catalogue backfill (`thumbnails.set` script, #127) was built, found 0 DB candidates, and has been **removed** as moot; the forward `settings.thumbnail` line in `pushYouTubeShort` is non-functional dead code flagged for a someday cleanup (not urgent — it fails silently and the auto-frame is the preferred result anyway).

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

The spine (the Log ID) already runs across surfaces; what's ahead:

- **New surfaces:** `/log/<id>` pages (the log as object — observation, recovered artifact, related logs), RSS as the observation feed, possibly Discord. The site becomes an archive you browse, not only a feed you scroll. This subsumes the auto-pipeline's reconciliation marker — one identity does the trail and the reconciliation.
- **Canon surgery (resolve as one decision, not piecemeal):** PRODUCT.md gains a co-primary log/observation thesis; VOICE.md formalizes the logbook register as the deep end of the Depth Gradient (SSH / archive / RSS speak as a "recovered terminal," the warm uncle still holds web / Telegram / email; "transmission" and "signal" stay banned, adopt log / observation / discovery / archive / recovered / artifact / sector; "banger" stays primary); DESIGN.md gains the log-page / archive panes (Oxanium, tabular, instrument-panel calm).

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

**SSH version (the flex)** — live at `ssh rave.fluncle.com`: a Go port of the sim (`apps/ssh/internal/galaxy`) kept in lockstep with the JS source by parity tests (`apps/web/src/game/parity-fixtures.test.ts`), the same _sim_ inside the terminal — top-down scope renderer, the read-the-log orbit card with an OSC-8 Spotify link, audio-less as flavor, telemetry in the deepest Depth-Gradient register. Map knowledge is portable across surfaces — the Log ID spine paying off. Remaining are named fast-follows: SSH experience polish, QR / Kitty-input / ambient-crew.

**Persistence:** web private accounts now sync lifetime Galaxy progress without changing active-run cargo. Cross-surface login for SSH/CLI remains future work; anonymous play stays first-class.

### User accounts

The private web account layer is live (Better Auth email/password + username, `/account`, private Galaxy lifetime progress, saved findings, signed-in submission ownership, export/delete, durable rate limits, hard separation from admin auth). Anonymous browse, submit, RSS, MCP, CLI, SSH, and Galaxy play stay unchanged. Follow-ups, deliberately separate from that first slice:

- **Cross-surface account login:** CLI/SSH device login for synced Galaxy lifetime markers, saved findings, and own submissions. User tokens must stay separate from `FLUNCLE_API_TOKEN`, and SSH stays anonymous by default.
- **Authenticated MCP tools:** only if there is a concrete agent use case; keep the existing MCP server/card anonymous until a dedicated auth contract, CORS/header behavior, and failure model exist.
- **Public marginalia RFC:** public crew cards, public submission credit, crew notes, reports, moderation, and profile-like surfaces need their own RFC before implementation. Hard default remains no public writing.
- **Email/password hardening:** decide verification/reset policy, abuse thresholds, disposable-email handling, and support copy once real usage shows the pressure points.
- **Account ops polish:** keep the account env vars prominent (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`) and do a real-data privacy pass on export/delete after a few accounts exist.

### TikTok auto-pipeline (the capstone)

"Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com` and the system enriches → renders → captions → pushes a draft automatically; the human steps stay manual on purpose (attach the official sound, finish, publish). The draft-publishing layer runs today by hand — now through the **`/admin` board** (per-platform status, push, copy-caption, asset downloads). What's left to make it autonomous:

- **Render: a Claude Code routine on the Mac now, server-side render deferred.** Rendering runs hands-off via the hourly **Claude Code routine** ("Fluncle video queue") on the Mac (see Now → "Hands-off rendering"). A fully-server-side **render-capable profile** stays deferred: software-GL (SwiftShader) is viable (~1.45× Metal, no GPU needed) but needs a render rootfs (Chromium + SwiftShader / Mesa / fonts + ffmpeg), likely >1 vCPU, and an answer to how an ephemeral runner gets the `packages/video` kit (fresh checkout per run, a prebuilt image, or a published package). Pursue it only when laptop-bound rendering becomes the bottleneck.
- **Autonomous trigger — the enrich step is live (Hermes box cron).** Enrichment runs hands-off: a new find lands `pending`, and the box's `fluncle-enrich` `--no-agent` sweep enriches it within minutes (Spinup decommissioned, #104). Extending the chain to **render → publish** is the remaining autonomy, gated on the server-side render profile above.
- **Reconciliation.** Recording an outcome by hand works for any post now — the status endpoint **upserts** (PR #14), so a manually-published or cross-environment post can be marked `published` (with the live URL) even without a prior draft row. Still open: the **automatic** version — an hourly check matching recent posts to the `fluncle://<log-id>` marker and flipping `social_posts.status` itself, observed not hand-entered.
- **More platforms — YouTube done, the autopilot-ready channel; Instagram closed.** YouTube Shorts ships now (PR #13): a direct public upload (title + caption + `cover.jpg` thumbnail) via the per-platform push, recorded in `social_posts`. Because it needs **no manual finish** (unlike TikTok's in-app official sound), YouTube is the one channel that can run **fully on autopilot** — once the autonomous trigger above chains enrich → render → publish, YouTube publishes hands-off with nothing left for the human. (Flagged, not urgent.) Instagram is **deferred — not posting yet** (the `@fluncle` account exists, but the music-licensing exposure isn't worth it for now): there's no legitimate API audio path (the master gets muted on a business/creator account, and IG's licensed audio is app-only), so it would mean silent clips or manual in-app posts under that risk. Parked, not closed; see the autonomy ladder's _Deferred_ group. Per-platform doctrine lives in `docs/track-lifecycle.md` (Phase 3) + the `fluncle-publish` skill.

### Fluncle Studio — clip a set, auto-distribute the clips

The mixtape is the one fully-manual capstone: Maurice goes live on Twitch, records the set, and distributes it — video → YouTube, audio → Mixcloud + SoundCloud (already partly automated via the `fluncle-mixtapes` skill). The **next big slice** turns that one long set into many short posts: a **"Fluncle Studio"** `/admin` page that takes a full rendered video (a mixtape set, or any clip source) and cuts **clips** from it — pick in/out points, frame the vertical crop, caption — then **auto-distributes** them to socials (Instagram first, via **Postiz**, which supports it; other platforms follow). It is the clipping + distribution layer the archive doesn't have yet — today the set lives as one object and there is no clipping item.

This extends the "Yours → Agents" migration one more step: clip-farming a set is currently a fully-manual act with no tooling. Caveats to carry in when it's picked up — the **Instagram music-licensing** exposure noted under _TikTok auto-pipeline → More platforms_ (a DJ set still carries the tracks' copyright, so short-clip framing or accepting the risk is an operator call), and the clip pipeline should reuse the `packages/video` ship/transform machinery (the two-master + Cloudflare Media Transformations model) rather than reinventing the encode. For now this is a placeholder — the slice itself is unscoped.

### Brand & canon

- **Moodboard → canon audit (video-side remainder)** — the web overhaul resolved the web half (the logbook plate, ignition hovers, the grain architecture, and the archive grammar are in DESIGN.md now). Still open per concept: whether the video-kit proofs (texture families' full grammar, vehicle grammar, One-Sun-through-the-vehicle) get promoted into canon or stay video-local; cross-link, don't duplicate.
- **Video aliveness — Part I shipped, grain-diversity in progress.** Part I landed (merge `9d12806`): music-reactive renders via the signal-chain dials + the global-vs-internal motion law + an author-time composition lint, with the deterministic flash-safety / coupling / intent metrics (`packages/video/src/pipeline/`). The proposed Part II — an LLM judge in the render loop — was prototyped and **dropped** (proven not worth the one prod deploy it needed). **In progress:** a grain-diversity thread (its own active work), keeping the grain from converging across renders.
- **Video rendering guidelines refresh** — two additions to the video doctrine, folded into the `fluncle-video` skill + the DESIGN.md video section: (a) a **lava-lamp aesthetic register** — a calm, slow, non-flashy, non-strobo family for the quiet covers (the opposite of a busy beat-reactive scene); and (b) a **contact-sheet QA technique** — render a multi-panel frame-grid (stills sampled across the clip) so a render can be eyeballed at a glance before shipping, catching the static / HTML-y / sameness failure modes early.

### Newsletter — open follow-ups

The Friday newsletter ([docs/agents/newsletter-agent.md](./agents/newsletter-agent.md)) is authored + persisted by the `fluncle-newsletter` Hermes cron (see _Hermes automation_), with the editions model (#102) persisting each edition's content at draft time and the send gated behind an operator Discord tap. What's open:

- **Confirm the Friday cadence** once the cron is wired on the box — that it fires Friday 15:00 Amsterdam, authors only on a non-empty window, and re-offers an unsent draft rather than double-authoring.
- **Keep findings tagged** (see the vibe-placement item) so the galaxy grouping (Solar → Nebular → Lunar → Astral) isn't all "Also found."
- **Public `/newsletter` archive surface + spine-native edition page.** The editions are now persisted (#102 — content saved at draft time, the roadmap's own proposed solution), but they live only in the DB + the email; there is no public way to read a past edition on the Galaxy (verified: no public `/newsletter` route ships). Surface them — a readable `/newsletter` archive, each edition a permanent object, ideally **spine-native like a mixtape** (a marked Log ID, a `/log/<id>` edition page, quiet feed / RSS inclusion) so an edition is a finding-shaped thing in the Galaxy, not a dead email. The persisted payload is the clean source to render both the archive page and the email from.
- **Admin editions UI — an operator front-end for the send (surfaced in the 2026-06-22 test).** Today the editions surface is CLI/API only: to review + send a draft the operator reaches for `fluncle admin newsletter send <id>`; the `/admin` board cockpit has no newsletter section. Add a small `/admin/newsletter` page — list editions (drafts inclusive, `list_editions_admin`), preview the rendered email, and a **Send** control wired to the operator-tier `send_edition` (operator session = operator role, so the UI can send where the agent can't). Pairs naturally with the public archive page above (same rendered payload, two audiences). Operator convenience, not a gate change.
- **Newsletter cron output polish.** The cron currently delivers its raw chain-of-thought to Discord instead of a clean digest (observed on the 2026-06-22 manual trigger), and its `clarify` Send/Hold button needs a human present to tap — fine on the real Friday 15:00 run, dead on a manual no-user trigger. Tighten the cron prompt to ship a tidy result line ("Drafted _<subject>_ — N tracks + M mixtapes, send pending") and keep the Send button for the live Friday context. Also: the Firecrawl scene-`tidbits` came back empty on the first run — confirm the tidbit-gathering step works against real findings (the email renders fine without them, but they're the extra scene color).

### Vibe-placement model (auto-tag the map)

Findings are grouped by **vibe**, not sub-genre — the admin tagging tool (shipped; [docs/admin-tagging.md](./admin-tagging.md)) places each one on a 2-axis map stored as a coordinate: `vibe_x` = Light↔Dark mood, `vibe_y` = Floaty↔Driving energy; the quadrant is the finding's galaxy (Solar / Nebular / Lunar / Astral). Those coordinates are the **training labels** for a small model that will eventually auto-place new finds.

The dataset is already self-assembling: every placed finding is a clean row of `features_json` (the spectral vector the enrichment agent already stores — `centroidHz`, `highRatio`, `midFlatness`, `onsetRate`, `subBassRatio`) → `(vibe_x, vibe_y)`. Inputs and labels are both captured today; nothing extra is needed to build it.

**Deliberately NOT auto-suggested yet.** With no trained model, any suggestion would be a hand heuristic — and pre-filling the marker would _anchor_ the operator and bias the very labels the model needs (the same imprecision we deleted with the old sub-genre `suggestTags`). Manual placement from the audio is the clean ground truth; collect that first.

The plan:

- **Revisit at ~50–100 placements.** As of 2026-06-11 there are 26 findings; the operator is labeling the backlog around 2026-06-12, so a first dataset is days away. Once there's a meaningful set, **start training a small model** `features → (vibe_x, vibe_y)` — k-nearest-neighbours over the feature vector or ridge regression is plenty at this scale (no infra needed) — and measure what accuracy is achievable with what we have. The early read tells us whether the audio features carry enough signal or whether the feature set needs widening.
- **Once a model is confident, extend the enrichment skill with it.** Add the prediction to `packages/skills/fluncle-track-enrichment` (`analyze-track.ts`) so enrichment emits a suggested `(vibe_x, vibe_y)`; the tagging tool pre-fills it and the operator **verifies/adjusts**, and those corrections feed back as active-learning data. That auto-tag-then-verify loop is the long-term win — switched on only after the clean manual labels exist.

Unnecessarily fun — that's the point.

### Auto-drafted finding notes — v1 shipped, the vibe-neighbour refinement open

The board takes an optional **note** per finding — the editorial "why" that renders on the `/log/<id>` page and feeds its definitional prose + `MusicRecording` schema, so a note is real SEO/AEO value, not just operator chrome. **The v1 auto-note shipped (#141, `docs/agents/note-agent.md`):** a context-note-grounded first pass authored by one `claude -p` call (subscription auth, `copywriting-fluncle` voice), voice-gated, **fill-empty-only** so an operator note is never clobbered, running as the `fluncle-note` box cron. The operator still verifies/edits, and those edits grow the corpus. What remains here is the richer **vibe-neighbour** version below — a longer-term autonomous refinement, gated on the vibe-placement model.

The notes encode Maurice's **subjective** read — where he placed the finding on the vibe map, how it sits in its galaxy — not its objective spectral numbers. So the neighbours to draw from must be nearest in **vibe** (the placed `vibe_x`/`vibe_y`, same galaxy), NOT in `features_json`: two tracks can measure nearly identical yet land in different galaxies by feel, and a feature-twin's note would carry the wrong vibe. That is why this is **downstream of the vibe-placement model above** — a new finding needs a vibe coordinate before it has vibe-neighbours, and in the autonomous chain that coordinate comes from the model (features → predicted `vibe_x`/`vibe_y`). The features are the model's input; the note's neighbours live in the vibe space the model produces.

The shape: enrich → the vibe model places the finding → pull the notes of its **nearest neighbours in vibe space** (closest `vibe_x`/`vibe_y`, same galaxy) → the agent synthesizes a fresh, finding-specific note grounded in the galaxy's character and the audio (driving-dark Nebular vs floaty-light Lunar; the BPM, key, texture), in Fluncle's voice via the `copywriting-fluncle` skill → the operator verifies and edits, and that edit grows the corpus. Guardrails: the cluster informs but never templates (the same anti-sameness discipline as the parallel-render attractor — a note that reads like every other note in its galaxy is worse than none), never fabricate scene history or facts, and only draft when there's real signal; the note stays optional, so silence beats a generic line.

Gated on the **vibe-placement model** (for the coordinate) and a **notes corpus** to draw from (the board's note column is filling it now). Lives in `packages/skills/fluncle-track-enrichment` alongside the `(vibe_x, vibe_y)` prediction. (A finding that's already manually tagged has its coordinate now, so the neighbour-in-vibe approach can be prototyped on the current set before the model lands — just not autonomously.)

The v1 shipped because the clean distilled `context_note` (firecrawl facts + the `Texture:` line) is a strong input that sidesteps the vibe-model gate: the context note supplies the FACTUAL spine the old soup-notes never could (label, scene, character), the galaxy/vibe placement keeps it subjective rather than generic fact-recitation, and the copywriting skill keeps it on-brand. The vibe-neighbour model stays the longer-term autonomous refinement on top of it.
