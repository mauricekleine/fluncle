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

### Paid-service cost audit — is the run-rate earning its keep? (2026-07-18)

The `/admin/costs` ledger's annualized run-rate has grown enough to warrant a periodic, honest review — it is real money for a free side-project with **no monetization path yet**. The stance is deliberately **spend-now**: this is the investment phase, and killing a capability to shave a few euros a month is the wrong trade while the archive is still being built. But the number wants watching so it doesn't drift up unnoticed. (The per-line vendors + amounts live in the private `/admin/costs` ledger by design — not restated here, per the same rule that keeps that ledger in the DB rather than this public repo.)

**The audit — one honest pass, biggest-line-first.** For each paid line: is it still earning its keep, is there a cheaper tier / free-tier fit / a cheaper alternative, and can anything consolidate (two boxes into one role, a usage-based sweep that should trend toward zero as its backlog drains, a trial kept only if its signal proved out)? Sequence the wins the roadmap already names rather than re-deriving them — chiefly the **Workers AI utility-inference** move (the biggest variable-spend lever, ~100× cheaper for the non-voice tier — see above) and the deferred **Database-latency** levers (avoid a premature paid migration; keep the exact vector scan until numbers force it).

**The other side of the ledger — a paid offset (operator idea, "perhaps").** The durable answer to a rising run-rate is not only cutting cost but growing revenue: a **paid API tier** is a floated candidate — the versioned `/api/v1` contract, MCP, and the metered archive are already built, so a paid rung is more plausible here than for most side-projects. This is a **product-direction question, not a cost-audit task** — it wants its own scoping (what is paid vs free, pricing, billing/auth, and whether monetization fits the persona at all) and composes with the ChatDnB public-exposure + User-accounts arcs. Flagged as the complementary lever; the audit stands on its own without it.

**Trigger:** not now (spend-now holds). Run it when the run-rate crosses a threshold that stops feeling comfortable, or on a quiet quarterly cadence — whichever comes first. The private `/admin/costs` ledger (grouped by category, per-month/per-year totals, paid-vs-free counts) is the source of truth and makes the pass a read, not an archaeology dig.

### Capture fallback — SoundCloud as a duration-gated secondary (revisit ~2026-07-21)

The 2026-07-14 capture-quality arc shipped the YouTube-side fixes (the three-rung search ladder over YouTube + YouTube Music, the normalized query variant, the duration vetoes, the terminal-unmatched rescue — 295 rows re-queued). The measured spike on the 323-row terminal-unmatched set also priced the one true second source: **SoundCloud recovered 15 of the 125 rows YouTube Music still missed (~+5%)**, full-length public streams via yt-dlp (no account, no API key — the anonymous `client_id` is auto-scraped), with the sweep's existing duration gate auto-rejecting the 30s Go+ previews so a paywalled track can never poison a capture. Same legality grade as the current YouTube rip.

**Decide after the ladder has a week of prod data.** The new `unmatched`/`failed` lenses (`fluncle admin catalogue list --lens unmatched`) are the scoreboard: read the residual unmatched rate once the rescued rows drain. Wire SoundCloud as a fourth ladder rung only if the residual stays big enough that ~+5% pays for a second source's quirks (client_id rotation, 429s under bulk — route through the DataImpulse proxy like YouTube). The full source research (Bandcamp as the other candidate, the rejected rails) is in the 2026-07-14 session's audit; the bad-reference-duration class (wrong `duration_ms` on our own vinyl-era rows) is the other residual cause a fallback source cannot fix — if it dominates, the repair is metadata re-verification, not a new source.

### Catalogue backfills — drain the small back-catalogue (monitoring)

The `fluncle-backfill` cron paces the two Worker-side catalogue sweeps (Discogs resolve + Last.fm love), with reliability columns gating already-done rows and Retry-After backoff so a 429 cools down instead of storming. What's left here is just **watching the small catalogue drain** — confirm each pipeline's back-catalogue empties out and stays empty. (Album-art → R2 ingestion shipped separately as the owned-cover-master sweep + `fluncle-cover-masters` cron — [docs/album-artwork.md](../album-artwork.md).)

### Observation pipeline — context-notes shape finetune

The empty-context retry path is operational (`context_status` distinguishes confirmed-empty from never-attempted, and `--retry-empty` on `fluncle admin tracks context --queue` + the on-box sweep flag widen the net), so a rare "facts may have appeared upstream" pass can be triggered when wanted. What's open:

