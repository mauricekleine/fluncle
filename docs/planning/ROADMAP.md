# Roadmap

Forward-facing, roughly prioritized list of open work — what we pick from next. Not a changelog: shipped work lives in git history, so this doc carries only what's still ahead. A living reference; add freely, move an item into a PR when it's picked up. Canon (DESIGN.md / PRODUCT.md / VOICE.md) arbitrates the words — this is planning, not spec.

Two things to know before reading. **The overhaul is the headline** — a feature freeze is in effect, so `Now` and `Next` are deliberately not new-feature lists; they are the freeze-safe work (reliability, hygiene, activations) plus the overhaul's prerequisites. And **the long tails live in their own ledgers**: the nightly auditor's findings ledger ([docs/audit-backlog.md](../audit-backlog.md), 1 open row as of 2026-07-27 — the 2026-07-27 triage resolved the rest and made the ledger forward-facing, open rows only) and the DB query-shape scale backlog ([docs/db-scale-backlog.md](../db-scale-backlog.md)). A ledger row is promoted into this doc only when it is worth scheduling, and a promoted item cites the row it came from — the ledgers keep the analysis, this doc keeps the schedule.

## The overhaul — Fluncle becomes a drum & bass discovery platform (operator direction, 2026-07-26)

The headline epic, and the last big change before go-to-market. This section records the **direction and the intake**; the overhaul's actual design is future work and nothing here pre-decides it.

### The friction it resolves

"What is lore" versus "what has value for ALL drum & bass fans" has caused friction across the platform — every surface has had to answer it locally, and the answers have not agreed. The overhaul's job is to reduce that friction by settling it once, structurally.

**The direction, in the operator's words:** Fluncle becomes a genuine **drum & bass discovery platform**, akin to a magazine-type website — with the lore present in the **theme**, and available for the people who want to dive deeper. The catalogue is **level 1**; the SSH rave terminal is **level 99**. Depth is a ladder a visitor climbs by choosing to, not a toll at the door.

### The sequencing — freeze, overhaul, go-to-market

- **New feature development stops first.** The freeze is the precondition, not a side effect: the overhaul re-decides what the surfaces are for, so shipping new surfaces into it is wasted work.
- **The housekeeping sweep was the clean slate.** The overhaul starts from the 2026-07-26 sweep; its residual operator decisions are listed under _Next → Housekeeping follow-ups_.
- **Then the overhaul** — the final big change before the project is marketed.
- **Then go-to-market:** marketing the platform on Reddit, reaching out to record labels (the groundwork is _Next → Label outreach_), and going to DnB events to spread sticks / QR codes.

### Intake — the open items that belong under the overhaul

These are already-known items whose right home is the overhaul rather than a standalone slice. They are intake, not scope: the overhaul decides what happens to each.

- **Entry-surface plainness.** The arrival surfaces speak plain — no cosmos vocabulary where a stranger lands, deep lore stays deep. That standing copy rule is exactly the level-1/level-99 ladder stated in language, so the overhaul owns applying it surface by surface rather than one string at a time.
- **Lore-depth layering.** Which surface sits at which level, and what a visitor sees before they opt in. The SSH rave terminal is the operator's named level-99 example; the catalogue is level 1; everything between wants placing.
- **The Logbook screen in the rave terminal.** `ssh rave.fluncle.com` has no Logbook screen — the surface-coverage sweep dropped the false `ssh` weight rather than build one (`packages/registry/src/index.ts`), and the ssh-menu parity test now holds that line. Building the screen is a level-99 depth item, so it lands with the depth ladder rather than before it.
- **The delivery-perf remainder.** Further CSS / bundle splitting and the cover-master regrain — the last of the delivery work, which the overhaul's page shapes will re-frame anyway.
- **The admin overhaul's waiting consumers.** One deferral still names the admin overhaul as what unblocks it: the per-row "generate" action on the observation dialogs (`apps/web/src/components/admin/observation-dialogs.tsx` — deferred to the overhaul, which decides where a per-row action belongs across every station at once, per [docs/admin-shell.md](../admin-shell.md) § placement contract). The caller-less `update_mixtape_cue` op was the other; it was **retired** on 2026-07-27 rather than parked, so if the overhaul designs a mixtape-scoped cue rail it rebuilds the op from git history.

## Now — the freeze holds; the loop runs itself

The add → live pipeline is operational end to end — the one `/admin` cockpit board, the deterministic `--no-agent` per-finding sweeps on the box, the hands-off `fluncle-render` conductor, and publishing (YouTube hands-off, TikTok drafted + auto-captured). What is left of the loop is operation and a handful of flips, not build work.

### Operator activations — the flips that cost one session

One flip remains, deliberately held.

- [ ] **Publish-advance: resume it and watch one finding land** _(ruled 2026-07-27: stays dark for now — flip when ready)_. `fluncle admin publish resume` (or the toggle on `/admin/findings`). The repo half and the host-timer unit are committed (`docs/agents/hermes/publish-advance-timer/`) and the kill switch is **default-deny** — an absent setting reads as paused, so nothing posts until the flip. Doctrine: [docs/track-lifecycle.md](../track-lifecycle.md) § _The render → publish auto-advance_.

### The autonomy ladder — two manual beats left

One human act (Maurice finds the banger and adds it), instant fan-out to ~10 surfaces, then the async `--no-agent` sweeps run themselves. Two beats stay human, and both are blocked by an external platform, not by us:

- [ ] **TikTok's in-app finish.** The auto-advance pushes the inbox draft; the operator attaches the official sound and publishes, then `fluncle-social-capture` flips captured → published on its own. Manual by design — no legitimate API audio path.
- [ ] **The Friday newsletter send.** The sweep drafts and persists the edition and offers the literal `fluncle admin newsletter send <id>`; the send stays an operator tap. The one weekly-cadence step.

