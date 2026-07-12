# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

## Now — the production loop is running

The add → live pipeline is operational end to end — the one `/admin` cockpit board, the deterministic `--no-agent` per-finding sweeps on the Hermes box, the hands-off `fluncle-render` conductor, and publishing (YouTube hands-off, TikTok drafted + auto-captured). The last autonomy gap is **closed in the repo**: the `fluncle-publish-advance` cron chains render → publish with no operator beat between them (doctrine: [docs/track-lifecycle.md](../track-lifecycle.md) § _The render → publish auto-advance_). It ships **DARK** — its kill switch is default-deny, so the tick posts nothing until the operator flips it on. What's left of the loop is ongoing operation, not build work.

### The autonomy ladder

The full path a finding travels: one human act (Maurice finds the banger and adds it — manual by design, "Maurice discovers, Fluncle does the rest"), instant synchronous fan-out to ~10 surfaces (Spotify · Telegram · web · CLI · API · MCP · RSS · SSH · both Galaxy games), then the async `--no-agent` box sweeps run on their own (enrich → context note → note → observation → render). What's left is the manual tail, roughly in order, and where each one automates:

- **Tag — retired.** Manual vibe-placement is dropped (audio can't learn it, and nothing critical read it); the galaxy grouping it fed moves to automatic **audio-embedding clusters** (see _Audio embeddings_). One fewer manual step.
- **Note** the editorial "why" — **automated.** The auto-note drafts a first pass per finding (fill-empty-only), now authored against the finding's sonic neighbourhood and guarded by the echo gate; the operator still verifies/edits, and those edits grow the corpus. See _Auto-drafted finding notes_.
- **YouTube** Shorts — **automated (built, off by default).** The render → publish auto-advance pushes the Short itself: a direct public upload, nothing left for a human. The one channel that needs no in-app finish, so with the advance on, YouTube runs fully on autopilot. **Operator gate:** `fluncle admin publish resume` (or the toggle on `/admin/findings`) — one flip, no deploy.
- [ ] **TikTok** — the inbox draft is now pushed by the same auto-advance; the operator still finishes it in-app (attach the official sound, publish), then `fluncle-social-capture` flips the captured draft → published on its own. Manual by design — no legitimate API audio path. **The last per-finding beat, and the only one left.**
- [ ] **Newsletter (Friday)** — the sweep drafts + persists the weekly edition and offers the literal `fluncle admin newsletter send <id>` command; the send stays an operator tap. The one weekly-cadence step. See _Later → Newsletter — open follow-ups_.

**Deferred (on purpose)** — a surface we could reach but choose to leave dark: **Instagram** (`@fluncle`) — the per-finding master stays deferred (no legitimate API audio path — it gets muted on a business/creator account, IG's licensed audio is app-only; parked, not closed), while set clips are re-opened — a live-mixed DJ-**set** clip fingerprints differently and survives, so the Fluncle Studio clip drip-feed posts set clips to IG on a jittered daily cadence with a kill switch (see _Fluncle Studio_).

**The shape:** one human add → instant parallel fan-out → a deterministic async pipeline → a shrinking manual tail. Of that tail, tag is retired (audio embeddings replace its grouping) and YouTube has now fallen to the render → publish auto-advance; TikTok's in-app finish and the Friday newsletter send stay deliberate human taps, each blocked by an external platform limit, not by us.

## Next — surface what we make, and tidy reliability

### Live visuals — free mixing without a preloaded tracklist (Tier B, gated on full-audio)

Today the live matcher is **closed-set**: at show start it fingerprints each _planned_ track's 30s preview and only ever asks "has the next planned track started?" (`packages/live/src/bridge/matcher.ts` — a pointer-relative search against current/pending/pending+1; RFC §4 already names whole-catalogue matching as the unbuilt v2). That is why a fixed Rekordbox tracklist must be preloaded before the first beat. The prize is to **drop the tracklist and mix freely** — open-set identification of whatever is actually playing, matched against the whole archive, so the visuals follow the set by ear instead of by plan.

This is **gated on full-audio landing first**: Tier A there swaps the live reference from the 30s preview to the full song, which both fixes the "reference is only a 30s slice, so a mix-in outside it can never match" miss and is the prerequisite for any open-set path. Open-set itself is a real project, not a byproduct — it must survive DJ **pitch/tempo/EQ** (log-mel cosine is invariant to none of them), **mix overlap** (two tracks at once is an ambiguous blend), and **archive-scale search** (an index, not brute cosine per window). The promising architecture reuses the MuQ embeddings: embed the live window, nearest-neighbour it to a top-K shortlist, then confirm the exact track with the existing `bestOffsetScore`. Gets its own scoping/RFC pass once full-audio is in.

### Public navigation — the graph needs a trunk (PR #453, awaiting the operator's pick)

The homepage's left column stuffs everything (playlist/radio/newsletter/submit, About·Logs·Mixtapes·Galaxies·Docs, the Follow row, the nerds row) while the newer surfaces — `/artist/<slug>`, `/artists`, `/logbook`, `/galaxies`, `/mix` — have only ad-hoc footer links. Fluncle is becoming a **graph archive** (canonical `/log` pages cross-linked with informational artist / label / album / galaxy pages), and a graph needs a trunk.

**Four variants are built and browsable** behind a dev-only picker (PR #453 — held for the operator; prod renders variant A only, and it is prod-safe as-is). They differ in _information architecture_, not styling, and all four consume one `navModel` so link lists cannot drift: **A** a masthead strip · **B** a logbook-colophon footer with minimal top chrome · **C** a left rail collapsing to a header · **D** a chart drawer carrying every section **plus archive search**. SEO is in all four (SSR'd real `<a href>`s, one site-wide footer for link equity, `BreadcrumbList` JSON-LD on the honest hierarchies, every leaf ≤2 hops from every index).

The decision is shaped by what comes next: with a catalogue, "Artists" means thousands rather than 67, and **search stops being optional — it becomes the primary navigation**. Variant D is the only one whose IA survives that; B best protects the cover-led feel. That tension is the call. The operator has notes; they land here.

### Hermes automation — follow-ups

The per-finding pipeline runs entirely as `--no-agent` jobs on the Hermes box (enrich, context-note, note, observation, backfill, render, social-capture, studio-clip, newsletter, plus the host healthcheck timer); the source of truth is the sweep sources in `docs/agents/hermes/scripts/` + the per-job units in `docs/agents/hermes/*-timer/`, managed on the devbox via the **fluncle-hermes-operator** skill. As of the **2026-07-08 durable-deploy activation** these all run as **repo host systemd timers** reading the baked `/opt/hermes-scripts` path (the Hermes gateway cron runner is retired). Operating doc + roles: [docs/agents/hermes-agent.md](../agents/hermes-agent.md). Ongoing operation is a verify pass per job, not build work. Two follow-ups stay separate from the cron wiring:

- **✅ 2026-07-08 — old gateway world torn down (done, brought forward from the 07-09 soak).** All paused gateway crons are deleted — the 13 migrated jobs **plus** a 14th, a stale/paused `fluncle-embed` cron the migration list had missed — so the gateway cron subsystem is now genuinely empty (0 active, 0 paused). The vestigial `/opt/data/scripts` (34 files, every one a stale twin of the baked `/opt/hermes-scripts`) was pruned. **`/opt/data/skills` was deliberately KEPT**: despite the RFC's "prune `/opt/data/{scripts,skills}`" note, that dir is not deploy cruft — it is the Hermes **gateway agent's** live curator-managed skill library (`.curator_state`, `.curator_backups/`, `.bundled_manifest`, plus `apple/`, `autonomous-ai-agents/`, `computer-use/` skills with no baked twin). The enrich sweep reads the analyzer from the baked `/opt/hermes-skills` path, so the `/opt/data/skills` copy of `analyze-track.ts` is a dormant duplicate the curator owns, not something to delete. Post-teardown smokes green (enrich CLI `{ ok: true }`, baked `analyze-track.ts` + `embed-track.py` + `yt-dlp 2026.07.04` resolvable).
- **Non-root-in-container (defense-in-depth, low priority).** Run the agent as a non-root user with the token out of its readable env. Now that the token is `agent`-scoped this no longer guards the publish boundary — it only protects the agent's own surface and the token value from a fully-compromised agent, plus hardens against a container escape. Worth doing before any wider/public allow-list; not a blocker for the current private/trusted setup.

### The acquisition boundary — `capture-sweep.ts` is in the wrong repo (parked 2026-07-11)

`docs/agents/hermes/scripts/capture-sweep.ts` is the **audio acquisition layer**, and it sits in this **public** repo — directly against the rule AGENTS.md and the `fluncle-labs` README both state: _"The public repo describes what it does **with** the bytes. It never describes, scripts, or links how they arrived."_ It is not silent; the script is world-readable.

**Parked deliberately, not forgotten.** Moving it is not a `git mv`: the Hermes box bakes its scripts **from this repo**, so relocating the sweep means giving **rave-02 read access to a private repo** (a deploy key or a fine-grained token, plus the bake pipeline learning a second source). That is real infra work and it is not the 24h sprint's job.

Two honest notes for whoever picks this up:

- **Git history is forever.** The script is already public, so moving it does not undo the exposure — it only stops adding to it. That is still worth doing, but do not mistake it for erasure.
- **If we decide the current posture is fine, amend the RULE.** A boundary the codebase openly contradicts is worse than no boundary: it teaches every future agent that the rule is decorative.

### Secret & token hygiene — deferred 1Password/R2 follow-ups

The 2026-07-07 1Password naming/vault audit closed its duplicate-deletes and stale-item retires; three deferred items remain. None are overnight-autonomous — each touches live secret bootstrap and needs `op` plus careful sequencing (concrete item/field names live in the private Ops Runbook note, never here).

- [ ] **IP-pin the box-only R2 token.** The backups-bucket R2 token is used only from the box, so it is a good candidate for a static-IP restriction (a Cloudflare-dashboard change, operator). The videos-bucket token is also used Worker-side, so it cannot be pinned.
- [ ] **Standardize the two R2 credential items' field names to snake_case.** The two R2 items in the vault disagree on field-label casing; rename the labels AND update every `op://` reference that points at them (the box secret-injection templates under `docs/agents/hermes/secrets/`, feeding the env vars the backup sweep reads) in one focused pass so injection never breaks between the two.
- [ ] **Retire the local-dev env mega-bundle — one source of truth per secret.** The ~35-field dev-env bundle item duplicates standalone vault items (a rotation-drift hazard: two sources of truth per secret). Promote each TRUE secret to its own standalone item and reference each directly in `apps/web/.dev.vars.tpl` via its `op://` placeholder; keep non-secret config (redirect URIs, channel ids, from-addresses) inline or in one small config item. Mis-sequencing breaks dev secret load, so rewrite the template and the items together.

### Catalogue backfills — drain the small back-catalogue (monitoring)

The `fluncle-backfill` cron paces the two Worker-side catalogue sweeps (Discogs resolve + Last.fm love), with reliability columns gating already-done rows and Retry-After backoff so a 429 cools down instead of storming. What's left here is just **watching the small catalogue drain** — confirm each pipeline's back-catalogue empties out and stays empty. (If album-art → R2 ingestion ships, it rides the same sweep shape.)

### Observation pipeline — context-notes shape finetune

The empty-context retry path is operational (`context_status` distinguishes confirmed-empty from never-attempted, and `--retry-empty` on `fluncle admin tracks context --queue` + the on-box sweep flag widen the net), so a rare "facts may have appeared upstream" pass can be triggered when wanted. What's open:

- **Context-notes shape finetune.** A tuning pass on the distill prompt (`observation.ts distilContextNote`) against accumulated real notes — which Firecrawl facts are worth keeping, how the distilled prose + the one-line `Texture:` shape reads, and how cleanly it fuels a grounded observation script (a noisy note makes a worse spoken observation).

### Audio observation — voice-guide finetune

The pipeline and the bespoke Fluncle voice are live end to end; what remains is **script craft**, not the voice itself:

- **Finetune the Recovered-audio voice guide.** Tighten the writing guide for the _spoken_ observation: the arc (sensory → mood → connection → log ID → artist/title), line length and pacing for a heard surface (a clunky line can't be skimmed past), how hard the cosmos-sauce should ride out loud, never naming earthly geography, and where "too purple" begins. Fold Maurice's notes from the real renders back into the `copywriting-fluncle` voice reference (`packages/skills/copywriting-fluncle`) + `observation-agent.md`. (SSML is no longer a lever — `<break>` tokens are stripped; Cartesia paces on punctuation.)

### Optimize web playback — the `/log` mobile rung

The playback layer is in place and the throttled-mobile win is verified: `apps/web/src/lib/media.ts` serves same-zone Media Transformation renditions (the width ladder + centre-crops + `mode=frame` poster, one-shot fallback to the raw master), and the `?v=N` vintage token solves re-ship purge. Keep watch that the pipeline's CRF doesn't drift footage back over Cloudflare's 100 MB transform ceiling (the largest sit close to ~95 MB). The one remaining thread:

- **`/log` mobile requests the native 1080×1920 crop regardless of pane size** (`log-footage.tsx` calls `videoCrop(logId, "portrait")` with no width, unlike Stories which passes the measured `renditionWidth`), so on the slowest connections the muted loop is effectively dormant and the stall watchdog makes it worse by bailing to the even-heavier master. The small, well-scoped fix: have `/log` mobile pass a pane-sized ladder rung the way Stories already does, and revisit the watchdog's bail-to-master on a constrained link. An optimization, not a blocker.

### Log IDs in search + AI answers (AEO/GEO) — off-site thread

The on-site layer shipped (per-finding `/log/<id>` pages with definitional prose + `MusicRecording` identifiers, sitemap + IndexNow fan-out, the `/about` entity/FAQ surface, `VideoObject` structured data) and the first retrievals and video indexing have landed. What remains is off-site, slower, and mostly monitoring:

- **AI crawlers: keep the regression check.** Verified AI crawlers pass and managed robots.txt is OFF; still worth a recurring check of the live `/robots.txt` + the AI Crawl Control crawler policies (Cloudflare can re-flip defaults silently).
- **Watch the indexing milestones.** The per-finding `/log/<id>` pages moving to Indexed in GSC (today a bare coordinate lands the `/log` _index_, not yet the individual page; count ≈ archive size), an individual page ranking for its own coordinate, the rest of the video pages filling into the GSC Video-indexing report as they're re-crawled, bare-token retrieval (`004.7.2I`, `fluncle://004.7.2I`) landing the log page, and Fluncle present in Brave Search. Bing/Yandex are hands-off via IndexNow; Google still rides the GSC sitemap. Indexing and AI citation are ongoing outcomes — monitoring, not ship gates.
- **Third-party corroboration.** The MusicBrainz artist + Wikidata item anchors exist and sit in the `/about` `sameAs` set. Remaining: authentic presence where dnb lives (r/DnB and friends — participate, don't fabricate), and enrich the Wikidata item as facts accumulate.
- **Sitemap sharding — build when the catalogue grows the URL space (~2k+ URLs).** Today `/sitemap.xml` is one file walking every finding per hit; the catalogue arc plus the label/album/galaxy pages multiply the URL space, and one flat file scales badly in the 128 MB isolate. The shape: `/sitemap.xml` becomes a **sitemap index** listing per-entity-type children (`sitemap-findings.xml`, `sitemap-artists.xml`, `sitemap-labels.xml`, `sitemap-albums.xml`, `sitemap-galaxies.xml`, `sitemap-logbook.xml`), each paginated by keyset once a type nears a few thousand URLs, each carrying `lastmod = max(member lastmod)` so crawlers refetch only the shard that changed (a new finding touches one child, not the whole map) — and GSC starts reporting indexing per entity type. Implementation: the existing `sitemap[.]xml.ts` becomes the index emitter; per-type child routes reuse the existing per-entity queries; each child gets the standard feed `Cache-Control`; IndexNow + the GSC submission keep pointing at `/sitemap.xml` unchanged. The natural moment is when the label/album pages land.

### Developer & discovery surfaces — the long tail

The machine- and developer-facing surfaces mapped in [docs/surfaces-doctrine.md](../surfaces-doctrine.md) (dig, versioned contract-first API, the Fumadocs `/docs` hub, feeds, CLI distribution, SSH deep-links) are live. What's open:

- **The non-gating tail:** the `today` dig label, a public changelog, a Docker image, broader data-graph anchors (Discogs, Last.fm, ListenBrainz), and directory listings (Product Hunt, Internet Archive, a Hugging Face dataset). Each becomes a registry entry in [docs/surfaces-doctrine.md](../surfaces-doctrine.md) when one earns its keep.

### Fluncle Lens (Chrome extension) — open follow-ups

Fluncle Lens (`apps/extension`) — the MV3 extension that turns `fluncle://<coord>` Log IDs anywhere on the web into `/log/<coord>` links — is live in the [Chrome Web Store](https://chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk) with the `extension.lens` registry fan-out done; the listing/privacy-form answers that recur on every version update are captured operator-side. What's open:

- **Announce to the crew.** A quiet line to the crew (Telegram / the Friday letter), drafted in Fluncle's voice and operator-sent.
- **Future features.** Beyond Log-ID linkification, any richer Lens behaviour is open-ended — translate ideas into Fluncle's terms when picked up (canon wins per `AGENTS.md`; the source brainstorm leaned on banned words like "signals").

### Tor `.onion` surfaces — SSH onion deferred

The Fluncle web onion is live on the rave VPS, proxying `www.fluncle.com` (API/RSS/MCP as free riders) with the `Onion-Location` pill; deployment shape + key custody: `docs/tor.md`. What's open:

- **The rave SSH onion (deferred).** A second onion identity → the SSH terminal was scoped but deferred; stand it up if the flex earns its keep.

### Hosted-Turso proof of the embed queue's `--count` (before the crawl hits six figures)

The one scale claim from the catalogue sprint never proven against **hosted** Turso (the docs/local-database.md rule: local lies about scale): the embed work-queue's `--count`, a `count(*)` over the partial index `tracks_embed_queue_idx`. The 2026-07-11 spike (#455, absorbed into docs/local-database.md) measured the *vector* shapes at 100k — blob-vs-text probe binding, the ANN-index trap, JSON-vs-blob storage — but not this query. Risk profile is the mildest of the family (the partial index holds only the un-embedded backlog, bounded by capture rate, and the query touches none of the three measured cliffs), so it is not urgent — but it is a claim, not a measurement, until a scratch hosted DB at ~100k rows says so. Fold it into the next scratch-DB pass; destroy the DB after, per the spike protocol.

### Database latency — evaluate Turso → Cloudflare D1

Turso (libSQL) is the source of truth, hosted in **Ireland**, so every Worker→DB read pays a cross-region hop — a real chunk of the `/log/<id>` ~896 ms cold TTFB (the Worker runs at the edge near the reader; the database doesn't). Cloudflare-native **D1** co-locates with Workers and would shrink that roundtrip. The catch is migration cost: D1 is SQLite with its own ceilings (database-size and write-throughput limits, no libSQL-only features), and the whole Drizzle data layer, migration history, and the per-worktree local-dev story (`turso dev` + `.dev/local.db`, see `docs/local-database.md`) would move with it — a real arc, not a config flip.

The near-term cheaper win — edge-caching the `/log` HTML (short TTL + stale-while-revalidate + purge-on-change) — already takes the cross-region hop off the hot read path for cached pages. That makes D1 the **deeper** structural lever, not the next one: pursue it only when DB latency (not render time or asset weight) is the proven bottleneck on the paths the edge cache doesn't cover. Spike it first — confirm D1's limits fit the catalogue and access patterns, and that nothing in the current libSQL usage is load-bearing — before committing to the migration.

### radio.fluncle.com — watch items

The synchronized broadcast is live and hardened — a shared clock + fast offset-join, atomic A/V sync + wake lock, a tuning-in loading gate, synced word-level subtitles + live-narration captions, and a first-class homepage home. What's open is watching, not building: keep an eye on the shared media-loading stall watchdog (`use-video-recovery.ts`) for recurrence on flaky cellular, and the station fills out as the observation backfill runs — eligibility = `video_squared_at AND observation_audio_url` (see _Catalogue backfills_).

### Fluncle's own mixtapes — open follow-ups

The mixtape spine, the `/admin/mixtapes` editor + on-the-fly covers, and the `fluncle admin mixtapes distribute` autopublish (video→YouTube + audio→Mixcloud on our own OAuth, mint-first) are all live. Runbook + spine model: **[packages/skills/fluncle-mixtapes](../../packages/skills/fluncle-mixtapes)**. What's open:

- **Off-site (low priority).** Keep enriching Wikidata `Q140169844` as facts accumulate (the MusicBrainz DJ-mix release [`fc818504`](https://musicbrainz.org/release/fc818504-6c01-4565-be1e-d1b3657f8a7c)) — tracked in the off-site thread above.
- **SoundCloud + the MusicBrainz/Wikidata loop** stay manual by design.

Out of scope until needed: a teaser-clip-of-a-mixtape pipeline, and the Galaxy-game checkpoint body at the mixtape's sector.

### TikTok audio line-up (build only when a track breaks)

On standby — most relevant during the content backlog. The video is beat-matched to a Deezer/iTunes 30s preview (a fixed mid-song segment); TikTok's attachable sound is usually — not always — the song's first ~60s, trimmable to any start within the span it exposes. When the preview segment isn't reachable there and the track has no obvious section to line up by ear, the visuals pulse to beats that aren't playing. **Stage 0 (now):** by-ear line-up. **Stage 1 (on break):** full-track audio for analysis only via Apify `apidojo/youtube-scraper` (stream URL → ffmpeg → analyze → discard, never stored or served). **Stage 2:** pick the best ~20s window inside the first ~55s, render to it, write the absolute start offset into `render.json` + surface it ("start the sound at 0:42"). Audio policy: YouTube audio is internal-analysis-only; published audio uses official previews. AcousticBrainz-by-ISRC is frozen (~2022/24), so it is not a BPM fallback for new tracks.

### YouTube thumbnails — decided: leave them

Not setting custom thumbnails — YouTube's auto-picked frame from each bespoke-shader video reads better than a flat `cover.jpg` plate; decided and done, the dead thumbnail-upload branch removed.

## Later — the bigger arcs

### radio.fluncle.com on Twitch 24/7 — the always-on channel

The opposite cadence to the now-shipped "on the decks" live-set callout: an always-on, lean-back broadcast of [radio.fluncle.com](https://radio.fluncle.com) — the continuous run of Fluncle's findings, each playing under its observation — pushed to Twitch 24/7, in the spirit of the perpetual lofi channels. Where the on-the-decks callout is the one loud, ephemeral beat (Fluncle in the booth), this is the quiet, always-there hum: a passive, always-discoverable presence in Twitch's drum & bass directory, no live moment required. The shape is an unattended encoder (an `ffmpeg` loop on a small box, or a hosted restreamer) pulling the radio audio + a quiet cover-led visual (the now-playing finding, Galaxy aesthetic — calm, dark, reduced-motion-safe) and pushing RTMP to the Twitch ingest, with a watchdog to restart on drift; it composes with the live callout (the 24/7 stream simply steps aside, or hands off, when Maurice goes live). Gated on nothing structural; sized by the encoder-hosting choice.

### Fluncle's Galaxy — the logbook reframe

The reframe has landed: Fluncle the cosmonaut keeping a logbook, every discovery a log entry with a permanent, surface-independent identity (`fluncle://<id>`) that runs across every surface — the `/log/<id>` pages, the RSS observation feed, the canon surgery through PRODUCT.md / VOICE.md / DESIGN.md. What's still genuinely open:

- **Discord as a log surface (deferred).** A Discord representation of the log spine — the one surface from the identity map not yet stood up; pick it up if it earns its keep.

### Fluncle's Galaxy — the game (v1 live)

v1 is live at [galaxy.fluncle.com](https://galaxy.fluncle.com) (same Worker, `/galaxy` route): behind-the-ship 8-bit flight where every banger is a star at its Log ID coordinate, riding one typed data-driven `Entity` model (`game/types.ts` + `sim.ts`) — black-hole teleports, asteroid waves + laser, the fuel economy with the dry-tank tow as the one true failure — the same sim the SSH version reuses. What's ahead:

**Near polish:**

- **Announce to the crew:** post the game to Telegram + the Friday letter once the near-polish lands. (The `/galaxy` sitemap entry and the gate-screen OG image already shipped.)
- **Economy tuning from a real full clear** (10–15 min target): burn rates, refuel dwell, cruise/boost speeds, plus the new frontier dials — black-hole influence/pull radii and system count, asteroid wave density, laser cooldown, amen volume/fade. One human playthrough decides (out of agent scope by design).
- **Real-device mobile pass:** thumb zones on actual glass, safe-areas, the dynamic address bar, performance on a mid phone (now with more entities + the film pass).
- **SFX pass:** richer 8-bit when it itches.
- **Boot cinematic upgrade** (v1 is minimal + skippable).

**The expanding frontier (the content engine):** the Log ID sector is days since the Fluncle epoch and maps to distance from Earth, deliberately uncompressed — the galaxy literally grows outward as findings land, full clears get longer, and that pressure is what future content answers. Set-dressing and hazard density already rise with distance, and the black-hole network scales with the catalogue. Still ahead: **new home planets as forward bases / respawn + refuel hubs** (overlaps persistence), derelicts and lore nodes. The further from Earth, the stranger the universe — near space is the warm early catalogue, the frontier is the new-and-scary flicker.

**Backlog (still open):**

- **Worm holes as a distinct entity** — deferred: the black-hole teleport network carries the "shortcut to the far side" flavor; a separate worm-hole only if it earns its own navigation.
- **Other planets / forward bases** — future, tied to persistence (refuel hubs / respawn points out on the frontier).
- **The bespoke sprite menagerie** beyond the heroes (see Near polish).
- **Multiplayer — a shared galaxy (idea, 2026-06-24 scribble)** — open the single-pilot universe to the crew: other players' dots on the **radar** in your sector, their trails / recently-flown **tracks**, and a sense of which stars are **popular** (most-visited across everyone) so the catalogue's hotspots show on the map. Each pilot picks a **custom spaceship** from a small palette (the scribble guessed ~5 colours). Ties to **persistence / accounts** (identity + a shared-state layer) and reuses the existing radar. A big social direction — unscoped; capture-for-later, picked up once the single-player frontier is polished.

**SSH version (retired 2026-07-09)** — the Go port of the sim that ran at `ssh rave.fluncle.com` has been dropped: gimmicky rather than playable, and a second surface to carry once the game grows accounts/persistence (which land web-first). The SSH terminal keeps a link out to the web Galaxy; the frozen sim fixtures moved into `apps/web` as golden pins.

**Persistence:** web private accounts sync lifetime Galaxy progress (`me-galaxy.ts` + `game/progress.ts`) without changing active-run cargo; anonymous play stays first-class. The only remainder — cross-surface SSH/CLI login for synced markers — is tracked once under _User accounts → Cross-surface account login_, not duplicated here.

### From Earth to Orbit — the lifecycle arc

**Lifecycle view shipped as `/pipeline` (2026-07-08).** The "make Fluncle's invisible lifecycle the product" idea landed as **`/pipeline`** — a wide, draggable infographic canvas of a finding's whole life (the synchronous add in the Worker → the async enrichment crons → human-gated dispatch → the plaza of every surface → the launch into the Galaxy with the mixtape dream-tail), colour-coded by where each step runs, with a live cron heartbeat off `/api/status`. It **supersedes and retires `/factory`**: the scruffy `/factory` conveyor experiment (`game/factory/*`, `docs/factory.md`) and the "Fluncle Foundry" RFC were removed when `/pipeline` shipped. `/pipeline` is noindexed (a for-the-nerds machinery view).

The remaining, still-**deferred** parts of the arc are the account-touching and generation pieces below — each behind a go/no-go, and **collection deliberately decoupled from public accounts**:

- **2 · Per-track sprite generation — gated on a spike.** An automation that mints a unique pixel sprite per finding (seed: cover art + the vibe placement / four galaxies). This is the one place we want **variety inside the consistency** — and that's exactly the hard, unproven problem: AI generation converges on a shared attractor, so a ~10-sprite spike must prove real variety that still reads as one family **before** the arc commits to it.
- **3 · Collectable sprites in the Galaxy game — private collection.** Each finding becomes a star/sprite you fly to and **collect**, plus a binder-style collection page (empty outlines that fill in on collect). This rides the **existing** private account layer + the Log-ID-keyed progress store (`apps/web/src/game/progress.ts`) — **collection is independent of public accounts**; it works with what ships today.
- **4 · Public accounts + profiles — an optional later flip.** Only if shareable public collections earn it; gated on the Public marginalia RFC (see _User accounts_). Not a prerequisite for anything above.

### Fluncle mobile — ON TESTFLIGHT; store submission imminent

The Expo app went from dark to a TestFlight build on the operator's phone in one arc (2026-07-11/12): feed + archive + finding pages + submissions, the Radio (background audio + lock-screen presence), Mixtapes, archive search, device-local saves, push category toggles, the traveler app icon, and Apple Music links across the whole ecosystem (exact-ISRC, live in prod). The release runbook + the ratified submission kit live in [docs/mobile-release.md](../mobile-release.md); the review posture is [docs/app-store-review.md](../app-store-review.md). Ahead:

- [ ] **Store submission tail (operator):** the 6.9" screenshot set, paste the kit into App Store Connect, submit for review — the softened scrim and the latest JS ride the submission build.
- [ ] **The set builder comes to the pocket (the next build slice; ships as 1.1, does NOT block the submission).** Port `/mix` ("Chain a set") — taste-seeded or opener-seeded, ranked next-track suggestions by key/tempo/feel, re-ranking after every add — as the app's standalone TOOL. It is the strongest minimum-functionality answer we own (an interactive tool, not content browsing), it is the archive RFC's conversion engine on the surface where set ideation actually happens, and the ops are already public (the web tool consumes them), so the port is a thin client. If App Review ever pushes back on 4.2, this doubles as the appeal; otherwise it is the 1.1 headline. v1 is device-local (an in-progress chain persists like saved findings); account sync is the separate slice below.
- [ ] **Galaxy game on mobile (later, after star-sync).** The game joins the app once collected stars persist through accounts (see _User accounts_) so a run continues across surfaces — `@shopify/react-native-skia` is already a trusted dependency at the workspace root, so the render layer has a plausible native path; web-first star sync lands before any port is scoped.
- **Brand marks (parked decision):** `react-native-svg` + `simple-icons` would render SiSpotify/SiApplemusic canon-correctly in the app; HeatButton's icon slot is already wired for it.

### User accounts

- [ ] **Accounts become first-class sync citizens (HIGH — operator-prioritized 2026-07-12).** In-progress chained sets (the /mix builder, web and soon mobile) and Galaxy star collections sync across web ↔ mobile when signed in. **The law, operator-ratified: an account NEVER gates a feature.** The set builder, the game, and everything else stay fully usable anonymous; signing in only SAVES progress across surfaces. Device-local persistence stays the default (the mobile saved-findings pattern is the precedent); the account is the backup/sync upgrade, never the toll booth.

The private web account layer is live (Better Auth email/password + username, `/account`, private Galaxy lifetime progress, saved findings, signed-in submission ownership, export/delete, hard separation from admin auth); anonymous browse, submit, RSS, MCP, CLI, SSH, and Galaxy play stay unchanged. Follow-ups, deliberately separate from that first slice:

- **SSH device login:** the open half of cross-surface login (the CLI `fluncle login` half is done) — SSH device auth for synced Galaxy lifetime markers, saved findings, and own submissions. SSH stays anonymous by default, and the user token stays separate from `FLUNCLE_API_TOKEN`.
- **Authenticated MCP tools:** only if there is a concrete agent use case; keep the existing MCP server/card anonymous until a dedicated auth contract, CORS/header behavior, and failure model exist.
- **Public marginalia RFC:** public crew cards, public submission credit, crew notes, reports, moderation, and profile-like surfaces need their own RFC before implementation. Hard default remains no public writing.
- **Email/password hardening:** decide verification/reset policy, abuse thresholds, disposable-email handling, and support copy once real usage shows the pressure points.
- **Account ops polish:** keep the account env vars prominent (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`) and do a real-data privacy pass on export/delete after a few accounts exist.

### Public feature-ideas inbox — a voteable backlog (idea, 2026-06-24 scribble)

A public, voteable ideas board: visitors / the crew submit feature ideas and **upvote** the ones they want, turning this private roadmap into a public-facing signal of what to build next (the Canny / public-roadmap pattern). Reuses the existing **submission-inbox** shape (the track-submission flow is the precedent) but for ideas, with vote counts ranking the backlog. It is **public writing**, so it inherits the open questions under _User accounts → Public marginalia RFC_: moderation / abuse, **anonymous vs account-gated voting** (one vote per identity), spam, and the no-public-writing default it would deliberately relax. Unscoped capture-for-later — would want that RFC first.

### TikTok auto-pipeline (the capstone)

"Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com` and the system enriches → renders → captions → pushes automatically; the one human step left is a platform limit (attach TikTok's official sound in-app, publish). **The chain is closed** — box-cron enrichment, the `fluncle-render` conductor, the `fluncle-publish-advance` auto-advance, `fluncle-social-capture` flipping captured drafts.

- **✅ Auto-advance render → publish — BUILT, shipped DARK.** The gap is closed: `advance_publish_queue` + the on-box `fluncle-publish-advance` cron (every 30m) chain a freshly-rendered finding into the publish push — the YouTube Short posts hands-off, the TikTok inbox draft lands — with no human tap between the steps. It automates a PUBLIC publish, so it is built on four proved properties (never twice: an atomic `(track, platform)` claim before any Postiz call; never half-rendered: both masters + the whole R2 bundle + a settle window; a default-deny kill switch; fail-closed and visible in the attention queue), and it is **OFF by default** — one operator flip (`fluncle admin publish resume`, or the toggle on `/admin/findings`) turns it on, no deploy. Doctrine: [docs/track-lifecycle.md](../track-lifecycle.md) § _The render → publish auto-advance_. **Remaining: the operator activation** — install the host timer (`docs/agents/hermes/publish-advance-timer/`), watch one paused tick, then resume and watch the first advanced finding land on the channel.
- **More platforms — YouTube is now the autopilot channel; Instagram split.** YouTube Shorts is a direct public upload with **no manual finish**, and with the auto-advance on it runs **fully on autopilot** with nothing left for the human. Instagram splits by content: a **per-finding master stays deferred** (no legitimate API audio path — the master gets muted on a business/creator account, IG's licensed audio is app-only), while **set clips are a separate, now-built path** — the Fluncle Studio clip drip-feed posts them via Postiz (see _Fluncle Studio_). Building the set-clip drip does not re-open the per-finding-master path; that stays parked (see the autonomy ladder's _Deferred_ group). Per-platform doctrine lives in `docs/track-lifecycle.md` (Phase 3) + the `fluncle-publish` skill.

### Fluncle Studio — clipping LIVE, IG drip-feed BUILT (live validation + cron deploy pending)

Turning one long set into many short posts is built and live end to end: `distribute --set-video` stages one 1080p set rendition to R2, an `analyze-set.ts` drop-detection DSP suggests the windows, the `/admin/studio/<logId>` editor frames draggable 9:16 clips keyed by the Log ID coordinate, the on-box `fluncle-studio-clip` cron cuts + ships each `<clipId>/footage.mp4` to R2, and the cross-mixtape library `/admin/clips` hands off **IG (with audio) / TikTok (audio-stripped)** downloads. Doctrine: [docs/fluncle-studio.md](../fluncle-studio.md). (Build note: the box runs the standalone bun **binary** for this — the npm thin client can't.)

What's open:

- **Distribution layer — the clip → Instagram drip-feed.** The Fluncle-owned scheduler is built + deployed (spec: [docs/rfcs/clip-drip-feed-rfc.md](../rfcs/clip-drip-feed-rfc.md)): the schedule/status table + kill-switch KV, `pushInstagramReel`, the agent-tier `drip_clips` tick, auto-queue-on-clip-create with a random 23–25h jitter, and the `/admin/clips` kill-switch + per-clip schedule controls — a validated path distinct from the per-finding-master IG deferral (a live-mixed set clip fingerprints differently and survives). Immediate next steps (operator-gated):
  - **1 · Live IG validation** — fire one real `drip_clips` tick to prove `pushInstagramReel` posts end to end (Postiz → IG) before the cron runs wide. The 4 existing clips all build **empty captions** (they're from the un-cued rolling set `f8f555d2`), so pick a clip + a caption first. The kill switch stays **off** by default, so nothing posts until this first tick is fired deliberately.
  - **2 · Deploy the `clip-drip-sweep.sh` cron to the box** — the on-box tick (`docker cp` into the Hermes container + `hermes cron create`, the `fluncle-social-capture` "box triggers, Worker calls Postiz" shape), landed **only after** the live post is validated, so the drip auto-runs only once the push is known-good.
- **Per-clip captions.** `buildClipCaption` ships the coordinate credit — the finding(s) a clip's window plays (resolved via `resolveClipTracks`), or the promoted mixtape's `.F.` — served to the card and used as the drip caption. Gap: a clip from an **un-cued** recording resolves to no finding, so it builds an **empty** caption (all 4 current clips); the drip wants either finding-linked cues on the source recording or an operator-set caption. A Fluncle-voice auto-draft (`copywriting-fluncle`) on top stays open.
- **Brand frame — decided: no baked overlay.** The clip ships as a clean crop; the credit rides the IG caption. The Remotion-cosmos frame is deferred indefinitely, pending a reason to revisit.
- **Per-track cue labels.** The caption carries the mixtape/finding coordinate today (`buildClipCaption`); naming the specific track playing at a clip's window is the cue-marking synergy the RFC scoped — `resolveClipTracks` / `trackLabel` (`@fluncle/contracts/util`) already resolve it, but nothing surfaces it in the caption yet. Gated on marking cues.

### Brand & canon

- **Moodboard → canon audit (video-side remainder)** — the web overhaul resolved the web half (the logbook plate, ignition hovers, the grain architecture, and the archive grammar are in DESIGN.md now). Still open is the video half: the video-kit laws live in the `fluncle-video` skill doctrine (presence, the plate lane, fixed-pitch / anchored-accent) — decide whether to promote or cross-link them into DESIGN.md canon rather than leave them video-local; cross-link, don't duplicate.
- **Video aliveness — shipped.** Part I landed (`9d12806`): music-reactive renders via the signal-chain dials + the global-vs-internal motion law + an author-time composition lint; the proposed Part II (an LLM judge in the render loop) was prototyped and dropped; grain diversity shipped (#145 — six grain families, the `video_grain` ledger column, the skill doctrine).

### Newsletter — open follow-ups

The Friday newsletter ([docs/agents/newsletter-agent.md](../agents/newsletter-agent.md)) is authored + persisted by the `fluncle-newsletter` box sweep (see _Hermes automation_), with the editions model, the public `/newsletter` archive + `/newsletter/<n>` edition pages, and the `/admin/newsletter` operator front-end all live; the letter copy emits one flat finds block (only the archive still groups by galaxy). What's open:

- **Confirm the Friday cadence** on a real tick — the cron is live, so this is a monitoring item: watch one real Friday 15:00 Amsterdam run to confirm it fires, authors only on a non-empty window, and re-offers an unsent draft rather than double-authoring.
- **Galaxy grouping in the archive.** The archive groups editions by galaxy (Solar → Nebular → Lunar → Astral, the `editions.ts orderedGalaxies` helper) — but with manual vibe-tagging retired, that grouping now depends on the **audio-embedding clusters** (Phase 2 of _Audio embeddings_); until those land, a finding has no galaxy and falls to "Also found." (An archive-only concern — the letter copy no longer groups.)

- **Confirm the Firecrawl scene-`tidbits` populate** on a real tick — they came back empty on an early run (the email renders fine without them, but they're the extra scene color).

### Audio embeddings — automatic sonic similarity + clusters

Supersedes the retired manual vibe-map. A signal test (n=45) proved audio **can't** learn the Light↔Dark placement — it's the operator's ear, not the waveform (best ~48% galaxy vs 36% baseline; the energy axis is weakly learnable, the mood axis isn't) — so the manual tag, justified only as "a model automates it later," is dropped. In its place: a **MuQ** audio embedding per finding (spiked as the best of CLAP/music-CLAP/MERT/MuQ), which gives automatic _sonic_ grouping for free — **"more like this"** nearest-neighbours first, a browse-by-feel lens and the game's solar-systems later — all with **zero tagging**. rave-02 is resized (CPX32 / 8 GB) to host MuQ on-box. The four galaxies stay as brand fiction.

Unnecessarily fun — that's the point.

## The catalogue — Fluncle becomes drum & bass's living archive (RFC written, decisions pending)

The direction that changes what Fluncle _is_: alongside the operator-certified **findings**, a much larger tier of drum & bass tracks Fluncle did **not** certify — stored, audio-analysed, and MuQ-embedded, but with **no Log ID, no galaxy, no video, no note, no observation, no publish**. That asymmetry is load-bearing: the certified finding stays a scarce, hand-touched object; the catalogue is infrastructure.

Full design: **[docs/rfcs/the-archive.md](../rfcs/the-archive.md)** — research + a four-role adversarial panel, grounded in the real code. Its headline claims were corrected against production (the engine is NOT dead — all 60 findings are embedded and the sonic term is live; MuQ was validated by the k=4 galaxy fit). **Storage is proven:** the Turso scale spike returned **GO** — 207 ms filtered vector query at 100k, one round trip; FTS 114 ms; 348 writes/s ([docs/local-database.md](../local-database.md) carries the traps).

**The canon (operator-ratified):** the catalogue is a **utility layer with no narrative voice** — Fluncle never speaks about an uncertified track. Artist pages show findings first, then a quieter "other songs by this artist" section linking out to Spotify (there is no Log ID to link to). **Audio is FULL AUDIO, never 30s previews** (ratified 2026-07-11 — a preview is often all intro, so its vector describes the intro rather than the track; half the catalogue would carry garbage). The **acquisition layer lives in the private companion repo**, never here; this repo knows only that "a captured full song appears in private R2 under a key."

The arc, in the order it wants to be built:

- **0 · Fix the vector path first (prerequisite, in flight).** `getSimilarFindings` pulls every embedding into the isolate and ranks in JS — it hard-fails at ~460 findings locally and silently grows toward OOMing the Worker in prod. Vectors move to `F32_BLOB` (82% smaller DB), ranking moves into SQL with a key/BPM pre-filter. **Every item below depends on this.**
- **1 · The Ear — `/admin/catalogue`, ranked "closest to your findings, not yet logged."** The RFC's sharpest product insight, and the cheapest thing on this list. The operator finds ~15 bangers a week, so volume is _not_ his constraint — but that pace is necessarily **shallow and recency-biased**, surfacing whatever the feeds put in front of him while whole regions of the genre (older releases, small labels, the long tail) never cross his path. This is a **telescope, not a conveyor belt**: it points at tracks sitting near what he already loves. Needs no public surface and no 100k. **Build it first; it pays for the crawler.**
- **2 · The crawler — structured graph traversal, not web spidering.** Seed from the labels already in the archive → MusicBrainz / Discogs / Spotify release graphs → artists → labels → outward, with a DnB-boundary gate keeping it in-lane. Deterministic, resumable, polite. **Spotify cannot be the backbone** — its Feb 2026 lockdown removed the batch endpoints, capped `search` at 10 results, and stripped `genres`/`popularity`/`label` (we hit the 403 live during the artist-avatar backfill); MusicBrainz + Discogs carry the traversal, Spotify is demoted to per-track ISRC lookups.
- **3 · The graph surfaces — labels (entity + pages), album pages, search.** **Labels become a first-class entity** — the same `labels` table serving two jobs: the public label pages, and the **crawl-seed allowlist** the operator manages. Each label carries a seed state (`enabled` / `disabled` / `undecided`); a label appearing on a new finding enters as `undecided` and surfaces in the **attention queue** ("a new label to rule on"), decided with one keystroke. The toggle is strictly **crawl-scope, never storage** — disabling removes a label from the _next_ crawl's seeds and touches nothing already stored. `tracks.label` already exists (~40 distinct labels). Labels and albums are the missing thirds of the graph (log ↔ artist ↔ **label** ↔ **album**), and they are where a catalogue actually pays: real informational pages, cross-linked, crawlable. Thin-content gates apply (the `ARTIST_INDEX_MIN_FINDINGS` precedent). A public **search** surface lands here — at catalogue scale it _is_ the primary navigation.
- **4 · `/mix` goes public — the free tool that is the whole point.** The mixability engine is built and admin-gated behind a ~250-finding floor; **the catalogue dissolves that gate** (it was about chain depth, and a catalogue _is_ depth). Archive tracks flow into suggestions (findings visually distinct; catalogue rows link to Spotify), and **taste-seeding** ships with it ("pick 5–10 artists you like" → tailored suggestions). This is the conversion engine: a genuinely useful free DnB mixing tool that nobody else has, that gets _better_ the bigger the archive grows, and that brings strangers to Fluncle. **Building the catalogue without flipping `/mix` public is a fuel tank with no car.**

**Open decisions gating the crawl** (RFC §13): the real target size (Discogs holds only ~41k _deduped_ DnB masters — 100k is larger than the recorded genre), the public name for the tier ("the archive" already means the findings), two canon amendments, and — five minutes of operator time that determines the crawl's entire quality — **~8 of the 39 seed labels are not DnB** (Anjunabeats, Armada, Axtone).

## Homogenisation — the next big slice (2026-07-11)

**The observation that names it:** Fluncle's generated artifacts drift toward a mean. It has now been seen independently in two places, which is what makes it a property rather than a pair of bugs.

- **The notes.** Measured, not guessed: the word "shoulders" appears in **15 of 61** live notes; "I've been rewinding it since" is lifted verbatim between two. The un-layered auto-note reproduced a standing GLXY note almost word for word. (The vibe-neighbour layer + echo gate is the first counter-measure — it works by handing the model the neighbourhood's moves as **spent**, and it measurably _reduced_ within-region overlap, 0.041 → 0.015.)
- **The videos.** They are far better than they were, but the models still skew to the same vehicles. The video work already learned the general law and wrote it down: **parallel generation converges on a shared attractor, so diversity has to be DESIGNED IN, not hoped for** (assign each agent a distinct structural family at launch; prescriptive mid-flight coaching increases convergence rather than fixing it).

**Why it matters more than it looks.** Fluncle's whole claim is that a human with taste went out, dug, and came back with something. An archive whose every artifact rhymes with its neighbours reads as machine-made — which is exactly the thing the persona cannot afford. Sameness is not an aesthetic nit here; it is a credibility leak.

**The shape of the slice (unscoped — wants a real design pass):**

- **Measure it first, everywhere.** The note work shipped `scoreNoteEcho` + a `--dry-run` harness, so the claim stays falsifiable. Every generated artifact family (notes, observations, logbook entries, videos, covers, sprites) wants an equivalent: a cheap, honest diversity metric, run on the real corpus, that tells us whether we are getting worse. **An anti-sameness effort with no metric is folklore.**
- **Spend the moves.** The mechanism that worked for the notes generalises: show the generator what its neighbours already did, and require it to find what is true of _this_ one and nothing else.
- **Design the diversity in.** Per the video law: assign the family/angle up front rather than asking for variety.
- **The long-term drift risk, stated honestly.** The "spent moves" mechanism pushes each new artifact away from what came before. At 61 notes that is a fix. At 300 it could push the voice off its own centre. **Re-measure as the corpus grows** — the harness makes that one command.

**It composes with prompts-in-the-database (below): fighting sameness is an iterative, taste-driven loop — change a prompt, read ten outputs, change it again — and a loop that needs a redeploy per iteration is a loop nobody runs.**

## Prompt management — the `claude -p` prompts belong in the database (idea, 2026-07-11)

Every agentic sweep (the auto-note, the observation script, the Logbook entry, the triage verdict, the context-note distil) carries its prompt as a **string in the repo**. Tuning one means a code change, a review, a deploy, and a box rebake. That is a heavy loop for a thing whose whole nature is iterative — and it is the loop we will be running constantly once we take the homogenisation slice seriously.

**The shape:** prompts live in the database, versioned; the sweeps read them; the operator edits them from `/admin` and the CLI without a deploy.

**The traps, because a prompt IS code:**

- **A bad live edit silently degrades every artifact it touches** until a human notices. So: versioning, a visible diff, and a one-action rollback are not polish, they are the feature.
- **A sweep must NEVER break because a prompt row is missing.** The repo keeps a baked-in default; the DB row overrides it. A failed read falls back and logs, it does not throw.
- **The voice gates stay.** A prompt the operator can edit live is not a licence to bypass the gate that keeps Fluncle sounding like Fluncle.
- **Prompt provenance on the artifact.** If a note was drafted under prompt v7, that should be recoverable — otherwise "the notes got worse last week" is an unanswerable question.

## ChatDnB — chat with Fluncle (idea, 2026-07-11)

**The name is the whole reason this exists, and it is worth it.** ChatGPT. A hard `G` sounds like a `D`. A `T` sounds like a `B`. **ChatDnB.** It is a pun that lands in about a second and a half, and once you have heard it you cannot un-hear it.

**And here is the part that turns a joke into a product: every piece is already built.** Fluncle ships a **public MCP server** — a real, agent-facing interface to the archive, already registered in `@fluncle/registry`, already documented at `/docs/mcp`. ChatDnB is a **chat surface over an MCP we already serve to other people's agents.** The hard part was done months ago for a different reason.

What it would be: a chat where you talk to **Fluncle himself** — the traveller-uncle, in his own voice (`VOICE.md`, the `copywriting-fluncle` skill) — and he answers **out of the archive**, not out of a model's memory. The MCP tools are the hands:

- _"What have you found on Hospital Records?"_ → the label graph.
- _"Play me something that sounds like Nine Clouds."_ → the **sonic search** (`soundsLike` → the MuQ embedding → `vector_distance_cos`). **No other DnB chat can do this**, because no one else has the archive embedded.
- _"Build me a set at 174 in F minor."_ → the **mixability engine** (key 0.5 · sonic 0.35 · bpm 0.15, Camelot-harmonic).
- _"What is 004.7.2I?"_ → the coordinate resolves, because coordinates are the whole point.

**The rails that make it Fluncle rather than a chatbot:**

- **He answers from the archive or he does not answer.** The one thing that would kill it is Fluncle hallucinating a banger he never found. The MCP is not a garnish on a general model, it is the **only source of truth** — the same discipline the search's LLM tier already has (the model emits FILTERS, never rows, so it _cannot_ invent a track). **Grounding is the product.**
- **He never speaks about an uncertified track** (ratified canon). The catalogue is a utility layer with no narrative voice.
- **The voice gate applies.** Whatever ships under Fluncle's name is bounded by canon — and this is him _talking_, which is the most exposed his voice ever gets.

**Where it lives:** `chatdnb.com` redirects to an unrelated site, so it is taken. `chat.fluncle.com` or `/chat` works fine; the pun survives the URL. (And a subdomain keeps it inside the Galaxy rather than orphaning it.)

**Open questions worth a real design pass:** which model drives it (the FluncleLLM voice fine-tune below is an obvious future consumer, but a well-prompted frontier model with a hard MCP-only grounding rule is the honest v1); how a chat surface stays _quiet_ and cover-led rather than becoming a SaaS chat window (`PRODUCT.md` bans the streaming-app clone by name); rate-limiting and abuse for an anonymous public LLM surface; and whether it is a public front door or a crew toy first.

Unnecessarily fun — which, per the audio-embeddings entry, is exactly the point.

## The Fluncle models — the voice, the eye, the ear (idea, 2026-07-11)

One arc, three probes. Fluncle already generates — notes, observations, logbook entries, shader videos, sprites, covers — but always by **constraining a stranger**: a general model held in line by a prompt, a skill, and a voice gate. The question this arc asks is what changes when the model has **only ever known Fluncle**.

Three fine-tunes, three faculties. They share a method (LoRA on an open-weight model, rented GPU, single-digit dollars), a discipline (run behind the existing gates, not instead of them), and a rule.

**The rule — and it is the only one that matters here: the line is PUBLISHING, not EXPERIMENTING.** What ships under Fluncle's name is bounded by canon. What we _try_ is not. Probing, pushing, and following curiosity into the not-yet-known is exactly what this project is; refusing an experiment because its _product_ would be off-brand is the incurious move Fluncle would never make. **Never confuse "do not ship it" with "do not try it."** An experiment that teaches us something and ships nothing has done its job.

Where the models run: the private companion repo (`fluncle-labs`, see AGENTS.md) — corpora, training scripts, and artifacts stay there. Findings graduate to this repo as ideas; code and weights do not.

### 1 · The voice — a model that writes like him

Fine-tune on **Fluncle's own written corpus**: the editorial notes, the spoken observation scripts, the Logbook travelogue entries, the Telegram posts, the newsletter editions. Every word was authored for this project and most of it is operator-verified, which makes this the rare fine-tune with **no legal question at all** — the corpus is ours outright.

The prize: the voice gates and the `copywriting-fluncle` skill work, but they work by _constraining a stranger_. A model fine-tuned on the corpus would carry the register natively — the said-not-written rhythm, the Dry Rule, the recovered-log idiom, the em-dash law — and the drift the gates currently catch would mostly stop happening. It compounds, too: every operator edit to an auto-note is a training signal, so the thing gets more Fluncle over time (the note-agent's correction pairs are already the seed of that dataset — see _Auto-drafted finding notes_).

Shape: assemble the corpus (with the operator's edits as the preferred targets), LoRA a small instruct model, run it **behind the existing voice gates** — the gates stay as the safety net, and the win is measured by how rarely they fire. First consumer: the auto-note (highest volume, already fill-empty-only, already has correction pairs). Honest open question: is the corpus thick enough yet? (It is growing fast — ~15 findings/week means ~15 notes + ~15 observations a week, so "wait for more" is a matter of weeks, not years.) And does a fine-tune actually beat a well-prompted frontier model at this scale? A genuine spike, not a foregone conclusion.

### 2 · The eye — generation as Fluncle's imagination

The other place generation is unambiguously on-brand: the visuals are **Fluncle's own imagination**, not someone else's recording. Nobody is infringed, no canon is contradicted (the whole Nostalgic Cosmos is already machine-made under the operator's eye), and the failure mode is aesthetic rather than legal.

Deepen the per-asset scripts into a real generative capability — a model or pipeline **pointed at a finding** that produces its scene, its sprite, its cover, all in one family, seeded by what the archive already knows about it: the cover art, the MuQ embedding, the galaxy it landed in, the BPM and key, the note. This is where the archive's data pays a _visual_ dividend — a finding's embedding is a genuine seed for what its scene should look like, which no stock generator can do.

Absorbs: **per-track sprite generation** (already a gated spike under _From Earth to Orbit_ — its hard part, variety-inside-consistency, is exactly a generative-model problem), the video kit's texture families, and the galaxy's visual identity now that the galaxies are data-real. The known trap is the one the video work already documented: parallel generation converges on a shared attractor, so **diversity has to be designed in, not hoped for**.

### 3 · The ear — a model trained on what he certified (internal only)

**Not a product. An experiment — and the corpus is already sitting there, growing ~15 tracks a week.** All 60 findings carry captured full audio, which is not a _drum & bass_ corpus: it is **the 60 tracks Fluncle personally certified**. A LoRA on that is not a genre model, it is a model of one person's _taste_, asked what it dreams. Canonically that is what a mixtape already is (LORE: the mixtape is Fluncle dreaming — short-term memories settling into one long blended one), which makes the artifact interesting on its own terms even if not one second of it is ever heard by anyone but us.

**The experiment is better than "can it make DnB."** The captions carry the galaxy name, so the real question is: **prompt it with "solar" and does it sound like Solar?** If the model learned the galaxies from audio alone, that is _independent_ evidence — arriving from a completely different direction than clustering — that the MuQ space carved along boundaries a human actually hears. That is a real finding about the archive's foundational assumption, and it costs about three dollars to get.

Model (2026-07-11 research): **ACE-Step 1.5** — **MIT on code _and_ weights**, no revenue cap, no NC clause, no gating; the only permissive model that is also 48 kHz stereo and long-form, and it ships an official LoRA/LoKr trainer. 16–20 GB VRAM; 60 songs lands right in its published band (~500–800 epochs). An RTX 4090 on RunPod (~$0.34/hr) does it in about an hour. (Runners-up: HeartMuLa sounds better but ships no trainer and will not say what it was trained on; Stable Audio 3 has the cleanest data story but a $1M revenue cap; MusicGen is CC-BY-NC and frozen.)

**Prepped and ready to run** in the companion repo (`experiments/dream-lora`): the corpus export, the captions, the presigned pull onto the pod, the whole runbook.

**The hard rail — a PUBLIC Fluncle music generator is rejected, and that is not in tension with running this.** Shipping AI-made DnB under Fluncle's name fights the canon head-on (PRODUCT.md: a mixtape is authentically Fluncle _"where an AI-made original would fight the persona"_) and his whole credibility is that a human with taste went out, dug, and certified. So: the artifact is **internal only** — never published, never on a public surface, never in a mixtape, never sold, never presented as Fluncle's music. Its value is what it **teaches**, not what it emits. A surprising result is a **finding**, not a **release** — and it feeds the voice and the eye, which are the two faculties that _do_ ship.

### Auto-drafted finding notes — the vibe-neighbour refinement (SHIPPED 2026-07-11)

The board takes an optional **note** per finding — the editorial "why" that renders on the `/log/<id>` page and feeds its definitional prose + `MusicRecording` schema, so a note is real SEO/AEO value, not just operator chrome. The v1 auto-note (context-note-grounded, voice-gated, fill-empty-only) has been running; the **vibe-neighbour refinement** is now built on top of it.

The auto-note is authored against the notes of the finding's nearest neighbours in **vibe space** — the MuQ audio embedding (`get_similar_findings` / `fluncle tracks similar`), **not** `features_json`. A note encodes a subjective read of how a finding FEELS; two tracks can measure nearly identical and land nowhere near each other by feel, so a feature-twin's note would carry the wrong vibe. The neighbourhood layers INTO the live context-grounded generation (it never replaces it) as a list of moves that are already **spent** — the cluster informs, it never templates.

The guardrail is **mechanical**, because "a note that reads like every other note in its galaxy is worse than none" is the whole risk of the feature: the Worker's **echo gate** (`gateNoteEcho`) re-reads the same neighbour notes the agent was shown and rejects a line that lifts a phrase from one or reuses its words wholesale. A rejected note is not stored — the note stays optional, and silence beats a generic line. `NOTE_NEIGHBORS=0` is the kill switch. Doctrine: [docs/agents/note-agent.md](../agents/note-agent.md).

**Measured before shipping** (12 real findings across two sonic regions, authored with and without the layer): the neighbour arm CUT intra-region sameness (mean pairwise word overlap 0.041 → 0.015) and stock-move reuse against the whole archive (0.136 → 0.115), with zero lifted phrases and zero gate rejections. The layer made the notes more finding-specific, not less. The dry-run harness (`note-sweep.ts --dry-run`, paired with `NOTE_NEIGHBORS=0` for the control) re-runs that measurement whenever the corpus, the model, or the prompt changes.