- **Context-notes shape finetune.** A tuning pass on the distill prompt (`observation.ts distilContextNote`) against accumulated real notes — which Firecrawl facts are worth keeping, how the distilled prose + the one-line `Texture:` shape reads, and how cleanly it fuels a grounded observation script (a noisy note makes a worse spoken observation).

### Workers AI for the utility inference layer — pilot the search-filter

Cloudflare **Workers AI** (open-weight models on CF's GPU network, callable from a Worker via a binding — roughly 100× cheaper than frontier, 10k neurons/day free, and co-located so there is no external hop) is a genuine option for the **utility** inference tier — but NOT for the voice surfaces. The dividing line is voice + grounding quality: ChatDnB (Fluncle's most exposed voice, hard-grounded) and the note/observation authoring stay on frontier / the `ln` Claude subscription; the bounded, structured, non-voice, failure-tolerant tasks move cheap and local. The rule of thumb — the utility layer goes to Workers AI, the voice layer stays frontier.

- **Pilot: the search-filter LLM (`search-llm.ts`) — the obvious first move.** It emits FILTERS never rows, is never on the hot path, and already degrades gracefully when the model is down, so a weaker open model is already handled by the degradation contract; moving it to a Worker binding makes it near-free, faster, and one fewer external dependency. Low-risk A/B: run the same queries through a Workers-AI Llama-70B (or current best instruct model) vs. the OpenRouter model and compare the emitted filters before committing. Confirm the chosen model's function-calling / tool support if the filter path needs it.
- **Same pattern, next:** the context-distill (`distilContextNote`) and submission triage — bounded, internal, non-voice — follow once the search-filter proves out.
- **The strategic angle — public ChatDnB's cost gate.** The public-exposure hold is partly a cost worry (every anonymous conversation costs frontier inference). Workers AI is the lever that could make an anonymous tier viable — frontier for the signed-in crew, a cheap open model for anonymous — worth reconsidering when public exposure is decided (see _ChatDnB — the graduation questions_).
- **Synergy with the models arc.** Workers AI serves LoRA adapters, so a future FluncleLLM voice fine-tune (see _The Fluncle models_) has a plausible cheap, co-located home there.

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

**Superseded by the 2026-07-17 latency analysis — read that first.** The edge-cache win shipped (Phase 0, now extended past `/log` to the entity pages), and the full six-option study ([docs/planning/turso-latency-research.md](./turso-latency-research.md)) reframes this item: **D1 is no longer the recommended path** — it forks the store and downgrades similarity to ANN, abandoning the exact `vector_distance_cos` scan the archive is built on. The deferred levers that keep the exact scan are **Placement Hints, then the own-box** (tracked under _Later → Database latency — the deferred levers_). Keep this D1 note only as the "considered and rejected" record.

### Recommendation vector search at scale — spike Cloudflare Vectorize (2026-07-18, spike-soon)

The Frontier novelty scale bench (2026-07-18, against scratch hosted Turso) put hard numbers on a wall the engine already documented (`recommendations.ts` scale tripwire): the base per-user recommendation scan — max-similarity of the embedded catalogue against a user's ≤12 seed vectors — is an **exact `vector_distance_cos` scan whose cost grows linearly with the candidate pool**: ~5.3 s @ 5k candidates, ~5.8 s @ 10k, ~15 s @ 25k (12 probes, blob-bound, folded into one pass), extrapolating to ~150 s at 250k. **Novelty itself is not the cost** — the last-8-editions `NOT IN` derive is ~50 ms on a `user_id`-index path and its added scan cost sits within the measurement noise. Turso's own guidance puts the exact-scan comfort ceiling at **~10k vectors**, and its ANN index (`libsql_vector_idx` / DiskANN) is unusable for us — the repo measured `float1bit` recall at **21.6%** and a populated-table build wedging the write path 20+ min. So on Turso this query is **exact-scan-forever**, and catalogue scraping in full swing is pushing the candidate pool up fast.