**Deferred on purpose** — the per-finding **Instagram** master stays dark (no legitimate API audio path; a business/creator account mutes it, IG's licensed audio is app-only). Parked, not closed. Set clips are the re-opened half and ride the Studio drip-feed.

### Standing operation — the watch list

Monitoring, not work. Collapsed here so it stops occupying build sections.

- **The catalogue back-catalogue drains and stays empty.** The `fluncle-backfill` sweeps pace themselves; the observable is `/admin/funnel`.
- **The Friday newsletter's own ticks.** One real 15:00 Amsterdam run confirms it fires, authors only on a non-empty window, and re-offers an unsent draft rather than double-authoring; the Firecrawl scene-`tidbits` came back empty on an early run and want confirming; the archive's galaxy grouping settles as the cluster map gains operator-named galaxies.
- **AI crawlers and indexing.** Recurring check of the live `/robots.txt` + the AI Crawl Control policies (Cloudflare can re-flip defaults silently), and the GSC milestones — per-finding pages moving to Indexed, bare-coordinate retrieval landing the log page, video pages filling into the Video-indexing report. Outcomes, not ship gates.
- **The transform ceiling.** Watch that render CRF drift doesn't push footage back over Cloudflare's 100 MB Media Transformations ceiling (the largest sit near ~95 MB).
- [ ] **One real-device throttled-cellular pass.** `/log`, the Stories reel, and `radio.fluncle.com` on the operator's phone over a genuinely constrained link — the step-down ladder and the shared stall watchdog (`use-video-recovery.ts`) only show themselves there.

## Next — freeze-safe work: reliability, hygiene, and the overhaul's prerequisites

### Dependency vulnerability posture — 18 open alerts (measured 2026-07-26)

Every open alert is triaged (zero fix-now; the analysis lives in the ledger and the triage report). What is ahead: the three dismiss-candidate clicks on the `apps/sonar` alerts (operator, reason "vulnerable code is not actually used"), two upstream-pinned watches that close themselves when libsql's chain moves, the standing policy — what severity auto-merges, what waits for `minimumReleaseAge`, and who reads the queue — and the CI-side half (`bun audit` + the Renovate npm extension, the follow-ups item below). Ledger row: `docs/audit-backlog.md` (security, 2026-07-12).

### Housekeeping follow-ups — operator decisions pending (2026-07-26 sweep)

Most of the sweep's queue is settled (git history + the ledgers hold the rulings). What is still open:

- [ ] **CSP graduation.** `security-headers.ts` ships an enforcing `frame-ancestors 'self'` plus a full `Content-Security-Policy-Report-Only` policy. Violations report to Sentry's Security feed ([docs/error-tracking.md](../error-tracking.md)); the feed is clean. What is ahead: let it run across a real traffic window — absorbing any genuine first-party host into the policy as it appears, archiving extension noise — then flip the report-only policy to enforcing.
- [ ] **The dependency-hygiene remainder:** `bun audit --audit-level=high` as a CI job and the Renovate npm/bun extension — the two moves that close the `bun.lock` blind spot (the deepsec bump shipped 2026-07-27; the three Dependabot dismissals are queued operator clicks).

The sonar release gate is a build and lives under _The enforcement gates_ below.

### The enforcement gates — two holes at the deploy boundary

The build-fail coverage tests and `deploy:gate` are how this repo keeps architecture claims true. Two places where the guard has a gap:

- **Decide public-vs-admin by PATH, not op-name prefix.** `orpc-admin-coverage.test.ts` classifies with `PUBLIC_OP_PREFIXES` and `op.startsWith(p)`, so any admin op whose name happens to start with a public prefix silently escapes the registry check — a name collision punches a hole in a build-fail gate. Ledger row: `docs/audit-backlog.md` (architecture, 2026-07-26).
- **Gate the sonar release.** `.github/workflows/sonar-release.yml` builds and publishes the rolling pre-release with no `cargo test`, no `clippy`, no `fmt --check`, and the box self-swaps off that release — so a merge to `apps/sonar/**` reaches the live engine ungated. This is the `deploy:gate` principle applied to the one deploy path that escapes it.

### Sonar regional replication — a tripwire, not a task

The engine serves every "sounds like" surface from ONE region ([docs/vector-serving.md](../vector-serving.md)). A second region is only correct once far-region _dynamic_ (uncached search / recs) traffic is a measured, meaningful share — and the Worker→engine hop must stay same-continent or the win is eaten. When the number appears, spin a box and register it; not before.

### DB scale — the Wave-2 remainder and the index economics

Everything proven in the 2026-07-24 audit has shipped; what remains is a short outstanding set plus four design calls. Full analysis, measurements, and the failed shapes stay in [docs/db-scale-backlog.md](../db-scale-backlog.md) — these are the promoted, schedulable pieces.

- **Anchor worklist — item 4 is WRITTEN and held for its hosted proof.** `ANCHOR_ORDER` now leads with the `has_embedding` mirror and the partial index `tracks_anchor_order_idx` (`(has_embedding, nearest_finding_score, track_id) where spotify_uri is null`, migration `0132`) exists in the PR. The remaining work is the proof, not the build: `EXPLAIN QUERY PLAN` on the real worklist statement against a hosted 150k scratch clone must show the planner picking it with no filesort, plus a p50 and a build cost. Nothing merges before that.
- **Drop the two redundant indexes on the growing tables.** Every index is paid for on every write. `artist_socials_artist_id_idx` is a strict prefix of the unique composite and nothing pins it by name — the clean drop. `tracks_capture_priority_idx` is gated on a hosted `EXPLAIN QUERY PLAN` that also settles a repo self-contradiction about which index `listCatalogueAppleWork` actually rides.
- **`/artists` carries ~890 ms of server time its twin hubs don't.** Measured TTFB 890 ms of a 2268 ms median FCP, against 80–125 ms on `/labels` and `/albums` running the identical `listHubPage`. PR #919 proposed a covering index (`artists_hub_gate_idx` over `(slug, renderable_track_count, certified_finding_count)`) and explicitly did not implement or EXPLAIN it. Same shape as the proven funnel-scan fix, and it would apply to all three hubs. **File this into `docs/db-scale-backlog.md` first** — today the claim exists only in a merged PR body.
- **Four design calls await a decision** — the per-user recommendations cache, search `compileFilters` resolving names to indexed ids, tracks-hub keyset pagination for the deep tail, and the capture split-OR merge (`docs/db-scale-backlog.md` Wave 3). They are decisions, not builds; the ledger holds the shapes and impacts. The capture one stays gated on the operator opening catalogue capture, and it is now a build-or-don't rather than a two-path choice — the `capturable` flag it used to be weighed against was dropped on 2026-07-27, along with the rank-sweep `match_key`/`needs_rank` columns and the `/tracks` year-lane rollup. Git history holds all three analyses if a trigger brings one back.

### Static voice lint over user-facing literals

The voice canon is enforced only on **agent-authored** text at write time — `BANNED_WORDS` lives in `apps/web/src/lib/server/observation.ts` and nothing checks a hand-written string. Add a static lint over user-facing literals so a hand-typed string faces the same gate the auto-note does. Ledger row: `docs/audit-backlog.md` (voice, 2026-07-25) — the one genuinely directional row in that ledger.

### One RFC in flight — artist-primary capture

[docs/rfcs/artist-primary-capture-rfc.md](../rfcs/artist-primary-capture-rfc.md) is the only file in `docs/rfcs/`; slices 0, 1, and 1b shipped and the file carries only the remainder. Prune it when the rest ship.

- **Slice 2 — gate a capture buy on free preview BPM.** Octave-folded, confident-reject-only, checked **before the money leaves**. Nothing in `apps/web/src/lib/server` does a capture-time BPM pre-check today; the only octave-fold logic is post-capture analysis in the enrichment skill.
- **Slice 4 — MusicBrainz identity at ruling time on `/admin/labels` (small).** The station renders the logo and the seed-ruling buttons and nothing else, so "which Helix?" is answered by a periodic manual identity audit instead of at the moment of the ruling. Showing each label's MB entity beside the buttons retires that compensating control.
- **Doc debt, not roadmap work:** slice 3's catalogue cleanup pass effectively shipped as the `fluncle-catalogue-prune` skill. The RFC still calls it "(later)" — a two-line true-up in the RFC, and citing slice 3 as open work would be wrong.

### The acquisition boundary — `capture-sweep.ts` is in the wrong repo (parked 2026-07-11)

`docs/agents/hermes/scripts/capture-sweep.ts` is the **audio acquisition layer** and it sits in this **public** repo — directly against the rule AGENTS.md and the `fluncle-labs` README both state: _"The public repo describes what it does **with** the bytes. It never describes, scripts, or links how they arrived."_

**The concrete blocker, first:** relocating it means giving **rave-02 read access to `fluncle-labs`** (a deploy key or fine-grained token) and teaching the bake pipeline a second source — the box bakes its scripts from this repo, and the coupling is real (`apps/cli/src/cli.ts`, `packages/registry`, the capture timer units, and two canon docs all reference the sweep). That is infra work, which is why it is parked rather than forgotten.

Two honest notes for whoever picks this up:

- **Git history is forever.** The script is already public, so moving it stops adding to the exposure rather than undoing it. Still worth doing; not erasure.
- **If we decide the current posture is fine, amend the RULE.** A boundary the codebase openly contradicts is worse than no boundary: it teaches every future agent that the rule is decorative.

### Secret & token hygiene — deferred 1Password/R2 follow-ups

Three items from the 2026-07-07 vault audit remain. None is overnight-autonomous — each touches live secret bootstrap and needs `op` plus careful sequencing (concrete item/field names live in the private companion, never here).

- [ ] **IP-pin the box-only R2 token.** The backups-bucket token is used only from the box, so a static-IP restriction fits (a Cloudflare-dashboard change, operator). The videos-bucket token is also used Worker-side and cannot be pinned.
- [ ] **Standardize the two R2 credential items' field names to snake_case.** Rename the labels AND update every `op://` reference that points at them (the injection templates under `docs/agents/hermes/secrets/`) in one pass, so injection never breaks between the two.
- [ ] **Retire the local-dev env mega-bundle — one source of truth per secret.** The ~35-field dev-env bundle duplicates standalone vault items, which is a rotation-drift hazard. Promote each TRUE secret to its own item and reference it directly from `apps/web/.dev.vars.tpl`; keep non-secret config inline. Mis-sequencing breaks dev secret load, so the template and the items move together.

### Hermes automation — non-root in the container (defense-in-depth, low priority)

`docs/agents/hermes/Dockerfile` still runs as root (no `USER`, no `useradd`). Run the agent as a non-root user with the token out of its readable env. Now that the token is `agent`-scoped this no longer guards the publish boundary — it protects the agent's own surface and the token value from a fully-compromised agent, and hardens against a container escape. Worth doing before any wider allow-list; not a blocker for the current private/trusted setup. Everything else about the box sweeps is ongoing operation, not build work — the units live in `docs/agents/hermes/*-timer/` and the operating doc is [docs/agents/hermes-agent.md](../agents/hermes-agent.md).

### Capture fallback — SoundCloud as a duration-gated secondary (revisit overdue since 2026-07-21)

The YouTube-side ladder shipped (rungs in measured-yield order over YouTube + YouTube Music, normalized query variant, duration vetoes, terminal-unmatched rescue). The 323-row spike priced the one true second source: **SoundCloud recovered 15 of the 125 rows YouTube Music still missed (~+5%)**, full-length public streams via yt-dlp, with the existing duration gate auto-rejecting 30s Go+ previews so a paywalled track cannot poison a capture. Same legality grade as the current rip.

**The decision:** read the residual `fluncle admin catalogue list --lens unmatched` rate **net of bot-challenge weather** (a 2026-07-18 wave against the proxy pool spiked unmatched to ~70/hr against a ~15 baseline, and those rows are false unmatchables), and wire SoundCloud as a fourth rung only if ~+5% pays for a second source's quirks (client_id rotation, 429s under bulk, routed through the same proxy). **Requeue the 07-18 bot-walled cohort first** — the fix that stops a bot-walled candidate landing terminal is in place going forward, but that cohort wants a `requeue-unmatched` pass before the rate is read. The other residual cause — wrong `duration_ms` on our own vinyl-era rows — no fallback source can fix; if it dominates, the repair is metadata re-verification.

### Workers AI for the utility inference layer — pilot the search-filter

Cloudflare **Workers AI** (open-weight models on CF's GPU network, callable from a Worker binding — roughly 100× cheaper than frontier, co-located so there is no external hop) is a genuine option for the **utility** inference tier, and not for the voice surfaces. The dividing line is voice + grounding quality: ChatDnB and the note/observation authoring stay on frontier; the bounded, structured, non-voice, failure-tolerant tasks move cheap and local.

- **Pilot: the search-filter LLM.** `apps/web/src/lib/server/search-llm.ts` still calls OpenRouter (`OPENROUTER_CHAT_URL`, `OPENROUTER_SEARCH_MODEL`). It emits FILTERS never rows, is never on the hot path, and its degradation contract already keys on the key being absent — so a weaker open model is pre-absorbed. Low-risk A/B: run the same queries through a Workers-AI instruct model vs. the OpenRouter one and compare the **emitted filters** before committing. Confirm function-calling support if the filter path needs it.
- **Same pattern, next:** the context-distill (`distilContextNote`) and submission triage — bounded, internal, non-voice — follow once the search-filter proves out.
- **The strategic angle.** Public ChatDnB's hold is partly a cost worry; Workers AI is the lever that could make an anonymous tier viable (frontier for the signed-in crew, a cheap open model for anonymous). Worth reconsidering when public exposure is decided — see _ChatDnB — the graduation questions_. It also serves LoRA adapters, so a future voice fine-tune has a plausible cheap home there (see _The Fluncle models_).

### Prompt + voice tuning — a read-ten-outputs loop, no deploy

Both remaining tuning items now run from `/admin/prompts` with **no deploy and no box rebake** (the prompt registry: the repo keeps a baked default, a DB row overrides it). That changes their character — these are taste passes, not code changes.

- **Context-notes shape.** Tune the distill prompt against accumulated real notes: which Firecrawl facts are worth keeping, how the distilled prose plus the one-line `Texture:` reads, and how cleanly it fuels a grounded observation script. A noisy note makes a worse spoken observation.
- **The Recovered-audio voice guide.** Fold Maurice's notes from real renders into the `copywriting-fluncle` voice reference + `observation-agent.md`: the arc (sensory → mood → connection → log ID → artist/title), line length and pacing for a heard surface, how hard the cosmos-sauce rides out loud, and where "too purple" begins. (SSML is not a lever — `<break>` tokens are stripped; Cartesia paces on punctuation.)

### Label logos join the owned-cover ladder

`labelLogoUrl` (`apps/web/src/lib/media.ts`) returns the raw R2 URL — no `/cdn-cgi/image` transform, no size ladder, no `?v` bust — so `/labels` ships full-size originals at catalogue scale, while the album fallback on the very same row **is** transformed. Serve label logos through the 64/300/640/1200 rungs and add the `labels` bust column (`image_updated_at` exists on the albums and artists tables, not on `labels`). Real bytes-on-the-wire win on a catalogue-scale hub, and the pattern already exists to copy — [docs/album-artwork.md](../album-artwork.md).

### Fluncle Studio — the caption gap blocks the IG validation

Clipping is live end to end: `distribute --set-video` stages the rendition, `analyze-set.ts` suggests windows, `/admin/studio/<logId>` frames draggable 9:16 clips, the on-box `fluncle-studio-clip` cron cuts and ships each `footage.mp4`, and `/admin/clips` hands off IG (with audio) / TikTok (audio-stripped) downloads. The drip-feed scheduler is built too — the schedule/status table, kill-switch KV, `pushInstagramReel`, the agent-tier `drip_clips` tick, auto-queue with 23–25h jitter. Doctrine: [docs/fluncle-studio.md](../fluncle-studio.md).

- **The caption gap is the actual blocker.** `buildClipCaption` ships the coordinate credit resolved via `resolveClipTracks`, but a clip from an **un-cued** recording resolves to no finding and builds an **empty** caption — which is all four existing clips (they come from the un-cued rolling set). So the order is: pick a clip and author a caption (or cue the source recording), **then** fire one real `drip_clips` tick to prove the push posts end to end before the cron runs wide. The kill switch stays off by default.
- **Then add a `clip-drip-timer/` host unit** beside `studio-clip-timer/` and let pin-watch deploy it. The sweep's own header says it plainly — auto-updated from main via pin-watch, docker-exec'd by a host timer, **no `docker cp`**. [docs/fluncle-studio.md](../fluncle-studio.md) still prescribes the retired `docker cp` + `hermes cron create` mechanism and wants the same correction.
- **Per-track cue labels.** Naming the specific track playing at a clip's window is the cue-marking synergy — `resolveClipTracks` / `trackLabel` already resolve it, nothing surfaces it in the caption. Gated on marking cues.

### Fluncle mobile — 1.0 awaiting Apple, 1.1 gates queued

The Expo app ships feed, archive, finding pages, submissions, the Radio (background audio + lock-screen presence), Mixtapes, search, device-local saves, push toggles, and Apple Music links. 1.0 was submitted, **rejected under Guideline 5.2.3**, remediated (`97897ed7` — the feed video is a MUTED visual, the card's sound is the official ~30s preview, `hasAudio: false` pinned in the `CardMedia` type and asserted as the 5.2.3 invariant), and resubmitted 2026-07-21. **Next state change is Apple's.** Runbook: [docs/mobile-release.md](../mobile-release.md); posture: [docs/app-store-review.md](../app-store-review.md) § 5.2.3.

- [ ] **On 1.0 approval: flip the `app.ios` registry surface.** A separate trigger from anything 1.1 — the surface is only real once the app is live.
- [ ] **1.1 ships — accounts in the pocket.** The build landed in one orchestrated run (#595–#602, plus the hydration gap closed same-day via `list_set_tracks`); what remains is the operator's dev-client rebuild (`expo-secure-store` is native), the on-device pass (sign up → save → set → notation → delete → reset), and the submission — all gated on 1.0's approval. The submission gates are named in [docs/mobile-release.md](../mobile-release.md) § _The 1.1 checklist_: the marketing `version` is **still `0.1.0`**, App Privacy re-declared with Email Address added, the review-notes addendum, `ascAppId` still an empty stub, and screenshots only if a surface changed materially.
- **The mobile Galaxy collection (backlogged 2026-07-15).** "The mobile app should get a similar treatment" — the `/account` collection home shipped on web and `list_private_galaxy_collection` is mobile-ready as-is, so the slice is **UI only**. There is no galaxy route under `apps/mobile/app/` yet.
- **Galaxy game on mobile (later, after star-sync).** The game joins the app once collected stars persist through accounts (see _User accounts_) so a run continues across surfaces; `@shopify/react-native-skia` is already a trusted workspace dependency, so the render layer has a plausible native path.
- **Brand marks (parked decision):** `react-native-svg` + `simple-icons` would render the platform marks canon-correctly; HeatButton's icon slot is already wired for it.
- **For the record, the 1.1 rulings:** transport is `@better-auth/expo` (SecureStore sessions, email/password in-app, the `fluncle://` trusted origin; the CLI's device flow stays the CLI's); home is an `/account` modal route entered from a person icon, never a tab; sync scope is notation → saved-findings union-merge → saved sets, with submission ownership deferred to 1.2; password reset ships in the arc (which discharges most of the standing web hardening item — see _User accounts_); in-app account deletion is mandatory under 5.1.1(v) and 4.8/Sign-in-with-Apple is deliberately not triggered. **The law on every slice: anonymous stays first-class; signing in only syncs.**

### The live rig — the M2-side checklist is entirely unrun

[docs/m2-checklist.md](../m2-checklist.md) is eight sections and **every box is unticked** — Rekordbox periodic sync, m2-sender MIDI validation, deck-identity Screen Recording + OCR, the dress-rehearsal gate, standing decisions, the key spot-check, historical set tracklists as mixability ground truth, and the report back to the M5. It gates the first show, it needs the M2 machine, and it is not agent-doable. **Two rows are safety calls, not chores:** the transition channel is unauthenticated and bound on all interfaces (a venue's network is not a home network — decide before the first show), and `MATCH_THRESHOLD = 0.62` shipped unvalidated (a false positive puts the wrong finding on stream, against the never-show-the-wrong-finding rail).

### Log IDs in search + AI answers (AEO/GEO) — the taste tail

The on-site layer shipped (per-finding pages with definitional prose + `MusicRecording` identifiers, sitemap + IndexNow fan-out, the `/about` entity/FAQ surface, `VideoObject`). Monitoring moved to _Now → Standing operation_; what remains here is buildable, in rough value order:

- **Label aliases join search.** The #700 artist-alias fold applied to labels — same deterministic tier, and `label_aliases` already accumulates candidates. The artist half is live in `search.ts` and is the precedent to copy; nothing references label aliases there yet. The only item in this tail with a proven shape to follow.
- **Per-index OG images.** The hubs share the generic cover; a Satori card per hub is pure polish.
- **`AudioObject` markup on observations.** The spoken observation as a first-class schema object on `/log/<id>` — absent from `apps/web/src` today.
- **`speakable` markup.** The SpeakableSpecification pass, once assistants actually consume it.
- **Third-party corroboration.** The MusicBrainz artist + Wikidata item anchors exist and sit in `/about`'s `sameAs` set. Remaining: authentic presence where DnB lives (r/DnB and friends — participate, don't fabricate; this is also the Reddit half of the overhaul's go-to-market), and enriching the Wikidata item as facts accumulate — including the mixtape item `Q140169844`, whose runbook is the [fluncle-mixtapes](../../packages/skills/fluncle-mixtapes) skill.

### Developer & discovery surfaces — the long tail

The machine- and developer-facing surfaces mapped in [docs/surfaces-doctrine.md](../surfaces-doctrine.md) (dig, the versioned contract-first API, the Fumadocs `/docs` hub, feeds, CLI distribution, SSH deep-links) are live. What's open:

- **Emit the Fumadocs pages as their own sitemap children.** `sitemap.ts` adds the `/docs` hub as one URL; the per-page `/docs/api`, `/docs/cli`, … children are still absent — the last half of that discovery gap. Ledger row: `docs/audit-backlog.md` (surfaces-seo, 2026-07-13).
- **The non-gating tail:** the `today` dig label, a public changelog, a Docker image, broader data-graph anchors (Discogs, Last.fm, ListenBrainz), directory listings (Product Hunt, Internet Archive, a Hugging Face dataset), the deferred **rave SSH `.onion`** identity (the web onion is live — `docs/tor.md`), and a **Discord representation of the log spine** (the one surface from the identity map never stood up; Discord exists today only as the Hermes chat presence). Each becomes a registry entry when one earns its keep.

### Announcements — one operator line, three things owed one

Announcing to the crew is one act, not a per-feature chore: a quiet line to the crew (Telegram / the Friday letter), drafted in Fluncle's voice through the `copywriting-fluncle` skill and operator-sent. Three things are owed one — **Fluncle Lens** (live in the Chrome Web Store, `extension.lens` registry fan-out done), the **Galaxy game** (v1 live; announce once the near-polish lands), and each mixtape as it goes out. Anything new joins this line rather than growing its own.

### Brand & canon — the video-side remainder (moodboard → canon audit)

The web half is resolved: the logbook plate, ignition hovers, the grain architecture, and the archive grammar are in DESIGN.md now. The video-kit laws still live video-local in the `fluncle-video` skill doctrine (presence, the plate lane, fixed-pitch / anchored-accent) — decide whether to promote or cross-link them into DESIGN.md canon rather than leave two homes. **Cross-link, don't duplicate.** Small and closable.

### Label outreach — the archive that can show its receipts (operator-led, unstarted)

Direct outreach to the DnB labels Fluncle logs and crawls — Hospital, Shogun Audio, Med School, Critical, and the seed set — introducing the project in its own voice: a fan-built archive spreading love for the music, not an AI-slop crawler and not a rip-off. Three things it buys, in order: **reputation in the scene** (the operator wants labels to hear about Fluncle from Fluncle first), **press-asset blessings** (a handful of yes-emails converts the artwork archive from gray-zone to partnership — the version that survives anyone asking "where did you get these"), and **the labels' perspective**, which he genuinely wants. Joint work: the assistant finds the right contacts (press / label-manager emails, contact forms — the artist-socials resolver's vendor stack helps), the operator writes and sends in his own name. Status per label lives with the operator, not here. This is also the label-outreach leg of the overhaul's go-to-market.

### Paid-service cost audit — is the run-rate earning its keep? (2026-07-18, triggered)

The `/admin/costs` ledger's annualized run-rate has grown enough to warrant a periodic honest review — real money for a free side-project with **no monetization path yet**. The stance is deliberately **spend-now**: this is the investment phase, and killing a capability to shave a few euros is the wrong trade while the archive is being built. But the number wants watching so it doesn't drift up unnoticed. (Per-line vendors and amounts stay in the private ledger by design.)

**The audit — one honest pass, biggest-line-first.** Per paid line: is it still earning its keep, is there a cheaper tier or free-tier fit, and can anything consolidate? The sonar box is now a **run-rate line** rather than a deferred lever (the vector half took the box route), so it belongs in the biggest-line-first pass. The one variable-spend lever the roadmap already names is the **Workers AI utility-inference** move (~100× cheaper for the non-voice tier); the remaining database-latency levers are cost-neutral or cost-additive and are tracked under _Later → Database latency_.

**The other side of the ledger — a paid offset (operator idea, "perhaps").** A **paid API tier** is a floated candidate; the versioned `/api/v1` contract, MCP, and the metered archive already exist. This is a product-direction question, not a cost-audit task — it wants its own scoping and it composes with _Later → The DnB identity graph_, which is where the shape of a paid rung is actually thought through.

**Trigger:** not now (spend-now holds). Run it when the run-rate crosses a threshold that stops feeling comfortable, or on a quiet quarterly cadence — whichever comes first.

### TikTok audio line-up (build only when a track breaks)

On standby, gated on an external trigger: a track breaking. The video is beat-matched to a Deezer/iTunes 30s preview (a fixed mid-song segment) while TikTok's attachable sound is usually — not always — the song's first ~60s, so when the preview segment isn't reachable there the visuals pulse to beats that aren't playing.

- **Stage 0 (now):** by-ear line-up.
- **Stage 1 (on break):** full-track audio for **analysis only** via Apify `apidojo/youtube-scraper` (stream URL → ffmpeg → analyze → discard). The mechanism is a live capability elsewhere (the hourly Apify anchor sweep), so this rung exists if the trigger fires. Audio policy is canon, not roadmap — see the `fluncle-publish` skill.
- **Stage 2:** pick the best ~20s window inside the first ~55s, render to it, write the absolute start offset into `render.json` and surface it ("start the sound at 0:42").

## Later — the bigger arcs

### radio.fluncle.com on Twitch 24/7 — the always-on channel

The opposite cadence to the "on the decks" live-set callout: an always-on, lean-back broadcast of [radio.fluncle.com](https://radio.fluncle.com) — the continuous run of Fluncle's findings, each playing under its observation — pushed to Twitch 24/7, in the spirit of the perpetual lofi channels. Where the on-the-decks callout is the one loud ephemeral beat, this is the quiet always-there hum: a passive, always-discoverable presence in Twitch's drum & bass directory, no live moment required. The shape is an unattended encoder (an `ffmpeg` loop on a small box, or a hosted restreamer) pulling the radio audio plus a quiet cover-led visual (calm, dark, reduced-motion-safe) and pushing RTMP to the Twitch ingest, with a watchdog to restart on drift; it composes with the live callout (the 24/7 stream steps aside, or hands off, when Maurice goes live). Nothing built — no encoder, no RTMP path in the repo. Gated on nothing structural; sized by the encoder-hosting choice.

### Fluncle's Galaxy — the game (v1 live)

v1 is live at [galaxy.fluncle.com](https://galaxy.fluncle.com): behind-the-ship 8-bit flight where every banger is a star at its Log ID coordinate, on one typed data-driven `Entity` model — black-hole teleports, asteroid waves + laser, the fuel economy with the dry-tank tow as the one true failure. What's ahead:

**Near polish:**

- **Economy tuning from a real full clear** (10–15 min target): burn rates, refuel dwell, cruise/boost speeds, plus the frontier dials — black-hole influence/pull radii and system count, asteroid wave density, laser cooldown, amen volume/fade. One human playthrough decides (out of agent scope by design).
- **Real-device mobile pass:** thumb zones on actual glass, safe-areas, the dynamic address bar, performance on a mid phone.
- **SFX pass:** richer 8-bit when it itches.
- **Boot cinematic upgrade** (v1 is minimal + skippable).

**The expanding frontier (the content engine):** the Log ID sector is days since the Fluncle epoch and maps to distance from Earth, deliberately uncompressed — the galaxy literally grows outward as findings land, full clears get longer, and that pressure is what future content answers. Set-dressing and hazard density already rise with distance and the black-hole network scales with the catalogue. The direction riffed on top (operator, 2026-07-15): **power-ups out in the deep** (bigger tanks, faster engines), **star density thinning with distance** so the frontier feels like one, and "leaving space for… other things" — undefined on purpose. Still ahead too: **new home planets as forward bases / respawn + refuel hubs**, derelicts and lore nodes. The further from Earth, the stranger the universe. (The stakes law this all hangs on — no refuel at logged stars, fuel always burns — is enforced in `game/sim.ts` and is not open work.)

**Backlog (still open):**

- **Worm holes as a distinct entity** — deferred: the black-hole teleport network already carries the "shortcut to the far side" flavour; a separate worm-hole only if it earns its own navigation.
- **Other planets / forward bases** — tied to persistence (refuel hubs / respawn points out on the frontier).
- **The bespoke sprite menagerie** beyond the heroes.
- **Multiplayer — a shared galaxy (idea, 2026-06-24 scribble)** — open the single-pilot universe to the crew: other players' dots on the **radar** in your sector, their recently-flown **tracks**, and a sense of which stars are **popular** across everyone so the catalogue's hotspots show on the map. Each pilot picks a **custom spaceship** from a small palette. Ties to persistence / accounts and reuses the existing radar. A big social direction — unscoped; capture-for-later, picked up once the single-player frontier is polished.

Persistence is tracked once under _User accounts_, not duplicated here.

### From Earth to Orbit — the lifecycle arc

The lifecycle view shipped as `/pipeline`. The remaining, still-deferred parts are the generation and account-touching pieces, each behind a go/no-go, with **collection deliberately decoupled from public accounts**:

- **2 · Per-track sprite generation — gated on a spike.** An automation that mints a unique pixel sprite per finding (seed: cover art + the finding's sonic galaxy). This is the one place we want **variety inside the consistency**, and that is exactly the hard, unproven problem: AI generation converges on a shared attractor, so a ~10-sprite spike must prove real variety that still reads as one family before the arc commits. **One home only:** this spike is the same work as _The Fluncle models § 2 · the eye_, which absorbs it — scope it there, not twice.
- **3 · Collectable sprites in the Galaxy game — private collection.** Each finding becomes a star/sprite you fly to and **collect**, plus a binder-style collection page (empty outlines that fill in on collect). It rides the **existing** private account layer and the Log-ID-keyed progress store (`apps/web/src/game/progress.ts`), so it works with what ships today.
- **4 · Public accounts + profiles — an optional later flip.** Only if shareable public collections earn it; gated on the Public marginalia RFC (see _User accounts_). Not a prerequisite for anything above.

### User accounts

The private web account layer is live (Better Auth email/password + username, `/account`, private Galaxy lifetime progress, saved findings, saved sets, watches, signed-in submission ownership, export/delete, hard separation from admin auth). **The standing law, operator-ratified: an account NEVER gates a feature.** Device-local persistence stays the default; the account is the backup/sync upgrade, never the toll booth. That law governs every item below and is not restated per bullet.

- [ ] **Accounts become first-class sync citizens (HIGH — operator-prioritized 2026-07-12).** In-progress chained sets (the `/mix` builder, web and mobile) and Galaxy star collections sync across web ↔ mobile when signed in. The web halves shipped: saved sets store the serialized `?set=` chain + `?taste=` seed verbatim on the `/me` private tier, so opening one hands it straight back to the route's loader. **The mobile half is scoped into the 1.1 arc** — the wire format and ops are already public, so that slice stays a thin client.
- [ ] **The Scales/Camelot preference — mobile half pending (scoped into 1.1).** The extensible `user_preferences` store, the `/me` ops, and every web key readout obey the one preference already; the Decks toggle adopting the same profile field is what's left. A DJ who thinks in Camelot thinks in Camelot everywhere.
- **SSH device login:** the open half of cross-surface login (the CLI `fluncle login` half is done) — SSH device auth for synced Galaxy lifetime markers, saved findings, and own submissions. SSH stays anonymous by default, and the user token stays separate from `FLUNCLE_API_TOKEN`.
- **Authenticated MCP tools:** only if there is a concrete agent use case; keep the existing MCP server/card anonymous until a dedicated auth contract, CORS/header behaviour, and failure model exist.
- **Public marginalia RFC:** public crew cards, public submission credit, crew notes, reports, moderation, and profile-like surfaces need their own RFC before implementation. Hard default remains no public writing.
- **Email/password hardening:** largely discharged by the 1.1 password-reset ruling (Better Auth email reset via Resend on the newsletter domain). What remains is policy: abuse thresholds, disposable-email handling, and support copy once real usage shows the pressure points.
- **Account ops polish:** keep the account env vars prominent (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`) and do a real-data privacy pass on export/delete once a few accounts exist.

### Release & event watchers — the DELIVERY half

**Scope, narrowed:** a user can already watch an artist or a label — the `user_watches` table (migration `0113`, unique per user × kind × entity, with an `includeSimilar` flag that has no consumer yet), the `/me` ops in `me-watches.ts`, a quiet `WatchButton` on `/artist/<slug>` and `/label/<slug>`, and the watch list on `/account`. **That is the substrate, not the feature: nothing fires yet.** The two unbuilt halves are what make a watch _do_ something — the notification / weekly digest on a watched artist's new release, and the events layer that lets a watch fire on a gig.

Real-user-validated the day `/fresh` shipped: a DnB fan, unprompted, asked for exactly this ("I've wanted an app that can easily find new releases for ages" + "and related artists, to discover new ones"). `/fresh` is the pull surface; a watcher is the push surface. Delivery starts with **email** (the `newsletter.fluncle.com` Resend domain is live; a per-user "new this week from your artists" digest is the mothership pattern narrowed to one crew member), push arriving with mobile. Release detection rides the existing fresh-releases family (`list_fresh` / the `/fresh.xml` feed, keyed on `tracks.release_date` — the Found Rule keeps "came out" distinct from "Fluncle found it").

Two prerequisites, in order:

- **The gigs / festival crawler is the load-bearing prerequisite (operator-named 2026-07-18).** Watchers are half-built without events: the fan wants "my artist just dropped" AND "my artist is playing near me." So the first real dependency is an **events subsystem** — concerts, raves, and festivals as first-class entities (an `events` table: artist(s) via the existing graph, venue, city, date, ticket link), crawled the way the catalogue is (a seeded, deterministic, resumable sweep — the [catalogue-crawler](../catalogue-crawler.md) `crawl_frontier` shape is the precedent). No such entity exists today (`schema.ts` has `status_events`, `cost_events`, `rate_limit_events` and nothing else). It stands on its own too — a public `/events` or per-artist "upcoming" surface, `MusicEvent` JSON-LD for SEO — and it is the biggest genuinely-unbuilt product slice on this list. Scope it FIRST.
- **Related-artist discovery (the "gerelateerde artiesten" half).** Watching one artist should surface the ones next to them. This is now a **surfacing** job rather than a modelling one: per-artist centroids + `artist_similar` ship (read by `getArtistNeighbours`), so "watch Lenzman" can already resolve "and these five you'd probably watch too" — the work is surfacing that edge inside the watcher feature.

The operator-ratified order stands: **events crawler → watchers (releases + gigs) → related-artist suggestions.**

### Public feature-ideas inbox — a voteable backlog (idea, 2026-06-24 scribble)

A public, voteable ideas board: visitors and the crew submit feature ideas and **upvote** the ones they want, so what to build next carries a public signal rather than only the operator's call. Reuses the existing submission-inbox shape but for ideas, with vote counts ranking the backlog. It is **public writing**, so it inherits the open questions under _User accounts → Public marginalia RFC_: moderation / abuse, anonymous vs account-gated voting (one vote per identity), spam, and the no-public-writing default it would deliberately relax. Unscoped capture-for-later — would want that RFC first.

### The DnB identity graph — ISRC → every-platform resolver (product/API idea, 2026-07-21)

Born from scratching our own itch: anchoring the catalogue to Spotify and Apple turned into a deep pass on ISRC → streaming-link resolution, and the conclusion was that the thing the whole ecosystem needs — a reliable ISRC → {Spotify, Apple Music, Deezer, Tidal, …} resolver — is exactly what **Fluncle is already building as a byproduct**, curated and verified, for drum & bass specifically. Odesli/Songlink is retreating precisely because a _general_ resolver is a hard, adversarial, cache-is-the-moat business fought against platforms that break you at will. The general version is quicksand; the **genre-deep, curation-moated** version is not — our edge is not scraping, it is the operator's taste plus MusicBrainz-grade identity resolution, which no scraper reproduces.

The shape, if pursued: a public `/api/v1/resolve?isrc=…` (and by MBID) returning the multi-platform identity map for any track in the archive, free at low volume, **paid tier for higher limits / bulk**. The cache Fluncle accretes is permanent and decaying-load by nature — resolve once, cache forever — and the anchor waterfall that fills it is already live and running hourly.

**This wants an RFC, not a build slice.** What is free vs paid, coverage honesty for the long tail, ToS posture per platform, and whether a DnB-only graph is a big-enough market or a wedge into a broader one. It is where the floated paid-API-tier question from _Paid-service cost audit_ actually gets thought through, and it inherits the does-monetization-fit-the-persona question from ChatDnB's public-exposure arc. Flagged as the highest-potential business seed the project has surfaced, because the moat (curation) is the thing Fluncle's design already produces.

### Database latency — the deferred levers (Placement Hints, then the own-box)

Phase 0 shipped: the query-wave collapse and the `/log` edge cache extended to the `/artist|/album|/label/<slug>` detail pages with purge-on-write, so a cache hit crosses no ocean and the reader/SEO half of the Dublin-anchor pain is off the hot path. The full six-option analysis lives in [docs/planning/turso-latency-research.md](./turso-latency-research.md). (D1 was considered and **rejected** there — it forks the store and downgrades similarity to ANN, abandoning the exact `vector_distance_cos` scan the archive is built on.) Two levers remain, in order, both **earned by numbers, not pushed**:

- **Placement Hints — the free, reversible next lever.** Pin the SSR Worker to Turso's region so a distant reader pays one ocean crossing rather than one per sequential query. Config-only, one-line-reversible, no surcharge, still Cloudflare-beta — and confirmed **not enabled** today (nothing in `apps/web/wrangler.jsonc`). It targets the one thing the cache can't: the uncacheable per-user paths (ChatDnB, search, recommendations) for distant readers. Turn it on behind a flag, measure those paths, keep it if it wins. Try this before contemplating any migration.
- **The own-box — now specifically the WHOLE-APP port.** The vector half already took the box route (`apps/sonar`), so "put the corpus in RAM on a box" is settled and is not a fork to re-litigate. What remains is hosting the whole app on a box behind Cloudflare so the database is `localhost` — SSR + oRPC + DB in one process, with the Phase 0 cache as the global-reach engine and Litestream→R2 / Turso as the backup. A strategic architecture bet, not a config flip. The target architecture and the throwaway de-risking spike are sketched in [docs/planning/own-box-spike.md](./own-box-spike.md). Trigger: only if post-Phase-0 (± Placement Hints) numbers prove the uncacheable per-user path is still too slow, or to de-risk the port early while traffic is low.

## Homogenisation — the drift toward a mean (2026-07-11)

**The observation that names it:** Fluncle's generated artifacts drift toward a mean. It has been seen independently across families, which is what makes it a property rather than a pair of bugs — the notes (one word in 15 of 61 live notes; a sentence lifted verbatim between two), the videos (four of five consecutive renders sharing one palette + texture). Counter-measures have shipped per family — the vibe-neighbour layer + echo gate for the notes (within-region overlap 0.041 → 0.015), the deterministic axis assigner + palette provenance + palette gate for the videos — but **the slice itself is still unscoped**, and the operator's ruling stands: evidence collection before scoping.

**The ledger owns the status.** Occurrences, the measured before/after numbers, and the per-family harness runs land in the [homogenisation evidence ledger](./homogenisation-evidence.md); its own _What the ledger still wants_ section is the live worklist. Do not restate it here.

**Why it matters more than it looks.** Fluncle's whole claim is that a human with taste went out, dug, and came back with something. An archive whose every artifact rhymes with its neighbours reads as machine-made — exactly what the persona cannot afford. Sameness is not an aesthetic nit here; it is a credibility leak.

**The four forward rails (the slice wants a real design pass, and the operator wants a taste dive on the corpus before any scoping):**

- **Measure it first, everywhere.** Every generated family (notes, observations, logbook entries, videos, covers, sprites) wants a cheap, honest diversity metric run on the real corpus. **An anti-sameness effort with no metric is folklore.**
- **Spend the moves.** The mechanism that worked for the notes generalises: show the generator what its neighbours already did, and require it to find what is true of _this_ one and nothing else.
- **Design the diversity in.** Per the video law: assign the family/angle up front rather than asking for variety. Prescriptive mid-flight coaching increases convergence rather than fixing it.
- **The long-term drift risk, stated honestly.** "Spent moves" pushes each new artifact away from what came before. At 61 notes that is a fix; at 300 it could push the voice off its own centre. **Re-measure as the corpus grows** — the harness makes that one command.

It composes with the prompt registry: fighting sameness is an iterative taste loop — change a prompt, read ten outputs, change it again — and that loop now runs from `/admin/prompts` with no deploy and no box rebake.

## ChatDnB — the graduation questions (both doors shipped; public exposure open)

The pun earned its spike, the spike shipped, and both doors are live: `/admin/chat` for the operator and `/chat` for signed-in verified-email accounts, one shared conversation UI behind the full rail stack. The rails are canon and the rate dials live in the code, not here. What remains is the **public exposure call** — three questions, none of them answered:

- **Does `/chat` ever open past the signed-in crew?** The door exists and the page is deliberately unlisted (no registry entry, `noindex`, no announcement). The hold is partly cost — every anonymous conversation is real inference money from non-paying users — and an anonymous tier needs its own abuse posture (IP-keyed dials; there is no session identity to hang a ceiling on). `chat.fluncle.com` remains an option; `chatdnb.com` is taken, and the pun survives the URL. Workers AI is the lever that could change the cost half of this (see _Next → Workers AI_).
- **Model choice.** A well-prompted frontier model with the hard grounding rule is the honest v1; the FluncleLLM voice fine-tune is an obvious future consumer (see _The Fluncle models_).
- **The add-to-my-playlist tool, on graduation.** "Add 3 more recommendations to my playlist" mutating the user's minted playlist by tools (operator, 2026-07-16) — a graduation feature, not a today feature.

The rails carry into any public version unchanged: grounding is the product, he never speaks about an uncertified track (ratified canon — the catalogue is a utility layer with no narrative voice), the surface stays a quiet plate rather than a SaaS chat window, and the voice gate applies — this is him _talking_, the most exposed his voice ever gets.

## Epic — search goes internal: cut Spotify out of the read path (2026-07-18, operator-ratified)

Today `search_tracks` (the MCP tool + the submit-candidate flow) calls `searchTrackCandidates` → **Spotify's API**; the contract file still documents the split verbatim (`search_tracks` → SPOTIFY, `search_archive` → FLUNCLE), so nothing has collapsed yet. The original reason was sound — a search result carried the Spotify URL that `submit_track` needs — but the catalogue crawler now mints rows WITH `spotify_url` (and Apple/ISRC anchors), so **the internal catalogue can serve the same search**, with two wins: it stops eating the Spotify app's rate limits, and it makes "search Fluncle" actually search Fluncle.

**The shape:** move every search consumer onto ONE internal catalogue search — the MCP search tool, the public API op, the SSH rave terminal, the CLI, and any other surface (enumerate them first; the web CMD+K already uses the internal `search_archive`, so part of this is unifying `search_archive` + `search_tracks` into one catalogue-scoped search with a findings/catalogue register split). Spotify stays ONLY where it is genuinely irreplaceable — the actual submission/enrichment fetch of a track we do not yet hold — never in the search READ path.

**The open sub-question to settle when scoped:** coverage. Internal search only finds what we have crawled, so submitting a brand-new track needs either a Spotify fallback for the submit-something-new case, or a submit flow that accepts a pasted Spotify URL directly. Decide the fallback posture before cutting Spotify out of the submit path specifically; the discovery/browse read paths can go internal immediately.

**Adopt the `/tracks` hub's filter schema — do not redefine it.** `/tracks` is live (`apps/web/src/routes/tracks.tsx` over `apps/web/src/lib/server/tracks-hub.ts`), with `TracksHubFilters` (`apps/web/src/lib/tracks-search.ts`) as the ratified filter vocabulary — `bpmMin`/`bpmMax`, `yearMin`/`yearMax`, `key`, `label`, `galaxy`. The search LLM tier already emits FILTERS never rows, so the work left is that the internal catalogue search READS that same schema rather than growing a second one.

**No archive-search tool waits on this.** `searchArchive` is already catalogue-inclusive (one deliberate LEFT JOIN, `certified`-tagged rows), so this epic's scope is only: retire the Spotify candidate search on the submit/write path, and collapse `search_archive` → the canonical `search_tracks` name.

## The Fluncle models — the voice, the eye, the ear (idea, 2026-07-11)

One arc, three probes. Fluncle already generates — notes, observations, logbook entries, shader videos, sprites, covers — but always by **constraining a stranger**: a general model held in line by a prompt, a skill, and a voice gate. The question this arc asks is what changes when the model has **only ever known Fluncle**. Three fine-tunes, three faculties, sharing a method (LoRA on an open-weight model, rented GPU, single-digit dollars), a discipline (run behind the existing gates, not instead of them), and a rule.

**The rule — and it is the only one that matters here: the line is PUBLISHING, not EXPERIMENTING.** What ships under Fluncle's name is bounded by canon. What we _try_ is not. Probing and following curiosity into the not-yet-known is exactly what this project is; refusing an experiment because its _product_ would be off-brand is the incurious move Fluncle would never make. **Never confuse "do not ship it" with "do not try it."** An experiment that teaches us something and ships nothing has done its job.

Where the models run: the private companion repo (`fluncle-labs`) — corpora, training scripts, and artifacts stay there. Findings graduate to this repo as ideas; code and weights do not.

### 1 · The voice — a model that writes like him

Fine-tune on **Fluncle's own written corpus**: the editorial notes, the spoken observation scripts, the Logbook entries, the Telegram posts, the newsletter editions. Every word was authored for this project and most of it is operator-verified, which makes this the rare fine-tune with **no legal question at all** — the corpus is ours outright.

The prize: the voice gates and the `copywriting-fluncle` skill work, but they work by constraining a stranger. A model fine-tuned on the corpus would carry the register natively — the said-not-written rhythm, the Dry Rule, the recovered-log idiom, the em-dash law — and the drift the gates catch would mostly stop happening. It compounds: every operator edit to an auto-note is a training signal, and the note agent's correction pairs are already the seed of that dataset.

Shape: assemble the corpus (operator edits as the preferred targets), LoRA a small instruct model, run it **behind the existing voice gates** — the win is measured by how rarely they fire. First consumer: the auto-note (highest volume, already fill-empty-only, already has correction pairs). Honest open questions: is the corpus thick enough yet (~15 findings/week means ~15 notes + ~15 observations a week, so "wait for more" is weeks not years), and does a fine-tune actually beat a well-prompted frontier model at this scale? A genuine spike, not a foregone conclusion.

### 2 · The eye — generation as Fluncle's imagination

The other place generation is unambiguously on-brand: the visuals are **Fluncle's own imagination**, not someone else's recording. Nobody is infringed, no canon is contradicted (the whole Nostalgic Cosmos is already machine-made under the operator's eye), and the failure mode is aesthetic rather than legal.

Deepen the per-asset scripts into a real generative capability — a model or pipeline **pointed at a finding** that produces its scene, its sprite, its cover, all in one family, seeded by what the archive already knows about it: the cover art, the MuQ embedding, the galaxy it landed in, the BPM and key, the note. This is where the archive's data pays a _visual_ dividend — a finding's embedding is a genuine seed for what its scene should look like, which no stock generator can do.

**This is the single home for the per-track sprite spike** (cross-referenced from _From Earth to Orbit § 2_, not carried twice): its hard part — variety inside consistency — is exactly a generative-model problem. It also absorbs the video kit's texture families and the galaxy's visual identity now that the galaxies are data-real. The known trap is the one the video work documented: parallel generation converges on a shared attractor, so **diversity has to be designed in, not hoped for**.

### 3 · The ear — a model trained on what he certified (internal only)

**Not a product. An experiment — and the corpus is already sitting there, growing ~15 tracks a week.** The findings carry captured full audio, which is not a _drum & bass_ corpus: it is **the tracks Fluncle personally certified**. A LoRA on that is not a genre model, it is a model of one person's _taste_, asked what it dreams. Canonically that is what a mixtape already is (the mixtape is Fluncle dreaming), which makes the artifact interesting on its own terms even if not one second of it is ever heard by anyone but us.

**The experiment is better than "can it make DnB."** The captions carry the galaxy name, so the real question is: **prompt it with "solar" and does it sound like Solar?** If the model learned the galaxies from audio alone, that is _independent_ evidence — arriving from a completely different direction than clustering — that the MuQ space carved along boundaries a human actually hears. That is a real finding about the archive's foundational assumption, and it costs about three dollars to get. The model choice and the trainer are settled (a permissively-licensed long-form music model with an official LoRA trainer, ~an hour on a rented 4090); the corpus export, the captions, and the whole runbook are **prepped and ready to run** in the companion repo.

**The hard rail — a PUBLIC Fluncle music generator is rejected, and that is not in tension with running this.** Shipping AI-made DnB under Fluncle's name fights the canon head-on (PRODUCT.md: a mixtape is authentically Fluncle _"where an AI-made original would fight the persona"_) and his whole credibility is that a human with taste went out, dug, and certified. So: the artifact is **internal only** — never published, never on a public surface, never in a mixtape, never sold, never presented as Fluncle's music. Its value is what it **teaches**, not what it emits. A surprising result is a **finding**, not a **release** — and it feeds the voice and the eye, which are the two faculties that _do_ ship.
