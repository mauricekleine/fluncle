# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

## Now — the production loop is running

The add → live pipeline is operational end to end — the one `/admin` cockpit board, the deterministic `--no-agent` per-finding sweeps on the Hermes box, the hands-off `fluncle-render` conductor, and board-driven publishing (YouTube hands-off, TikTok drafted + auto-captured). What's left of the loop is ongoing operation, not build work; the last autonomy gap — auto-advancing render → publish so the chain runs without an operator beat between steps — lives in **Later → TikTok auto-pipeline**.

### The autonomy ladder

The full path a finding travels: one human act (Maurice finds the banger and adds it — manual by design, "Maurice discovers, Fluncle does the rest"), instant synchronous fan-out to ~10 surfaces (Spotify · Telegram · web · CLI · API · MCP · RSS · SSH · both Galaxy games), then the async `--no-agent` box sweeps run on their own (enrich → context note → note → observation → render). What's left is the manual tail, roughly in order, and where each one automates:

- **Tag — retired.** Manual vibe-placement is dropped (audio can't learn it, and nothing critical read it); the galaxy grouping it fed moves to automatic **audio-embedding clusters** (see _Audio embeddings_). One fewer manual step.
- [ ] **Note** the editorial "why". The auto-note drafts a first pass per finding (fill-empty-only); the operator still verifies/edits, and those edits grow the corpus. A richer vibe-neighbour version is downstream of the vibe model — see _Auto-drafted finding notes_.
- [ ] **YouTube** Shorts — the operator triggers the push today (the upload itself is hands-off: title + caption). Goes fully auto when the render → publish auto-advance lands — the one channel that needs no in-app finish. See _Later → TikTok auto-pipeline_.
- [ ] **TikTok** — drafted to the inbox from the board; the operator finishes in-app (attach the official sound, publish), then `fluncle-social-capture` flips the captured draft → published on its own. Manual by design — no legitimate API audio path. The last per-finding beat.
- [ ] **Newsletter (Friday)** — the sweep drafts + persists the weekly edition and offers the literal `fluncle admin newsletter send <id>` command; the send stays an operator tap. The one weekly-cadence step. See _Later → Newsletter — open follow-ups_.

**Deferred (on purpose)** — a surface we could reach but choose to leave dark: **Instagram** (`@fluncle`) — the per-finding master stays deferred (no legitimate API audio path — it gets muted on a business/creator account, IG's licensed audio is app-only; parked, not closed), while set clips are re-opened — a live-mixed DJ-**set** clip fingerprints differently and survives, so the Fluncle Studio clip drip-feed posts set clips to IG on a jittered daily cadence with a kill switch (see _Fluncle Studio_).

**The shape:** one human add → instant parallel fan-out → a deterministic async pipeline → a shrinking manual tail. Of that tail, tag is retired (audio embeddings replace its grouping) and YouTube falls to the render → publish auto-advance; TikTok and the Friday newsletter send stay deliberate human taps, each blocked by an external platform limit, not by us.

## Next — surface what we make, and tidy reliability

### Live visuals — free mixing without a preloaded tracklist (Tier B, gated on full-audio)

Today the live matcher is **closed-set**: at show start it fingerprints each _planned_ track's 30s preview and only ever asks "has the next planned track started?" (`packages/live/src/bridge/matcher.ts` — a pointer-relative search against current/pending/pending+1; RFC §4 already names whole-catalogue matching as the unbuilt v2). That is why a fixed Rekordbox tracklist must be preloaded before the first beat. The prize is to **drop the tracklist and mix freely** — open-set identification of whatever is actually playing, matched against the whole archive, so the visuals follow the set by ear instead of by plan.

This is **gated on full-audio landing first** ([docs/full-audio-rfc.md](./full-audio-rfc.md)): Tier A there swaps the live reference from the 30s preview to the full song, which both fixes the "reference is only a 30s slice, so a mix-in outside it can never match" miss and is the prerequisite for any open-set path. Open-set itself is a real project, not a byproduct — it must survive DJ **pitch/tempo/EQ** (log-mel cosine is invariant to none of them), **mix overlap** (two tracks at once is an ambiguous blend), and **archive-scale search** (an index, not brute cosine per window). The promising architecture reuses the MuQ embeddings: embed the live window, nearest-neighbour it to a top-K shortlist, then confirm the exact track with the existing `bestOffsetScore`. Gets its own scoping/RFC pass once full-audio is in.

### Artist championing — Spotify auto-follow blocked by Development mode

The artist-relationship epic shipped: the canonical artist entity, the public artist pages, the `/admin/artists` station (the "Yours" follow queue with confirm / add-remove-platform / Follow-now / Undo / mute), and the on-box `fluncle-artist-follow` sweep. Manual register + YouTube follow work; **Spotify auto-follow does not.** Spotify's artist-follow endpoint (`PUT /me/following?type=artist`, `user-follow-modify`) 403s for our app, and it's provably not our side: with the exact same token, a `playlist-modify-public` write returns 200 while the artist-follow 403s — so it's neither scope, account allow-list, nor Premium (verified 2026-07-07, after a full remove-app + re-auth and even a Premium upgrade). It's the **Development-mode endpoint gate**; the only lift is Extended Quota Mode, which since 2025-05-15 is **org-only** (≥250k MAU, a registered business entity) and unavailable to Fluncle.

Current handling (shipped, not a stopgap): the Follow-now / Undo platform writes are **best-effort** — they record the follow-state and surface a soft `platformWarning` instead of hard-gating on the 403, so a Spotify row stays markable and the operator follows manually. Down the line:

- **Revisit if the gate lifts** — Spotify reopening broader Web API access to dev-mode apps, or a Fluncle business entity ever qualifying for Extended Quota. Low priority; the manual path covers it.
- **Validate YouTube auto-follow at ship** — it's a separate API (`subscriptions.insert`, the `@fluncle` grant) and isn't subject to this gate, so the auto-follow sweep's YouTube leg should genuinely work; confirm with one real follow once the sweep runs.

### Hermes automation — follow-ups

The per-finding pipeline runs entirely as `--no-agent` crons on the Hermes box (enrich, context-note, note, observation, backfill, render, social-capture, studio-clip, newsletter, plus the host healthcheck timer); the source of truth is `docs/agents/hermes/cron/` + the sweep sources in `docs/agents/hermes/scripts/`, managed on the devbox via the **fluncle-hermes-operator** skill. Operating doc + roles: [docs/agents/hermes-agent.md](./agents/hermes-agent.md). Ongoing operation is a verify pass per job, not build work. One follow-up stays separate from the cron wiring:

- **Non-root-in-container (defense-in-depth, low priority).** Run the agent as a non-root user with the token out of its readable env. Now that the token is `agent`-scoped this no longer guards the publish boundary — it only protects the agent's own surface and the token value from a fully-compromised agent, plus hardens against a container escape. Worth doing before any wider/public allow-list; not a blocker for the current private/trusted setup.

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

### Developer & discovery surfaces — the long tail

The machine- and developer-facing surfaces mapped in [docs/surfaces-doctrine.md](./surfaces-doctrine.md) (dig, versioned contract-first API, the Fumadocs `/docs` hub, feeds, CLI distribution, SSH deep-links) are live. What's open:

- **The non-gating tail:** the `today` dig label, a public changelog, a Docker image, broader data-graph anchors (Discogs, Last.fm, ListenBrainz), and directory listings (Product Hunt, Internet Archive, a Hugging Face dataset). Each becomes a registry entry in [docs/surfaces-doctrine.md](./surfaces-doctrine.md) when one earns its keep.

### Fluncle Lens (Chrome extension) — open follow-ups

Fluncle Lens (`apps/extension`) — the MV3 extension that turns `fluncle://<coord>` Log IDs anywhere on the web into `/log/<coord>` links — is live in the [Chrome Web Store](https://chromewebstore.google.com/detail/efkkceaofendabikblfjhoepgejfpakk) with the `extension.lens` registry fan-out done; the listing/privacy-form answers that recur on every version update are captured operator-side. What's open:

- **Announce to the crew.** A quiet line to the crew (Telegram / the Friday letter), drafted in Fluncle's voice and operator-sent.
- **Future features.** Beyond Log-ID linkification, any richer Lens behaviour is open-ended — translate ideas into Fluncle's terms when picked up (canon wins per `AGENTS.md`; the source brainstorm leaned on banned words like "signals").

### Tor `.onion` surfaces — SSH onion deferred

The Fluncle web onion is live on the rave VPS, proxying `www.fluncle.com` (API/RSS/MCP as free riders) with the `Onion-Location` pill; deployment shape + key custody: `docs/tor.md`. What's open:

- **The rave SSH onion (deferred).** A second onion identity → the SSH terminal was scoped but deferred; stand it up if the flex earns its keep.

### Database latency — evaluate Turso → Cloudflare D1

Turso (libSQL) is the source of truth, hosted in **Ireland**, so every Worker→DB read pays a cross-region hop — a real chunk of the `/log/<id>` ~896 ms cold TTFB (the Worker runs at the edge near the reader; the database doesn't). Cloudflare-native **D1** co-locates with Workers and would shrink that roundtrip. The catch is migration cost: D1 is SQLite with its own ceilings (database-size and write-throughput limits, no libSQL-only features), and the whole Drizzle data layer, migration history, and the per-worktree local-dev story (`turso dev` + `.dev/local.db`, see `docs/local-database.md`) would move with it — a real arc, not a config flip.

The near-term cheaper win — edge-caching the `/log` HTML (short TTL + stale-while-revalidate + purge-on-change) — already takes the cross-region hop off the hot read path for cached pages. That makes D1 the **deeper** structural lever, not the next one: pursue it only when DB latency (not render time or asset weight) is the proven bottleneck on the paths the edge cache doesn't cover. Spike it first — confirm D1's limits fit the catalogue and access patterns, and that nothing in the current libSQL usage is load-bearing — before committing to the migration.

### radio.fluncle.com — watch items

The synchronized broadcast is live and hardened — a shared clock + fast offset-join, atomic A/V sync + wake lock, a tuning-in loading gate, synced word-level subtitles + live-narration captions, and a first-class homepage home. What's open is watching, not building: keep an eye on the shared media-loading stall watchdog (`use-video-recovery.ts`) for recurrence on flaky cellular, and the station fills out as the observation backfill runs — eligibility = `video_squared_at AND observation_audio_url` (see _Catalogue backfills_).

### Fluncle's own mixtapes — open follow-ups

The mixtape spine, the `/admin/mixtapes` editor + on-the-fly covers, and the `fluncle admin mixtapes distribute` autopublish (video→YouTube + audio→Mixcloud on our own OAuth, mint-first) are all live. Runbook + spine model: **[packages/skills/fluncle-mixtapes](../packages/skills/fluncle-mixtapes)**. What's open:

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

**SSH version (the flex)** — live at `ssh rave.fluncle.com`: a Go port of the sim (`apps/ssh/internal/galaxy`) kept in lockstep with the JS source by parity tests. Remaining named fast-follows: SSH experience polish, Kitty-input, ambient-crew.

**Persistence:** web private accounts sync lifetime Galaxy progress (`me-galaxy.ts` + `game/progress.ts`) without changing active-run cargo; anonymous play stays first-class. The only remainder — cross-surface SSH/CLI login for synced markers — is tracked once under _User accounts → Cross-surface account login_, not duplicated here.

### From Earth to Orbit — the factory arc (deferred)

**Deferred (2026-07-06).** The Galaxy already carries a lot of layers; the near-term focus is content and stabilizing what's shipped before introducing a new one. A great idea for when that's solid — not the next build. The detail below stays build-ready for then.

It makes Fluncle's currently-invisible lifecycle **the product** — a finding's life, made playable: **Found** (on Earth) → **assembled** (the Factory line) → **launched** (into orbit) → **collected** (in the Galaxy). Three views of one world, joined by the finding travelling through them and the `@fluncle/sprites` system as the shared visual language; the `launch` generalizes the Earth→`/galaxy` rocket bridge so every finished finding makes that trip.

Phased so the standalone win ships first and the hard, account-touching parts come later — each later phase behind a go/no-go, and **collection deliberately decoupled from public accounts**:

- **1 · Public `/factory` page — the goal, and it stands completely alone.** A full-screen conveyor where a finding rides a **station per lifecycle stage** (intake → spectrograph → press → recording booth → render bay → dispatch dock → address printer → launch pad), each a distinct sprite-system machine. The state is **real, not faked**: each finding's belt position derives from the same enrichment/publish fields `/status` and the admin board already read (exposed on `/api/tracks`). **Queues are the point** — findings pile up in front of the slow stations, so the render/enrich backlog becomes physical and honest. **Poll-first** (zero new infra). Independent of sprite generation and accounts. _v1 shipped scruffy-but-real (noindexed, `apps/web/src/game/factory/*`, `docs/factory.md`)._ The iterate-hard pass toward the detailed "Fluncle Foundry" look is specced build-ready in **[docs/rfcs/fluncle-foundry.md](./rfcs/fluncle-foundry.md)** (Forge: 5 research threads + /taste + a 4-role adversarial panel) — **art-first + gated, diegetic-not-dashboard, the FINDING as the lit hero (machines recede), honest readouts, retinted to canon.** The design risk is **canon, not data** (a moving conveyor is busy by nature → execute calm: one sun tracking the active cover, no metrics panel — the pile IS the queue). One vision call still gates the bigger build: **find-vs-make** is resolved in the RFC (locked as a sort/stamp/dispatch house, not a fabrication plant — "Foundry" disfavoured), leaving **scroll-belt vs fixed-painting**.
- **2 · Per-track sprite generation — gated on a spike.** An automation that mints a unique pixel sprite per finding (seed: cover art + the vibe placement / four galaxies). This is the one place we want **variety inside the consistency** — and that's exactly the hard, unproven problem: AI generation converges on a shared attractor, so a ~10-sprite spike must prove real variety that still reads as one family **before** the arc commits to it.
- **3 · Collectable sprites in the Galaxy game — private collection.** Each finding becomes a star/sprite you fly to and **collect**, plus a binder-style collection page (empty outlines that fill in on collect). This rides the **existing** private account layer + the Log-ID-keyed progress store (`apps/web/src/game/progress.ts`) — **collection is independent of public accounts**; it works with what ships today.
- **4 · Public accounts + profiles — an optional later flip.** Only if shareable public collections earn it; gated on the Public marginalia RFC (see _User accounts_). Not a prerequisite for anything above.

### User accounts

The private web account layer is live (Better Auth email/password + username, `/account`, private Galaxy lifetime progress, saved findings, signed-in submission ownership, export/delete, hard separation from admin auth); anonymous browse, submit, RSS, MCP, CLI, SSH, and Galaxy play stay unchanged. Follow-ups, deliberately separate from that first slice:

- **SSH device login:** the open half of cross-surface login (the CLI `fluncle login` half is done) — SSH device auth for synced Galaxy lifetime markers, saved findings, and own submissions. SSH stays anonymous by default, and the user token stays separate from `FLUNCLE_API_TOKEN`.
- **Authenticated MCP tools:** only if there is a concrete agent use case; keep the existing MCP server/card anonymous until a dedicated auth contract, CORS/header behavior, and failure model exist.
- **Public marginalia RFC:** public crew cards, public submission credit, crew notes, reports, moderation, and profile-like surfaces need their own RFC before implementation. Hard default remains no public writing.
- **Email/password hardening:** decide verification/reset policy, abuse thresholds, disposable-email handling, and support copy once real usage shows the pressure points.
- **Account ops polish:** keep the account env vars prominent (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`) and do a real-data privacy pass on export/delete after a few accounts exist.

### Public feature-ideas inbox — a voteable backlog (idea, 2026-06-24 scribble)

A public, voteable ideas board: visitors / the crew submit feature ideas and **upvote** the ones they want, turning this private roadmap into a public-facing signal of what to build next (the Canny / public-roadmap pattern). Reuses the existing **submission-inbox** shape (the track-submission flow is the precedent) but for ideas, with vote counts ranking the backlog. It is **public writing**, so it inherits the open questions under _User accounts → Public marginalia RFC_: moderation / abuse, **anonymous vs account-gated voting** (one vote per identity), spam, and the no-public-writing default it would deliberately relax. Unscoped capture-for-later — would want that RFC first.

### TikTok auto-pipeline (the capstone)

"Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com` and the system enriches → renders → captions → pushes a draft automatically; the human steps stay manual on purpose (attach the official sound, finish, publish). Most of the chain already runs on its own (box-cron enrichment, the `fluncle-render` conductor, `fluncle-social-capture` flipping captured drafts). What's left to make it fully autonomous:

- **Auto-advance render → publish.** The render and publish steps each run on their own, but a finding still needs an operator beat between them — render fires on its hourly tick, then the push is triggered separately from the board. Close the gap so a freshly-rendered finding auto-advances into the publish push (YouTube hands-off, TikTok to the inbox draft) without a human tap between the steps — the chain running end to end on its own.
- **More platforms — YouTube the autopilot-ready channel; Instagram split.** YouTube Shorts is a direct public upload with **no manual finish**, so once the auto-advance above chains render → publish it runs **fully on autopilot** with nothing left for the human. (Flagged, not urgent.) Instagram splits by content: a **per-finding master stays deferred** (no legitimate API audio path — the master gets muted on a business/creator account, IG's licensed audio is app-only), while **set clips are a separate, now-built path** — the Fluncle Studio clip drip-feed posts them via Postiz (see _Fluncle Studio_). Building the set-clip drip does not re-open the per-finding-master path; that stays parked (see the autonomy ladder's _Deferred_ group). Per-platform doctrine lives in `docs/track-lifecycle.md` (Phase 3) + the `fluncle-publish` skill.

### Fluncle Studio — clipping LIVE, IG drip-feed BUILT (live validation + cron deploy pending)

Turning one long set into many short posts is built and live end to end: `distribute --set-video` stages one 1080p set rendition to R2, an `analyze-set.ts` drop-detection DSP suggests the windows, the `/admin/studio/<logId>` editor frames draggable 9:16 clips keyed by the Log ID coordinate, the on-box `fluncle-studio-clip` cron cuts + ships each `<clipId>/footage.mp4` to R2, and the cross-mixtape library `/admin/clips` hands off **IG (with audio) / TikTok (audio-stripped)** downloads. Doctrine: [docs/fluncle-studio.md](./fluncle-studio.md). (Build note: the box runs the standalone bun **binary** for this — the npm thin client can't.)

What's open:

- **Distribution layer — the clip → Instagram drip-feed.** The Fluncle-owned scheduler is built + deployed (spec: [docs/clip-drip-feed-rfc.md](./clip-drip-feed-rfc.md)): the schedule/status table + kill-switch KV, `pushInstagramReel`, the agent-tier `drip_clips` tick, auto-queue-on-clip-create with a random 23–25h jitter, and the `/admin/clips` kill-switch + per-clip schedule controls — a validated path distinct from the per-finding-master IG deferral (a live-mixed set clip fingerprints differently and survives). Immediate next steps (operator-gated):
  - **1 · Live IG validation** — fire one real `drip_clips` tick to prove `pushInstagramReel` posts end to end (Postiz → IG) before the cron runs wide. The 4 existing clips all build **empty captions** (they're from the un-cued rolling set `f8f555d2`), so pick a clip + a caption first. The kill switch stays **off** by default, so nothing posts until this first tick is fired deliberately.
  - **2 · Deploy the `clip-drip-sweep.sh` cron to the box** — the on-box tick (`docker cp` into the Hermes container + `hermes cron create`, the `fluncle-social-capture` "box triggers, Worker calls Postiz" shape), landed **only after** the live post is validated, so the drip auto-runs only once the push is known-good.
- **Per-clip captions.** `buildClipCaption` ships the coordinate credit — the finding(s) a clip's window plays (resolved via `resolveClipTracks`), or the promoted mixtape's `.F.` — served to the card and used as the drip caption. Gap: a clip from an **un-cued** recording resolves to no finding, so it builds an **empty** caption (all 4 current clips); the drip wants either finding-linked cues on the source recording or an operator-set caption. A Fluncle-voice auto-draft (`copywriting-fluncle`) on top stays open.
- **Brand frame — decided: no baked overlay.** The clip ships as a clean crop; the credit rides the IG caption. The Remotion-cosmos frame is deferred indefinitely, pending a reason to revisit.
- **Per-track cue labels.** The caption carries the mixtape/finding coordinate today (`buildClipCaption`); naming the specific track playing at a clip's window is the cue-marking synergy the RFC scoped — `resolveClipTracks` / `trackLabel` (`@fluncle/contracts/util`) already resolve it, but nothing surfaces it in the caption yet. Gated on marking cues.

### Brand & canon

- **Moodboard → canon audit (video-side remainder)** — the web overhaul resolved the web half (the logbook plate, ignition hovers, the grain architecture, and the archive grammar are in DESIGN.md now). Still open is the video half: the video-kit laws live in the `fluncle-video` skill doctrine (presence, the plate lane, fixed-pitch / anchored-accent) — decide whether to promote or cross-link them into DESIGN.md canon rather than leave them video-local; cross-link, don't duplicate.
- **Video aliveness — shipped.** Part I landed (`9d12806`): music-reactive renders via the signal-chain dials + the global-vs-internal motion law + an author-time composition lint; the proposed Part II (an LLM judge in the render loop) was prototyped and dropped; grain diversity shipped (#145 — six grain families, the `video_grain` ledger column, the skill doctrine).

### Newsletter — open follow-ups

The Friday newsletter ([docs/agents/newsletter-agent.md](./agents/newsletter-agent.md)) is authored + persisted by the `fluncle-newsletter` box sweep (see _Hermes automation_), with the editions model, the public `/newsletter` archive + `/newsletter/<n>` edition pages, and the `/admin/newsletter` operator front-end all live; the letter copy emits one flat finds block (only the archive still groups by galaxy). What's open:

- **Confirm the Friday cadence** on a real tick — the cron is live, so this is a monitoring item: watch one real Friday 15:00 Amsterdam run to confirm it fires, authors only on a non-empty window, and re-offers an unsent draft rather than double-authoring.
- **Galaxy grouping in the archive.** The archive groups editions by galaxy (Solar → Nebular → Lunar → Astral, the `editions.ts orderedGalaxies` helper) — but with manual vibe-tagging retired, that grouping now depends on the **audio-embedding clusters** (Phase 2 of _Audio embeddings_); until those land, a finding has no galaxy and falls to "Also found." (An archive-only concern — the letter copy no longer groups.)
- **Spine-native edition page (the deeper remainder).** Make an edition **spine-native like a mixtape** — a marked Log ID, a `/log/<id>` edition page, and quiet feed / RSS inclusion — so an edition is a finding-shaped object in the Galaxy, not just an archived email. The persisted payload is the clean source to render it from.
- **Confirm the Firecrawl scene-`tidbits` populate** on a real tick — they came back empty on an early run (the email renders fine without them, but they're the extra scene color).

### Audio embeddings — automatic sonic similarity + clusters

Supersedes the retired manual vibe-map. A signal test (n=45) proved audio **can't** learn the Light↔Dark placement — it's the operator's ear, not the waveform (best ~48% galaxy vs 36% baseline; the energy axis is weakly learnable, the mood axis isn't) — so the manual tag, justified only as "a model automates it later," is dropped. In its place: a **MuQ** audio embedding per finding (spiked as the best of CLAP/music-CLAP/MERT/MuQ), which gives automatic _sonic_ grouping for free — **"more like this"** nearest-neighbours first, a browse-by-feel lens and the game's solar-systems later — all with **zero tagging**. rave-02 is resized (CPX32 / 8 GB) to host MuQ on-box. The four galaxies stay as brand fiction. Build-ready spec (model, the box embed step + pinned Dockerfile, `embedding_json` storage, `get_similar_findings`, phasing, spike evidence): **[docs/audio-embedding-rfc.md](./audio-embedding-rfc.md)**.

Unnecessarily fun — that's the point.

### Auto-drafted finding notes — the vibe-neighbour refinement

The board takes an optional **note** per finding — the editorial "why" that renders on the `/log/<id>` page and feeds its definitional prose + `MusicRecording` schema, so a note is real SEO/AEO value, not just operator chrome. The v1 auto-note runs today (context-note-grounded, voice-gated, fill-empty-only so an operator note is never clobbered, the `fluncle-note` box cron — `docs/agents/note-agent.md`); the operator verifies/edits, and those edits grow the corpus. What remains here is the richer **vibe-neighbour** version — layering the notes of a finding's nearest neighbours in vibe space _into_ the live context-grounded generation (not replacing it), a longer-term autonomous refinement gated on the audio-embedding step.

The notes encode Maurice's **subjective** read — where he placed the finding on the vibe map, how it sits in its galaxy — not its objective spectral numbers. So the neighbours to draw from must be nearest in **vibe** (the placed `vibe_x`/`vibe_y`, same galaxy), NOT in `features_json`: two tracks can measure nearly identical yet land in different galaxies by feel, and a feature-twin's note would carry the wrong vibe. With the vibe-map retired, those neighbours now come from the **audio embedding** (sonic nearest-neighbours — see _Audio embeddings_ above), which captures that feel directly: the embedding IS the similarity space the note's neighbours live in, no coordinate or model in between.

The shape: enrich → the vibe model places the finding → pull the notes of its **nearest neighbours in vibe space** (closest `vibe_x`/`vibe_y`, same galaxy) → the agent synthesizes a fresh, finding-specific note grounded in the galaxy's character and the audio (driving-dark Nebular vs floaty-light Lunar; the BPM, key, texture), in Fluncle's voice via the `copywriting-fluncle` skill → the operator verifies and edits, and that edit grows the corpus. Guardrails: the cluster informs but never templates (the same anti-sameness discipline as the parallel-render attractor — a note that reads like every other note in its galaxy is worse than none), never fabricate scene history or facts, and only draft when there's real signal; the note stays optional, so silence beats a generic line.

Gated on the **audio-embedding step** (for the sonic neighbours — see _Audio embeddings_) and a **notes corpus** to draw from (the board's note column is filling it now). Lives in `packages/skills/fluncle-track-enrichment` alongside the embedding.