**Why it's not urgent, and why it still earns a spike soon.** #688's shelf-from-editions moves the scan **off the hot path** — recs are computed + frozen at edition-write time (weekly sweep + explicit mint), so page loads read a frozen edition, not a live scan. That converts a fatal page-load latency into a tolerable weekly-batch cost and buys real runway at the realistic corpus size (< ~100k, ~250k absolute worst case per the operator). But there is **zero ANN headroom on Turso**, and the interactive `"sounds like <track>"` sonic search ([docs/search.md](../search.md)) is a live, user-facing vector query with no edition-cache to hide behind.

**The pre-vetted escape hatch is Cloudflare Vectorize** — keep Turso as the relational system-of-record, move only the vectors. Workers-native, 1024-d supported, 10M vectors/index (250k = 2.5% of one index), a few $/mo. **The reframe that matters (reconciling the earlier verdict):** the six-option latency study ([docs/planning/turso-latency-research.md](./turso-latency-research.md)) rejected Vectorize because moving the store "downgrades similarity to ANN" — true for a **centroid** query, but the recs engine is **multi-modal by design** (12 separate probes, never averaged into a centroid — his taste is multi-modal, [docs/the-ear.md](../the-ear.md)). A multi-modal seed maps _perfectly_ onto Vectorize: 12 single-vector ANN lookups + a union/merge is the **correct** primitive and exactly where ANN is strongest. So the earlier "ANN downgrade" call does **not** hold for this specific workload — the very design that strains the Turso scan is what makes Vectorize a natural fit rather than a compromise.

**The spike (bounded, self-contained — the one real unknown is recall).** Mirror a sample of the current MuQ embeddings into a scratch Vectorize index, issue the 12-probe union query, and **compare its top-N against the exact-scan ground truth to get a real recall@N number.** Cloudflare publishes no recall figure, and recall is precisely the assumption that killed Turso's ANN — prove it before building any sync pipeline. If recall holds, the migration is well-shaped: Turso stays system-of-record (Vectorize is eventually-consistent, median < 30 s to queryable), each recs request becomes 12 `query()` calls (topK ≤ 100) + a merge + a relational hydrate back in Turso.

