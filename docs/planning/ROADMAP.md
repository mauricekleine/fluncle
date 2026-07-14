# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

## Now — the production loop is running

The add → live pipeline is operational end to end — the one `/admin` cockpit board, the deterministic `--no-agent` per-finding sweeps on the Hermes box, the hands-off `fluncle-render` conductor, and publishing (YouTube hands-off, TikTok drafted + auto-captured). The last autonomy gap is **closed in the repo**: the `fluncle-publish-advance` cron chains render → publish with no operator beat between them (doctrine: [docs/track-lifecycle.md](../track-lifecycle.md) § _The render → publish auto-advance_). It ships **DARK** — its kill switch is default-deny, so the tick posts nothing until the operator flips it on. What's left of the loop is ongoing operation, not build work.

### The autonomy ladder

The full path a finding travels: one human act (Maurice finds the banger and adds it — manual by design, "Maurice discovers, Fluncle does the rest"), instant synchronous fan-out to ~10 surfaces (Spotify · Telegram · web · CLI · API · MCP · RSS · SSH · both Galaxy games), then the async `--no-agent` box sweeps run on their own (enrich → context note → note → observation → render). What's left is the manual tail, roughly in order, and where each one automates:

- **Tag — retired.** Manual vibe-placement is dropped (audio can't learn it, and nothing critical read it); the galaxy grouping it fed is now the automatic **audio-embedding clusters** — the sonic galaxies ([docs/agents/cluster-engine.md](../agents/cluster-engine.md)). One fewer manual step.
- **Note** the editorial "why" — **automated.** The auto-note drafts a first pass per finding (fill-empty-only), now authored against the finding's sonic neighbourhood and guarded by the echo gate; the operator still verifies/edits, and those edits grow the corpus. Doctrine: [docs/agents/note-agent.md](../agents/note-agent.md).
- **YouTube** Shorts — **automated (built, off by default).** The render → publish auto-advance pushes the Short itself: a direct public upload, nothing left for a human. The one channel that needs no in-app finish, so with the advance on, YouTube runs fully on autopilot. **Operator gate:** `fluncle admin publish resume` (or the toggle on `/admin/findings`) — one flip, no deploy.
- [ ] **TikTok** — the inbox draft is now pushed by the same auto-advance; the operator still finishes it in-app (attach the official sound, publish), then `fluncle-social-capture` flips the captured draft → published on its own. Manual by design — no legitimate API audio path. **The last per-finding beat, and the only one left.**
- [ ] **Newsletter (Friday)** — the sweep drafts + persists the weekly edition and offers the literal `fluncle admin newsletter send <id>` command; the send stays an operator tap. The one weekly-cadence step. See _Later → Newsletter — open follow-ups_.

**Deferred (on purpose)** — a surface we could reach but choose to leave dark: **Instagram** (`@fluncle`) — the per-finding master stays deferred (no legitimate API audio path — it gets muted on a business/creator account, IG's licensed audio is app-only; parked, not closed), while set clips are re-opened — a live-mixed DJ-**set** clip fingerprints differently and survives, so the Fluncle Studio clip drip-feed posts set clips to IG on a jittered daily cadence with a kill switch (see _Fluncle Studio_).

**The shape:** one human add → instant parallel fan-out → a deterministic async pipeline → a shrinking manual tail. Of that tail, tag is retired (audio embeddings replace its grouping) and YouTube has now fallen to the render → publish auto-advance; TikTok's in-app finish and the Friday newsletter send stay deliberate human taps, each blocked by an external platform limit, not by us.

## Next — surface what we make, and tidy reliability

### Hermes automation — follow-ups

The per-finding pipeline runs entirely as `--no-agent` jobs on the Hermes box (enrich, context-note, note, observation, backfill, render, social-capture, studio-clip, newsletter, plus the host healthcheck timer); the source of truth is the sweep sources in `docs/agents/hermes/scripts/` + the per-job units in `docs/agents/hermes/*-timer/`, managed on the devbox via the **fluncle-hermes-operator** skill. As of the **2026-07-08 durable-deploy activation** these all run as **repo host systemd timers** reading the baked `/opt/hermes-scripts` path (the Hermes gateway cron runner is retired). Operating doc + roles: [docs/agents/hermes-agent.md](../agents/hermes-agent.md). Ongoing operation is a verify pass per job, not build work. One follow-up stays separate from the cron wiring:

- **Non-root-in-container (defense-in-depth, low priority).** Run the agent as a non-root user with the token out of its readable env. Now that the token is `agent`-scoped this no longer guards the publish boundary — it only protects the agent's own surface and the token value from a fully-compromised agent, plus hardens against a container escape. Worth doing before any wider/public allow-list; not a blocker for the current private/trusted setup.

### Label outreach — the archive that can show its receipts (operator goal, week of 2026-07-13)

Direct outreach to the DnB labels Fluncle logs and crawls — Hospital, Shogun Audio, Med School, Critical, and the seed set — introducing the project in its own voice: a fan-built archive spreading love for the music, not an AI-slop crawler and not a rip-off. Three things it buys, in order of importance: (1) **reputation in the scene** — the operator wants labels to hear about Fluncle from Fluncle first; (2) **press-asset blessings** — a handful of yes-emails converts the artwork archive from gray-zone to partnership, the version that survives anyone asking "where did you get these" (the money-trail analysis, 2026-07-12); (3) **the labels' perspective** on the project, which the operator genuinely wants. Joint work: the assistant finds the right contacts (press/label-manager emails, contact forms — the artist-socials resolver's vendor stack can help), the operator writes and sends in his own name. Track per-label status here as it happens.

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

The `fluncle-backfill` cron paces the two Worker-side catalogue sweeps (Discogs resolve + Last.fm love), with reliability columns gating already-done rows and Retry-After backoff so a 429 cools down instead of storming. What's left here is just **watching the small catalogue drain** — confirm each pipeline's back-catalogue empties out and stays empty. (Album-art → R2 ingestion shipped separately as the owned-cover-master sweep + `fluncle-cover-masters` cron — [docs/album-artwork.md](../album-artwork.md).)

### Observation pipeline — context-notes shape finetune

The empty-context retry path is operational (`context_status` distinguishes confirmed-empty from never-attempted, and `--retry-empty` on `fluncle admin tracks context --queue` + the on-box sweep flag widen the net), so a rare "facts may have appeared upstream" pass can be triggered when wanted. What's open:

- **Context-notes shape finetune.** A tuning pass on the distill prompt (`observation.ts distilContextNote`) against accumulated real notes — which Firecrawl facts are worth keeping, how the distilled prose + the one-line `Texture:` shape reads, and how cleanly it fuels a grounded observation script (a noisy note makes a worse spoken observation).

### Audio observation — voice-guide finetune

The pipeline and the bespoke Fluncle voice are live end to end; what remains is **script craft**, not the voice itself:

- **Finetune the Recovered-audio voice guide.** Tighten the writing guide for the _spoken_ observation: the arc (sensory → mood → connection → log ID → artist/title), line length and pacing for a heard surface (a clunky line can't be skimmed past), how hard the cosmos-sauce should ride out loud, never naming earthly geography, and where "too purple" begins. Fold Maurice's notes from the real renders back into the `copywriting-fluncle` voice reference (`packages/skills/copywriting-fluncle`) + `observation-agent.md`. (SSML is no longer a lever — `<break>` tokens are stripped; Cartesia paces on punctuation.)

### Optimize web playback — what's left is a watch, not a build

The playback layer is in place and the throttled-mobile win is verified: `apps/web/src/lib/media.ts` serves same-zone Media Transformation renditions (the width ladder + centre-crops + `mode=frame` poster, one-shot fallback to the raw master), the `?v=N` vintage token solves re-ship purge, and every playback surface now sizes its request to the measured pane, with a stall stepping DOWN the ladder instead of bailing up to the heavier master (`/log` shipped in #485; Stories follows the same shape). Two small threads remain:

- **Keep the transform ceiling honest.** Watch that the pipeline's CRF doesn't drift footage back over Cloudflare's 100 MB transform ceiling (the largest sit close to ~95 MB).
- **A real-device pass on the step-down recovery.** The wedge → downshift → re-arm ladder only shows itself on a genuinely constrained link; a throttled-cellular phone session on `/log` and the Stories reel (the operator's phone) is the closing check.

### Log IDs in search + AI answers (AEO/GEO) — off-site thread

The on-site layer shipped (per-finding `/log/<id>` pages with definitional prose + `MusicRecording` identifiers, sitemap + IndexNow fan-out, the `/about` entity/FAQ surface, `VideoObject` structured data) and the first retrievals and video indexing have landed. What remains is off-site, slower, and mostly monitoring:

- **AI crawlers: keep the regression check.** Verified AI crawlers pass and managed robots.txt is OFF; still worth a recurring check of the live `/robots.txt` + the AI Crawl Control crawler policies (Cloudflare can re-flip defaults silently).
- **Watch the indexing milestones.** The per-finding `/log/<id>` pages moving to Indexed in GSC (today a bare coordinate lands the `/log` _index_, not yet the individual page; count ≈ archive size), an individual page ranking for its own coordinate, the rest of the video pages filling into the GSC Video-indexing report as they're re-crawled, bare-token retrieval (`004.7.2I`, `fluncle://004.7.2I`) landing the log page, and Fluncle present in Brave Search. Bing/Yandex are hands-off via IndexNow; Google still rides the GSC sitemap. Indexing and AI citation are ongoing outcomes — monitoring, not ship gates.
- **Third-party corroboration.** The MusicBrainz artist + Wikidata item anchors exist and sit in the `/about` `sameAs` set. Remaining: authentic presence where dnb lives (r/DnB and friends — participate, don't fabricate), and enrich the Wikidata item as facts accumulate.

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

### MusicKit second authority — the remaining tail (U2b only)

The MusicKit arc shipped whole across seven PRs (#548 the catalog oracle, #550 the facts keystone, #554 the exact-ISRC preview rung, #556 editorial-notes fuel, #563 label aliases, the U3a/U3b cover work — doctrine: [docs/album-artwork.md](../album-artwork.md)), and the `force_capture` dupe-veto escape hatch followed (#583 — the operator override across all three duplicate detectors, sticky through the capture it enables; doctrine: [docs/the-ear.md](../the-ear.md) § Duplicates). One unit remains, carried by the trimmed [docs/musickit-second-authority-rfc.md](../musickit-second-authority-rfc.md): **U2b** — the operator `merge_label` op + slug 301s that clean up the pre-existing label splits (the Medschool/Med School class), deliberately staged behind real U2a alias data accumulating in prod (revisit ~2026-07-20).

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

- **2 · Per-track sprite generation — gated on a spike.** An automation that mints a unique pixel sprite per finding (seed: cover art + the finding's sonic galaxy). This is the one place we want **variety inside the consistency** — and that's exactly the hard, unproven problem: AI generation converges on a shared attractor, so a ~10-sprite spike must prove real variety that still reads as one family **before** the arc commits to it.
- **3 · Collectable sprites in the Galaxy game — private collection.** Each finding becomes a star/sprite you fly to and **collect**, plus a binder-style collection page (empty outlines that fill in on collect). This rides the **existing** private account layer + the Log-ID-keyed progress store (`apps/web/src/game/progress.ts`) — **collection is independent of public accounts**; it works with what ships today.
- **4 · Public accounts + profiles — an optional later flip.** Only if shareable public collections earn it; gated on the Public marginalia RFC (see _User accounts_). Not a prerequisite for anything above.

### Fluncle mobile — ON TESTFLIGHT; store submission imminent

The Expo app went from dark to a TestFlight build on the operator's phone in one arc (2026-07-11/12): feed + archive + finding pages + submissions, the Radio (background audio + lock-screen presence), Mixtapes, archive search, device-local saves, push category toggles, the traveler app icon, and Apple Music links across the whole ecosystem (exact-ISRC, live in prod). The release runbook + the ratified submission kit live in [docs/mobile-release.md](../mobile-release.md); the review posture is [docs/app-store-review.md](../app-store-review.md). Ahead:

- [x] **SUBMITTED FOR REVIEW — 2026-07-13, 21:29.** iOS App 1.0 (0.1.0, build 4) is Waiting for Review: the full kit (voice-clean description, set-builder keywords, complete review notes), 4+ worldwide age rating, the honest two-type privacy label, and the six-shot 6.9" screenshot set led by the Decks chain. Next state change is Apple's.
- [ ] **Galaxy game on mobile (later, after star-sync).** The game joins the app once collected stars persist through accounts (see _User accounts_) so a run continues across surfaces — `@shopify/react-native-skia` is already a trusted dependency at the workspace root, so the render layer has a plausible native path; web-first star sync lands before any port is scoped.
- [ ] **The 1.1 arc — accounts in the pocket (SCOPED 2026-07-14, operator-ratified; gated on 1.0 approval).** ~80% client work — every /me op it needs is live. The four rulings:
  - **Transport: `@better-auth/expo`** (version-matched to the pinned 1.6.23): SecureStore-backed sessions, email/password in-app. Server side registers the expo plugin + the `fluncle://` trusted origin; `expo-secure-store` is a native dep (1.1 is a new build anyway). The CLI's device flow stays the CLI's.
  - **Home: an `/account` modal route** (the submit/notifications pattern) entered from a person icon in the archive header beside "Submit a track" — never a tab; accounts don't earn one under the never-gates law.
  - **Sync scope:** key notation adopts the profile field (shipped #591); saved findings union-merge into the account on first sign-in (a client-side loop over the idempotent save op — zero new server surface) then sync; saved sets get "Save set" on the Decks + a list that opens back into the builder (ops + wire format shipped with the web half). Submission ownership is deferred to 1.2.
  - **Password reset ships IN the arc** (Better Auth email reset via Resend on the newsletter domain) — it closes the standing web hardening item, and mobile makes its absence user-visible (a forgotten password on a phone is a lockout).
  - **Apple homework baked in:** in-app account deletion is MANDATORY once the app creates accounts (5.1.1(v)) — the account screen carries it behind the confirm-dialog vocabulary; 4.8/Sign-in-with-Apple is NOT triggered (email/password only, no third-party login in v1 — keep it that way); the privacy label + review notes update at the 1.1 submission (email collected; saved data linked-to-you for account holders).
  - **The law on every slice:** anonymous stays first-class everywhere; signing in only syncs.
  - Slice order: server (expo plugin + reset) → app auth + the account modal (in/up/out/delete/reset) → notation adopt → saved-findings merge → Decks saved sets → submission-kit updates.
- **Brand marks (parked decision):** `react-native-svg` + `simple-icons` would render SiSpotify/SiApplemusic canon-correctly in the app; HeatButton's icon slot is already wired for it.

### User accounts

- [ ] **Accounts become first-class sync citizens (HIGH — operator-prioritized 2026-07-12).** In-progress chained sets (the /mix builder, web and mobile) and Galaxy star collections sync across web ↔ mobile when signed in. **The law, operator-ratified: an account NEVER gates a feature.** The set builder, the game, and everything else stay fully usable anonymous; signing in only SAVES progress across surfaces. Device-local persistence stays the default (the mobile saved-findings pattern is the precedent); the account is the backup/sync upgrade, never the toll booth.
  - **Saved sets — the WEB half shipped.** A signed-in user saves the sets they build on `/mix` (a quiet "Save set" secondary in the masthead, never the gold primary; signed-out visitors see nothing new — the never-gates law holds). Storage is the `user_saved_sets` table keyed by the Better Auth user; the row stores the serialized `?set=` chain + `?taste=` seed VERBATIM, so opening a saved set hands them straight back to the route's loader — zero new hydration path. The ops are the `/me` private-session tier (`save_private_set` / `list_private_saved_sets` / `update_private_saved_set` / `delete_private_saved_set`), and saved sets join the account export + delete-cascade like saved findings. Managed from `/account` (open · rename · delete). **The mobile half is SCOPED as the 1.1 arc** (see _Fluncle mobile_ — operator-ratified 2026-07-14); the wire format and ops are already public, so the mobile slice stays a thin client.

- [x] **One Scales/Camelot preference — API + WEB SHIPPED overnight 2026-07-13/14 (#591).** The extensible `user_preferences` store (one row per user, closed zod object, partial-merge PATCH — a future preference is a schema field, zero migrations), `get_private_preferences`/`update_private_preferences` on the /me tier (export + delete covered), and every web key readout (/log, search, /mix, admin) now obeys the one preference — device-local by default, profile-synced when signed in, the never-gates law intact (the anonymous toggle path is untouched). REMAINING: the mobile half (the Decks toggle adopts the same profile field) — scoped into the mobile 1.1 arc (see _Fluncle mobile_). The key-notation toggle currently lives only on the Decks (mobile) and `/mix` (web), and each surface keeps its own device-local pref while every OTHER key readout — the mobile archive rows, finding pages, the web archive — hardcodes scale text. The shape: one app-wide notation setting per surface consumed by every key readout, device-local by default (the existing stores are the seed), and when signed in the preference lives on the profile and syncs across web ↔ mobile — a new profile field; nothing stores this on accounts today. A DJ who thinks in Camelot thinks in Camelot everywhere. The never-gates law applies as always: anonymous keeps the device-local toggle, the account only carries it across surfaces.

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

- **Distribution layer — the clip → Instagram drip-feed.** The Fluncle-owned scheduler is built + deployed (the drip-feed RFC shipped and is pruned; doctrine: [docs/fluncle-studio.md](../fluncle-studio.md)): the schedule/status table + kill-switch KV, `pushInstagramReel`, the agent-tier `drip_clips` tick, auto-queue-on-clip-create with a random 23–25h jitter, and the `/admin/clips` kill-switch + per-clip schedule controls — a validated path distinct from the per-finding-master IG deferral (a live-mixed set clip fingerprints differently and survives). Immediate next steps (operator-gated):
  - **1 · Live IG validation** — fire one real `drip_clips` tick to prove `pushInstagramReel` posts end to end (Postiz → IG) before the cron runs wide. The 4 existing clips all build **empty captions** (they're from the un-cued rolling set `f8f555d2`), so pick a clip + a caption first. The kill switch stays **off** by default, so nothing posts until this first tick is fired deliberately.
  - **2 · Deploy the `clip-drip-sweep.sh` cron to the box** — the on-box tick (`docker cp` into the Hermes container + `hermes cron create`, the `fluncle-social-capture` "box triggers, Worker calls Postiz" shape), landed **only after** the live post is validated, so the drip auto-runs only once the push is known-good.
- **Per-clip captions.** `buildClipCaption` ships the coordinate credit — the finding(s) a clip's window plays (resolved via `resolveClipTracks`), or the promoted mixtape's `.F.` — served to the card and used as the drip caption. Gap: a clip from an **un-cued** recording resolves to no finding, so it builds an **empty** caption (all 4 current clips); the drip wants either finding-linked cues on the source recording or an operator-set caption. A Fluncle-voice auto-draft (`copywriting-fluncle`) on top stays open.
- **Brand frame — decided: no baked overlay.** The clip ships as a clean crop; the credit rides the IG caption. The Remotion-cosmos frame is deferred indefinitely, pending a reason to revisit.
- **Per-track cue labels.** The caption carries the mixtape/finding coordinate today (`buildClipCaption`); naming the specific track playing at a clip's window is the cue-marking synergy — `resolveClipTracks` / `trackLabel` (`@fluncle/contracts/util`) already resolve it, but nothing surfaces it in the caption yet. Gated on marking cues.

### Brand & canon

- **Moodboard → canon audit (video-side remainder)** — the web overhaul resolved the web half (the logbook plate, ignition hovers, the grain architecture, and the archive grammar are in DESIGN.md now). Still open is the video half: the video-kit laws live in the `fluncle-video` skill doctrine (presence, the plate lane, fixed-pitch / anchored-accent) — decide whether to promote or cross-link them into DESIGN.md canon rather than leave them video-local; cross-link, don't duplicate.

### Newsletter — open follow-ups

The Friday newsletter ([docs/agents/newsletter-agent.md](../agents/newsletter-agent.md)) is authored + persisted by the `fluncle-newsletter` box sweep (see _Hermes automation_), with the editions model, the public `/newsletter` archive + `/newsletter/<n>` edition pages, and the `/admin/newsletter` operator front-end all live; the letter copy emits one flat finds block (only the archive still groups by galaxy). What's open:

- **Confirm the Friday cadence** on a real tick — the cron is live, so this is a monitoring item: watch one real Friday 15:00 Amsterdam run to confirm it fires, authors only on a non-empty window, and re-offers an unsent draft rather than double-authoring.
- **Galaxy grouping in the archive.** The archive groups editions by galaxy, and the galaxies are now the sonic k-means map from the cluster engine ([docs/agents/cluster-engine.md](../agents/cluster-engine.md)); a finding whose galaxy is not yet operator-named falls to "Also found," so this is a watch item as the map settles. (An archive-only concern — the letter copy no longer groups.)

- **Confirm the Firecrawl scene-`tidbits` populate** on a real tick — they came back empty on an early run (the email renders fine without them, but they're the extra scene color).

## Homogenisation — the next big slice (2026-07-11)

**The observation that names it:** Fluncle's generated artifacts drift toward a mean. It has now been seen independently in two places, which is what makes it a property rather than a pair of bugs. **Evidence collection is underway before any scoping** (operator ruling, 2026-07-13): occurrences land in the [homogenisation evidence ledger](./homogenisation-evidence.md) as they are seen — including the third independent sighting, four of five consecutive YouTube renders sharing one palette + texture.

- **The notes.** Measured, not guessed: the word "shoulders" appears in **15 of 61** live notes; "I've been rewinding it since" is lifted verbatim between two. The un-layered auto-note reproduced a standing GLXY note almost word for word. (The vibe-neighbour layer + echo gate is the first counter-measure — it works by handing the model the neighbourhood's moves as **spent**, and it measurably _reduced_ within-region overlap, 0.041 → 0.015.)
- **The videos.** They are far better than they were, but the models still skew to the same vehicles. The video work already learned the general law and wrote it down: **parallel generation converges on a shared attractor, so diversity has to be DESIGNED IN, not hoped for** (assign each agent a distinct structural family at launch; prescriptive mid-flight coaching increases convergence rather than fixing it).

**Why it matters more than it looks.** Fluncle's whole claim is that a human with taste went out, dug, and came back with something. An archive whose every artifact rhymes with its neighbours reads as machine-made — which is exactly the thing the persona cannot afford. Sameness is not an aesthetic nit here; it is a credibility leak.

**The shape of the slice (unscoped — wants a real design pass, and the operator wants a real taste dive on the corpus before any scoping):**

- **Measure it first, everywhere.** The note work shipped `scoreNoteEcho` + a `--dry-run` harness, so the claim stays falsifiable. Every generated artifact family (notes, observations, logbook entries, videos, covers, sprites) wants an equivalent: a cheap, honest diversity metric, run on the real corpus, that tells us whether we are getting worse. **An anti-sameness effort with no metric is folklore.**
- **Spend the moves.** The mechanism that worked for the notes generalises: show the generator what its neighbours already did, and require it to find what is true of _this_ one and nothing else.
- **Design the diversity in.** Per the video law: assign the family/angle up front rather than asking for variety.
- **The long-term drift risk, stated honestly.** The "spent moves" mechanism pushes each new artifact away from what came before. At 61 notes that is a fix. At 300 it could push the voice off its own centre. **Re-measure as the corpus grows** — the harness makes that one command.

**It composes with the prompt registry (shipped — [docs/agents/prompt-registry.md](../agents/prompt-registry.md)): fighting sameness is an iterative, taste-driven loop — change a prompt, read ten outputs, change it again — and that loop now runs from `/admin/prompts` with no deploy and no box rebake.**

## ChatDnB — the graduation questions (spike shipped, admin-gated)

The pun (ChatGPT → ChatDnB) earned its spike and the spike shipped: `/admin/chat` (#562) — a chat with Fluncle himself that answers over his own archive tools with hard tool-boundary grounding (he answers from the archive or he does not answer — the model can surface rows, never invent them), admin-gated. What remains is the graduation call, and it wants a real design pass before any public flip:

- **Public exposure** — a public front door or a crew toy first; `chat.fluncle.com` or `/chat` (`chatdnb.com` is taken — the pun survives the URL).
- **Rate-limiting and abuse** for an anonymous public LLM surface — every conversation costs real inference money.
- **Model choice** — a well-prompted frontier model with the hard grounding rule is the honest v1; the FluncleLLM voice fine-tune (below) is an obvious future consumer.
- **The surface itself** — how a chat stays quiet and cover-led rather than becoming a SaaS chat window (`PRODUCT.md` bans the streaming-app clone by name).

The spike's rails carry forward unchanged into any public version: grounding is the product, he never speaks about an uncertified track (ratified canon — the catalogue is a utility layer with no narrative voice), and the voice gate applies — this is him _talking_, the most exposed his voice ever gets.

## The Fluncle models — the voice, the eye, the ear (idea, 2026-07-11)

One arc, three probes. Fluncle already generates — notes, observations, logbook entries, shader videos, sprites, covers — but always by **constraining a stranger**: a general model held in line by a prompt, a skill, and a voice gate. The question this arc asks is what changes when the model has **only ever known Fluncle**.

Three fine-tunes, three faculties. They share a method (LoRA on an open-weight model, rented GPU, single-digit dollars), a discipline (run behind the existing gates, not instead of them), and a rule.

**The rule — and it is the only one that matters here: the line is PUBLISHING, not EXPERIMENTING.** What ships under Fluncle's name is bounded by canon. What we _try_ is not. Probing, pushing, and following curiosity into the not-yet-known is exactly what this project is; refusing an experiment because its _product_ would be off-brand is the incurious move Fluncle would never make. **Never confuse "do not ship it" with "do not try it."** An experiment that teaches us something and ships nothing has done its job.

Where the models run: the private companion repo (`fluncle-labs`, see AGENTS.md) — corpora, training scripts, and artifacts stay there. Findings graduate to this repo as ideas; code and weights do not.

### 1 · The voice — a model that writes like him

Fine-tune on **Fluncle's own written corpus**: the editorial notes, the spoken observation scripts, the Logbook travelogue entries, the Telegram posts, the newsletter editions. Every word was authored for this project and most of it is operator-verified, which makes this the rare fine-tune with **no legal question at all** — the corpus is ours outright.

The prize: the voice gates and the `copywriting-fluncle` skill work, but they work by _constraining a stranger_. A model fine-tuned on the corpus would carry the register natively — the said-not-written rhythm, the Dry Rule, the recovered-log idiom, the em-dash law — and the drift the gates currently catch would mostly stop happening. It compounds, too: every operator edit to an auto-note is a training signal, so the thing gets more Fluncle over time (the note-agent's correction pairs are already the seed of that dataset — [docs/agents/note-agent.md](../agents/note-agent.md)).

Shape: assemble the corpus (with the operator's edits as the preferred targets), LoRA a small instruct model, run it **behind the existing voice gates** — the gates stay as the safety net, and the win is measured by how rarely they fire. First consumer: the auto-note (highest volume, already fill-empty-only, already has correction pairs). Honest open question: is the corpus thick enough yet? (It is growing fast — ~15 findings/week means ~15 notes + ~15 observations a week, so "wait for more" is a matter of weeks, not years.) And does a fine-tune actually beat a well-prompted frontier model at this scale? A genuine spike, not a foregone conclusion.

### 2 · The eye — generation as Fluncle's imagination

The other place generation is unambiguously on-brand: the visuals are **Fluncle's own imagination**, not someone else's recording. Nobody is infringed, no canon is contradicted (the whole Nostalgic Cosmos is already machine-made under the operator's eye), and the failure mode is aesthetic rather than legal.

Deepen the per-asset scripts into a real generative capability — a model or pipeline **pointed at a finding** that produces its scene, its sprite, its cover, all in one family, seeded by what the archive already knows about it: the cover art, the MuQ embedding, the galaxy it landed in, the BPM and key, the note. This is where the archive's data pays a _visual_ dividend — a finding's embedding is a genuine seed for what its scene should look like, which no stock generator can do.

Absorbs: **per-track sprite generation** (already a gated spike under _From Earth to Orbit_ — its hard part, variety-inside-consistency, is exactly a generative-model problem), the video kit's texture families, and the galaxy's visual identity now that the galaxies are data-real. The known trap is the one the video work already documented: parallel generation converges on a shared attractor, so **diversity has to be designed in, not hoped for**.

### 3 · The ear — a model trained on what he certified (internal only)

**Not a product. An experiment — and the corpus is already sitting there, growing ~15 tracks a week.** All 60 findings carry captured full audio, which is not a _drum & bass_ corpus: it is **the 60 tracks Fluncle personally certified**. A LoRA on that is not a genre model, it is a model of one person's _taste_, asked what it dreams. Canonically that is what a mixtape already is (LORE: the mixtape is Fluncle dreaming — short-term memories settling into one long blended one), which makes the artifact interesting on its own terms even if not one second of it is ever heard by anyone but us.

**The experiment is better than "can it make DnB."** The captions carry the galaxy name, so the real question is: **prompt it with "solar" and does it sound like Solar?** If the model learned the galaxies from audio alone, that is _independent_ evidence — arriving from a completely different direction than clustering — that the MuQ space carved along boundaries a human actually hears. That is a real finding about the archive's foundational assumption, and it costs about three dollars to get.

Model (2026-07-11 research): **ACE-Step 1.5** — **MIT on code _and_ weights**, no revenue cap, no NC clause, no gating; the only permissive model that is also 48 kHz stereo and long-form, and it ships an official LoRA/LoKr trainer. 16–20 GB VRAM; 60 songs lands right in its published band (~~500–800 epochs). An RTX 4090 on RunPod (~~$0.34/hr) does it in about an hour. (Runners-up: HeartMuLa sounds better but ships no trainer and will not say what it was trained on; Stable Audio 3 has the cleanest data story but a $1M revenue cap; MusicGen is CC-BY-NC and frozen.)

**Prepped and ready to run** in the companion repo (`experiments/dream-lora`): the corpus export, the captions, the presigned pull onto the pod, the whole runbook.

**The hard rail — a PUBLIC Fluncle music generator is rejected, and that is not in tension with running this.** Shipping AI-made DnB under Fluncle's name fights the canon head-on (PRODUCT.md: a mixtape is authentically Fluncle _"where an AI-made original would fight the persona"_) and his whole credibility is that a human with taste went out, dug, and certified. So: the artifact is **internal only** — never published, never on a public surface, never in a mixtape, never sold, never presented as Fluncle's music. Its value is what it **teaches**, not what it emits. A surprising result is a **finding**, not a **release** — and it feeds the voice and the eye, which are the two faculties that _do_ ship.