**Triggers to actually switch (not before):** the catalogue credibly heading past ~100k candidates, **or** the interactive sonic search feeling slow to users, **or** the edition-cache proving a fragile crutch (cold-miss / re-embed latency cliffs). **Interim Turso runway without switching:** since the seeds are multi-modal, run **12 per-seed pre-filtered scans + union** (each seed's galaxy / key+BPM neighbourhood) rather than one folded full scan — a real Turso speedup _and_ the exact shape you'd later port to Vectorize. Full current-state comparison (Turso 2026 vector limits + cost, Vectorize limits/pricing/consistency, pgvector as the rejected heavy option) is in the 2026-07-18 vector-store analysis.

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
- [x] **The 1.1 arc — accounts in the pocket: BUILT (2026-07-14, seven PRs #595-#602 in one orchestrated run).** All six slices merged + the flagged hydration gap closed same-day (`list_set_tracks`, so a saved set hydrates whole on every surface). REMAINING before 1.1 ships: the operator's one dev-client rebuild (`expo-secure-store` is native) + the on-device pass (sign up → save → set → notation → delete), then the 1.1 submission per the delta section in docs/mobile-release.md — all gated on 1.0's approval. The rulings, for the record:
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

### Release & event watchers — "tell me when my artists drop or play" (real-user-validated 2026-07-18)

A signed-in user **watches** an artist (or a label), and Fluncle tells them when that artist RELEASES something new — and, once the events layer exists, when they PLAY somewhere. Real-user-validated the day `/fresh` shipped: a DnB fan, unprompted, asked for exactly this ("I've wanted an app that can easily find new releases for ages" + "and related artists, to discover new ones"). This is the demand-side twin of `/fresh`: `/fresh` is the pull surface (everyone's new releases, browse it), a watcher is the push surface (your artists' new releases, delivered).

The substrate is already here. The **release-detection layer** is today's fresh-releases surface family — `list_fresh` / `GET /api/v1/tracks/fresh` and the `/fresh.xml` feed a notifier polls, keyed on `tracks.release_date` (the Found Rule keeps "came out" distinct from "Fluncle found it"). The **"which artist" layer** is the canonical artist entity + the `track↔artist` graph ([docs/artist-relationship.md](../artist-relationship.md)). The **"who to notify" layer** is the live private account (Better Auth + `/account` + the `user_preferences` store, whose partial-merge PATCH takes a new `watches` field with zero migration). Delivery starts with **email** (the `newsletter.fluncle.com` Resend domain is live; a per-user "new this week from your artists" digest is the mothership pattern narrowed to one crew member), push arriving with mobile. The **never-gates law holds**: a watcher is an account UPGRADE, never a toll — anonymous keeps `/fresh`, the feeds, and search untouched.

Two prerequisites, in order:

- **The gigs / festival crawler is the load-bearing prerequisite (operator-named 2026-07-18).** Watchers are half-built without events: the fan wants "my artist just dropped" AND "my artist is playing near me." So the first real dependency is an **events subsystem** — concerts, raves, and festivals as first-class entities (an `events` table: artist(s) via the existing graph, venue, city, date, ticket link), crawled the way the catalogue is (a seeded, deterministic, resumable sweep — the [catalogue-crawler](../catalogue-crawler.md) `crawl_frontier` shape is the precedent) from a lineup/listings source. It stands on its own too (a public `/events` or per-artist "upcoming" surface, event schema for SEO — `MusicEvent` JSON-LD), and it is what lets a watcher fire on a gig, not just a release. Scope this FIRST; the release-only watcher can ship against the existing substrate, but the operator's call is that the full concept waits on events.
- **Related-artist discovery (the "gerelateerde artiesten" half).** Watching one artist should surface the ones next to them — the discovery loop the fan named. Needs an artist-similarity edge (a Spotify/MusicBrainz related-artists pull, or a sonic-neighbour edge off the MuQ space the archive already embeds), so "watch Lenzman" can suggest "and these five you'd probably watch too." Composes with `get_similar_findings` (track-level sonic nearest already ships) lifted to the artist level.

Unscoped capture-for-later — the release-only slice is small against the existing API, but the operator-ratified shape is: **events crawler → watchers (releases + gigs) → related-artist suggestions**.

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

### Database latency — the deferred levers (Placement Hints, then the own-box)

Phase 0 of the latency work shipped (2026-07-17): the query-wave collapse (`getSimilarFindings` ranks + hydrates in one statement; the artist/label loaders fold their catalogue read into one parallel batch) and the `/log` edge cache extended to the `/artist|/album|/label/<slug>` detail pages with purge-on-write — so a cache hit crosses no ocean and the reader/SEO half of the Dublin-anchor pain is largely off the hot path. The full options analysis (six alternatives, the decision matrix, why D1/Vectorize forks the store and downgrades similarity to ANN, why the exact `vector_distance_cos` scan is load-bearing) lives in [docs/planning/turso-latency-research.md](./turso-latency-research.md). Two deferred levers remain, in order — both **earned by post-launch numbers, not pushed**:

- **Placement Hints — the free, reversible next lever.** Pin the SSR Worker to `aws:eu-west-1` (Turso's region) so a distant reader pays one ocean crossing, not one per sequential query. Config-only, one-line-reversible, **no surcharge** (available on all Workers plans; billed as normal Workers usage regardless of where the Worker runs), still Cloudflare-beta. It targets the one thing Phase 0's cache can't: the uncacheable per-user path (ChatDnB, search, recommendations) for distant readers. The move: turn it on behind a flag, measure the per-user paths, keep it if it wins. Try this before ever contemplating a migration.
- **The own-box — the endgame maximal solve (spike first).** Host the whole app on a box behind Cloudflare so the database is `localhost` (µs reads, the compounding gone, the exact vector scan on real RAM with the full corpus in-process), with the Phase 0 cache as the global-reach engine and Litestream→R2 / Turso as the backup. A strategic architecture bet, not a config flip — it trades serverless zero-ops for a single origin we own (though the ops muscle already exists in the rave boxes). The target architecture + the throwaway de-risking spike (a fresh `box.fluncle.com` VPS behind a Cloudflare Tunnel — Phase A proves the Bun / embedded-libSQL port runs end-to-end, Phase B measures the distant cold-render penalty, the number that decides it) are sketched in [docs/planning/own-box-spike.md](./own-box-spike.md). Trigger: only if post-Phase-0 (± Placement Hints) numbers prove the uncacheable per-user path is still too slow, or to de-risk the port early while traffic is low.

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

## ChatDnB — the graduation questions (user tier SHIPPED, gated; public exposure open)

The pun (ChatGPT → ChatDnB) earned its spike and the spike shipped: `/admin/chat` (#562) — a chat with Fluncle himself that answers over his own archive tools with hard tool-boundary grounding (he answers from the archive or he does not answer — the model can surface rows, never invent them), admin-gated.

**The user-tier rollout SHIPPED (gated, no announcements):** `/chat` opens the same chat to signed-in, **verified-email** accounts — the learning cohort of the gated rollout (sign-in never requires verification; features gate on `emailVerified`). One shared conversation UI (`components/chat/chat-conversation.tsx`) serves both doors; the crew door POSTs to `/api/chat` behind the full rail stack (session → verified-email → same-origin + CSRF → two per-user rate dials) and the crew menu carries the ChatDnB entry. The rate dials are the friends-phase numbers, deliberately conservative while the usage model is unknown: **30 messages/hour + 150/day, per user** (`chat.message` / `chat.message.daily` in `routes/api/chat.ts`) — raise them deliberately, not because someone hit them. The page stays unlisted: no registry entry, `noindex`, no announcement.

What remains is the PUBLIC exposure call:

- **The rec machine won the public-surface race and SHIPPED (2026-07-17, auth-gated), per the operator's sequencing ruling (2026-07-16):** every conversation costs real inference money from non-paying users, so an anonymous/public ChatDnB holds until the verified-cohort usage model is understood. When ChatDnB fully graduates, the logged-in chat gains the add-to-my-playlist tool — "add 3 more recommendations to my playlist" mutating the user's minted playlist by tools (operator, 2026-07-16).
- **Public exposure** — `/chat` is the door and it now exists; the open question is whether it ever opens past the signed-in crew (`chat.fluncle.com` remains an option; `chatdnb.com` is taken — the pun survives the URL). An anonymous tier would need its own abuse posture (IP-keyed dials, no session identity to hang a ceiling on).
- **Model choice** — a well-prompted frontier model with the hard grounding rule is the honest v1; the FluncleLLM voice fine-tune (below) is an obvious future consumer.

The spike's rails carried forward unchanged into the user tier and carry into any public version: grounding is the product, he never speaks about an uncertified track (ratified canon — the catalogue is a utility layer with no narrative voice), the surface stays a quiet plate rather than a SaaS chat window (`PRODUCT.md` bans the streaming-app clone by name), and the voice gate applies — this is him _talking_, the most exposed his voice ever gets.

## Epic — the tool tiers: align the MCP and ChatDnB, extend both to the catalogue (2026-07-18, operator-ratified)

**The realization that names it:** ChatDnB does NOT consume the MCP — they are two SEPARATE tool implementations (`mcp.ts`'s `tools[]` and `chat.ts`'s `buildChatTools()`) that both call the same in-process server functions but define their own, drifting tool sets. That is why `list_fresh` filled in the bare MCP (a real Claude-app conversation) while ChatDnB returned empty the same afternoon (2026-07-18): the MCP's `list_fresh` returns the full fresh list, ChatDnB's filters to certified findings, and the current fresh window happens to be all uncertified catalogue. Same question, two answers, because two tool sets.

The scope audit that motivated it (bare MCP, 2026-07-18): **findings-only** — `list_tracks`/`get_recent_tracks` (Recent findings), `get_random_track` (Random finding), `get_track` (Read one finding, by coordinate). **Catalogue** — only `list_fresh`. **External Spotify** — `search_tracks` actually searches SPOTIFY for submission candidates, not Fluncle at all, so the bare MCP has NO way to search the archive/catalogue (ChatDnB has `search_archive`, findings-grounded, but the MCP never exposes it). Two gaps: no archive/catalogue SEARCH on the MCP, and no catalogue BROWSE (by artist/label/album — the crawler's world `/albums`, `/labels`, `/artist` already expose on the web).

**The operator-ratified shape:**

- **One shared tool set, two transports.** Extract the tool definitions into a single source of truth both the MCP transport (`mcp.ts`) and the ChatDnB engine (`chat.ts`) consume, so they cannot drift again. MCP and ChatDnB expose the SAME tool calls. (ChatDnB adds nothing the MCP lacks; the MCP gains the archive tools ChatDnB already has.)
- **The two tiers, both surfaces carry both.** LORE/CANON tools stay findings-grounded and speak in full Fluncle voice (coordinate, note, observation) — the certified archive. CATALOGUE tools (`list_fresh`, a new archive/catalogue SEARCH, catalogue BROWSE) surface the wider DnB world in the **unlit register**: named honestly and LISTED, never NARRATED (this keeps the ratified canon — "the catalogue is a utility layer with no narrative voice" — intact; the change is that the catalogue can now be _surfaced_, not that it earns a voice).
- **The grounding boundary evolves, it does not loosen.** From "certified findings only" to "anything IN THE ARCHIVE — findings OR catalogue — rendered in the right register." Still never invents, still never speaks from outside the archive (no raw Spotify results as answers); catalogue rows are real, crawler-minted, already public on `/fresh`, so surfacing them is not hallucination.
- **Missing tools to add:** an internal archive/catalogue `search` (see the search epic below — it is the prerequisite), catalogue browse (`list_artist_catalogue` / by label / by album), and `list_fresh` into ChatDnB. Optionally a copy fallback in the interim: when ChatDnB's certified-fresh list is empty, point to `/fresh` for the wider release list.

## Epic — search goes internal: cut Spotify out of the read path (2026-07-18, operator-ratified)

Today `search_tracks` (the MCP tool + the submit-candidate flow) calls `searchTrackCandidates` → **Spotify's API**. The original reason was sound: a search result carried the Spotify URL that `submit_track` needs. But the catalogue crawler now mints catalogue rows WITH `spotify_url` (and Apple/ISRC anchors), so **the internal catalogue can serve the same search** — with two wins: it stops eating the Spotify app's rate limits (freeing them for the user paths), and it makes "search Fluncle" actually search Fluncle.

**The shape:** move every search consumer onto ONE internal catalogue search, across the board — the MCP search tool, the public `search_tracks` API op, the SSH rave terminal, the CLI, and any other surface (enumerate them first; the web CMD+K already uses the internal `search_archive`, so part of this is unifying `search_archive` + `search_tracks` into one catalogue-scoped search with a findings/catalogue register split). Spotify stays ONLY where it is genuinely irreplaceable — the actual submission/enrichment fetch of a track we do not yet hold — never in the search READ path.

**The open sub-question to settle when scoped:** coverage. Internal search only finds what we have crawled, so submitting a brand-new track not yet in the catalogue needs either a Spotify fallback for the submit-something-new case, or a submit flow that accepts a pasted Spotify URL directly (no search needed). Decide the fallback posture before cutting Spotify out of the submit path specifically; the DISCOVERY/browse read paths can go internal immediately.

**Shares a filter schema with the coming `/tracks` hub (2026-07-18).** A new root page will list ALL tracks behind a series of filters — `/tracks?bpm=170-175&era=2015&key=8A`. The search LLM tier already "emits FILTERS, never rows" (docs/search.md), so the hub and the internal catalogue search must share ONE filter schema (bpm range, era, key, …), not grow two divergent ones. When this epic lands the internal search, define the filter vocabulary once and let both the `/tracks` hub and the search read it. Awareness item, not a blocker for the tool-tiers rollout.

**Not a dependency of the tool-tiers epic (corrected 2026-07-18).** An earlier note claimed this epic gated the tool-tiers archive-search tool. The tool-tiers RFC verified LIVE that `searchArchive` is ALREADY catalogue-inclusive (the one deliberate LEFT JOIN, `certified`-tagged rows), so the MCP/ChatDnB archive-search tool ships in Epic 1 with no dependency here. This epic is only about retiring the SPOTIFY candidate search on the submit/write path and collapsing `search_archive` → the canonical `search_tracks` name.

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

## Mobile gets the Galaxy collection (backlogged 2026-07-15)

The `/account` collection home shipped on web (tabs, per-galaxy completion, cover-led rows, the `list_private_galaxy_collection` op). Maurice: "the mobile app should get a similar treatment" — web and mobile are the two real game surfaces (SSH was tried and is out). The op is mobile-ready as-is; the slice is UI only.

## The Galaxy game: deeper is the game (direction, 2026-07-15)

Ratified in play: **no refuel at logged stars** — the dry-tank pressure is what pushes players deeper. The direction riffed on top: power-ups out in the deep (bigger tanks, faster engines), star density thinning with distance so the frontier feels like a frontier, "leaving space for… other things" (Maurice's 😏 — undefined on purpose). Pairs with the ratified logged-is-collected model: the universe grows with every finding, and returning after a week means new stars, not re-collection.
