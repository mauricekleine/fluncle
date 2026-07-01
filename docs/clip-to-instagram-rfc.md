# RFC: Set-cut clips → Instagram — credited, real-audio Reels from a live DJ set

**Status:** Final (research → /taste → 4-role adversarial panel synthesized, 2026-07-01) — completeness standard applied.
**For:** a fresh build session / a team of agents.
**Canon/authority:** the codebase + `docs/fluncle-studio.md`, `docs/video-variants.md`, `packages/skills/{fluncle-mixtapes,fluncle-publish,copywriting-fluncle}`, `AGENTS.md`/`DESIGN.md`/`VOICE.md`/`PRODUCT.md`. Planning, not spec.

> Process note: four divergent research threads, a /taste pass, and a 4-role adversarial panel (staff-engineer, platform specialist, design/voice canon, taste/scope) that verified claims live. Their corrections are baked in — the panel **overturned two premises** (the "manual in-app tap"; the `-map …?` fallback), **cut three speculative units**, and **resolved every code-fact**. Live verifications + 2026 sources in the appendix.

## The standard (definition of done)

Honest shape: this is **not one atomic delivery** — packaging it as one was the draft's taste failure. It is three separable efforts: **(a)** a standalone correctness fix (the mic-leak — ship today, needs no RFC); **(b)** one external-dependency **spike** that gates everything IG (does Fluncle's blended mix survive IG's fingerprinting); **(c)** the credited-clip product (the real RFC). Within (c) every unit ships complete, tests + docs included. The only sanctioned "not now": the spike outcome (Meta's behaviour, not ours) and — genuinely contingent on a _surprising_ spike pass — the Remotion cosmos tier and any second platform, which become their own RFCs. Dangling threads this ties off: the disabled `/admin/clips` "Distribute" seam, the stale spine-model doc, the `cron.studio-clip` registry gap.

## 0. Summary / the reframe

- **The hero:** real footage of Fluncle mixing, his **own blended mix baked in**, with a changing on-screen **Track-ID lower-third** that answers DnB's #1 comment ("TRACK ID?") as each blend transitions — posted to Instagram (the 6th channel).
- **The unifying insight is AUDIO PROVENANCE, not coupling.** The clip carries _Fluncle's own DJ-mix master_ — the same recording that already survives as a _mix_ on YouTube/Mixcloud — not a licensed commercial single. That one distinction is the entire reason clip→IG can be a pipeline where finding→IG cannot, and why the finding path stays excluded. "Inherits mixtape machinery" is a _reuse_ argument, not a reason to ship everything as one unit.
- **The panel overturned the entry premise: there is no manual in-app tap.** IG's fingerprinting is **path-independent** (app vs API) for _baked_ audio; in-app posting uniquely enables only _licensed-library_ audio, which we reject. So IG posting is a fully-automated Graph `media_publish` (the repo's own `postiz.ts:12-15` already assumes this), with an operator **approval** gate for account-strike safety — _not_ a manual post. Both spike branches are tap-free.
- **~90% of the primitives already exist** — the cut (Unit C), the cue field `mixtape_tracks.start_ms` + its write path + YouTube-chapters/Mixcloud-sections/`/log` rendering, the voice-correct `buildCaption`, the guarded-flip social-posts pattern, the operator-gate pattern. New work: the Studio **cue-marking UX**, the **blend-aware resolver**, the **canon-styled changing-ID overlay**, and a thin **IG-publish leg**.
- **Decomposition.** Truly coupled: cue-marking → resolver → changing-ID overlay (+ its caption). Loosely coupled (via the clip row): the IG-publish leg. Independent + first: the spike. Standalone prereq: the mic-leak fix. Cut to future RFCs: the Remotion cosmos tier, a dedicated `mixtape_clip_social_posts` table, any second platform.

## 1. Context & goals

The Studio already cuts vertical clips from a set's `set.mp4` on R2; they go nowhere (cut-and-download only, a disabled "Distribute" seam). **Goal:** post _credited, real-audio_ set-cuts to Instagram, crediting auto-derived from cue marks, each answering "TRACK ID?" on-screen. **Honest horizon:** the spike (Unit 0) gates whether IG-for-set-cuts is viable at all, and the informed prior is _negative_ (below); reach is a weeks-out outcome, never a ship gate.

## 2. Unit 0 — the audio-survival spike (FIRST; gates all IG work)

**The prior is negative, not 50/50.** 2026 sources are explicit that Meta's fingerprinting reliably catches **tempo-matched, segmented, pitch/speed-altered** catalog audio — a DJ blend is squarely in that transform class. Treat a pass as a _long shot_, and size all downstream IG investment as contingent on a surprising pass.

**The spike (operator-run; provision an IG Business token FIRST):** cut one real ~30–60s blend clip (Unit 1 must land first so it's mic-free), then post the **same file two ways** — via Graph `media_publish` **and** in-app — and compare. Query `copyright_check_status` on the API container _before_ publishing and record whether it predicts the outcome. Measure **three** outcomes, not two: **survives / muted / blocked-with-strike**, and watch account standing. The **API arm is the main event** (it's the real architecture in the survive branch), not an optional extra — the point is to confirm there's no app-vs-API gap for baked audio.

**Branches:** survives-clean → the automated, approval-gated `media_publish` pipeline (Units 4–5). Muted/blocked → **IG-for-set-cuts is dead**; pivot is a separate RFC (e.g. silent set-cut + in-app library audio, or IG deprioritized). **Do not build Unit 5 or the overlay's distribution wiring until this clears.**

## 3. Prerequisite (standalone PR, not part of this RFC's design) — the mic-leak fix

**Bug (verified):** `renditionFfmpegArgs` (`apps/cli/src/commands/mixtape-set-video.ts:115`) and `clipCutFfmpegArgs` (`apps/cli/src/commands/clips.ts:137`) pass no `-map`, so ffmpeg's default selection can bake **Track 1 = mix + MIC** instead of **Track 2 = clean mix** (`fluncle-mixtapes` §A).

**Fix (corrected — the draft's version shipped silent clips):** apply the map **only at the rendition stage**: `-map 0:v:0 -map 0:a:1`. **`?` is NOT a fallback** — it drops the stream if absent — so either require a two-track master contractually or `ffprobe` the stream count and choose the map. **The clip cut stays on default/`-map 0:a:0`** against the already-clean single-track `set.mp4` — never `0:a:1?` there (`set.mp4` has one audio stream; `?` would drop it → silent Reels). Tests: assert the rendition map + that a cut clip **has an audio stream**. Ship today; the rest of the RFC assumes a clean `set.mp4`.

## 4. The credited-clip product (the coupled cluster)

### 4a — Cue-marking UX (the Studio gains a cue rail)

Reuse `mixtape_tracks.start_ms` (nullable; **no schema change**). In `studio.$logId.tsx`, render the ordered members as a cue rail beside `StudioEnergyLane`; scrub (the `<Video>` clock exposes playhead ms), **snap to the nearest `StudioPeak` drop**, mark "track N starts here." **Persist via the existing `set_mixtape_cues` op — but it is ALL-OR-NOTHING full-replace:** it throws `member_set_changed` unless the request carries exactly one cue per current member, and unmarked members default to 0 → `cue_not_monotonic`. So the UX **accumulates all cues client-side and PUTs the complete monotonic set, persisting only once every track is marked** (enforce first-cue-0 + strictly-increasing client-side too). Fix the stale `packages/skills/fluncle-mixtapes/references/spine-model.md` (it still claims cues aren't captured). **Decision #4:** accept mark-all-then-save, or add an incremental server path.

### 4b — The resolver (the one genuinely-new algorithm; pure, unit-tested)

Beside `mixtape-chapters.ts`: given ordered cued members `m[i]` (invariant `m[0]=0`, strictly increasing; member `i` owns half-open `[start[i], start[i+1])`, last → `setDuration`) and a clip window `[inMs, outMs)`, return every member with `start[i] < outMs && start[i+1] > inMs`, **in tracklist order**. Length 1 → single-track credit; ≥2 → blend (window straddles a boundary) → credit all; "dominant track" (largest window fraction) when one label is needed. **Coverage is binary, not partial:** because `set_mixtape_cues` is all-or-nothing, a mixtape is either fully cued or entirely uncued — so the only fallback is _no cues → the mixtape-level static credit_. Encode: clamp before-first/after-last, half-open boundary disambiguation.

### 4c — The changing-ID overlay: CANON-STYLED drawtext (Phase A)

Per-cue `drawtext` window gated by `enable='between(t,<startRel>,<endRel>)'` (`startRel = cueStartMs − inMs`, clamped `[0,dur]`), reusing `escapeDrawtextValue` (handles `:`/`,`; the em dash needs none). **Not a hard scrim box** — a default white-on-`#000` box is the generic screen-grab look DESIGN.md is defined against, and `#000` violates the Warm Dark Rule. **Canon-styled, still zero new infra:** `fontfile=` self-hosted **Oxanium**; `fontcolor=` **starlight-cream `#f4ead7`**; a **warm-dark translucent** ground (sleeve-black/deep-field at tuned alpha) or `box=0` + `borderw`/`shadowcolor` ink-halo; **Eclipse Gold** on ≤1 lit element within the ~10% One-Sun budget; low grain **under** the type. **Legibility (Legible Sky Rule):** a fixed-alpha pane can't guarantee AA (4.5:1) on a white-strobe frame — the pane must be opaque enough for the clip's _brightest_ frame; the true on-footage AA solution is the radio caption's **`difference`-blend** (adopt it in Phase B). On-box ffmpeg only — **MT can't cut** (input >100 MB ceiling, centre-only crop; verified `docs/video-variants.md:73-74`).

### 4d — The auto-caption

Generalize `buildCaption` (`packages/video/src/pipeline/caption.ts`): the **metadata block stays deterministic** (`Artist — Title (Year)` — the one sanctioned em dash; the Dry Rule, no `!`; `#dnb #drumnbass #drumandbass`), stored clean in `mixtape_clips.caption`. The **opener is voiced** — a track-count _rotation cannot hold the voice_ (Oof/Reality/Selector all need the actual track). Route it through the **voice-gated `claude -p` note path** (the note-agent precedent — voiced prose on a cron _is_ established canon) or, preferred, **reuse the finding's already-authored `note`** (deterministic at caption time, zero new agent calls, already voice-gated). The opener carries the Selector's three beats (hit → pass → address). Log ID format is `XXX.F.ZZ` (mixtape `F`-marked). Blend = "A into B". Emoji is Telegram-only — keep it out of IG captions unless canon extends it (Decision).

Examples (canon-corrected):

```
Sub Focus dropped Timewarp in the mix and my knees went before I clocked it. Pulled it for you, fam.

Sub Focus — Timewarp
RAM Records

From the mix: fluncle://025.F.1A

#dnb #drumnbass #drumandbass
```

```
Rockwell slid Detached under Alix Perez and the floor lost the plot. Both of them, for the crew.

Rockwell — Detached
into
Alix Perez — Numbers

From the mix: fluncle://025.F.1A

#dnb #drumnbass #drumandbass
```

## 5. The IG-publish leg (loosely coupled; gated on a Unit 0 pass)

If the spike passes, IG posting is **fully automated** — a `pushInstagramReel` adapter, sibling of `pushYouTubeShort` in `apps/web/src/lib/server/postiz.ts`: Graph **v22.0** container→publish (`media_type=REELS`), **gated on `copyright_check_status`** (only `media_publish` when the container reports clean → strike safety), and the **permalink comes from the returned media id** (`GET /{media-id}?fields=permalink`) — **no fuzzy newest-match, no capture cron.** (The draft's "IG branch on the existing `fluncle-social-capture` cron" is a category error: that cron polls **Postiz `/missing`** for **findings** in the `social_posts` table; IG clips never go through Postiz's inbox.)

**Operator approval gate (account-safety, not a manual post):** given the negative prior, the staged clip + caption surface in `/admin/clips`; the operator **approves**, and the op publishes via the API. **State = columns on `mixtape_clips`** (`ig_status` enum `["none","approved","posted","failed"]`, `ig_permalink`, `ig_posted_at`) — **not a new table yet** (single platform, automated; extract the schema-pre-blessed `mixtape_clip_social_posts` only when a second platform lands). **Auth tiers pinned:** the approve/publish op is **operator**-tier (contract op → passes `orpc-admin-coverage`); no agent capture leg. **Rename to avoid collision:** "staged" already means the set-video rendition — call these `approve_clip_post` / `publish_clip`. Wire the disabled `clip-card.tsx` Distribute seam into the approve/status affordance. **Decision #3:** IG Login (professional, no FB Page) vs FB Login (needs a Page) + the `instagram_business_content_publish` App Review (only worth it on a spike pass; capture-only needs just `instagram_business_basic`).

## Sequencing & ownership

**Day one, RFC-free:** the mic-leak fix (§3) — pure correctness, blocks nothing.
**First + gating:** Unit 0 spike (operator; token first) — the single biggest de-risk; run the **API arm**.
**The coupled cluster (build regardless of spike; it's the product):** 4a → 4b → 4c + 4d. **The changing-ID is the MVP** — a plain static-credit clip is undifferentiated, and reach on it wouldn't predict reach on the hero, so plain clips are _only_ spike fodder, not a shipped product.
**Conditional on a spike pass:** Unit 5 (the publish leg), then — a _future RFC_ — the Remotion-over-footage cosmos tier (`difference`-blend on-footage IDs).
**Deploy discipline:** box scripts (`clips.ts` cut, the `fluncle-studio-clip` cron) ship via `docker cp` + the pin loop; each unit its own PR with oRPC coverage. Register `cron.studio-clip` (`weights:{status:"hidden"}`, `cron.render` precedent).

## Decisions needed BEFORE handoff

1. **Spike outcome** (Maurice; token first) — does the blend survive `media_publish`? Gates all IG work. Expect a likely "caught."
2. **Account-safety gate** — operator-approval-before-publish (recommended given the negative prior + strike risk)?
3. **IG auth path** — IG Login vs FB Login; pursue the `content_publish` App Review only on a spike pass.
4. **Cue-marking** — add an incremental `set_mixtape_cues` path, or accept mark-all-then-save (the all-or-nothing PUT)?
5. **Caption opener** — reuse the finding's authored `note` (recommended) vs a fresh voice-gated `claude -p`.
6. **If IG dies** (likely) — the pivot is a separate decision/RFC; don't pre-build for it.

## Acceptance criteria

- **§3:** rendition asserts `-map 0:v:0 -map 0:a:1` (+ stream-count guard); a cut clip **has an audio stream** (test); the clip cut does **not** use `0:a:1?`.
- **4a:** cue rail marks + PUTs the complete monotonic set via `set_mixtape_cues`; client guards mirror the server; spine-model doc updated.
- **4b:** resolver pure-unit-tested — single / blend / boundary / before-first / after-last / none-cued-fallback.
- **4c:** per-cue drawtext windows render (ffmpeg-free arg test like `clips.test.ts`); overlay is Oxanium + starlight-cream + warm-dark ground (no `#000` box), gold ≤ One-Sun budget, AA against the clip's brightest frame.
- **4d:** `buildCaption` clip variant unit-tested (1-track + blend), opener voiced (not rotated), valid `XXX.F.ZZ` Log ID, no `!`, single em dash.
- **§5 (on pass):** `pushInstagramReel` gated on `copyright_check_status`; permalink from the returned media id; `mixtape_clips` columns (no new table); approve/publish op operator-tier with contract-coverage + auth-tier tests; Distribute seam live.
- **Docs:** `docs/fluncle-studio.md` distribution section; `docs/socials/README.md` clip→IG row; spine-model fix; a clip→IG runbook (in `fluncle-mixtapes` or `fluncle-publish`); `cron.studio-clip` registered.
- **Weeks-out (NOT a gate):** reach/engagement.

## Risks & open questions

- **The negative prior dominates:** most likely the blend is caught → IG-for-set-cuts may simply be non-viable. Do **not** over-build; the Remotion tier and any second platform are contingent on a surprising pass.
- **Account strikes** on a business account (worse than muting) — the `copyright_check_status` gate + operator approval mitigate but don't eliminate; measure account standing in the spike.
- **The `-map` footgun** — the single most likely builder error (silent clips); the fix is rendition-only, `?`-is-not-a-fallback.
- **`set_mixtape_cues` all-or-nothing** — the cue UX must PUT the full set (Decision #4).
- **Phase B (Remotion-over-footage)** is a genuine future RFC — first video-base-layer pattern in `packages/video`, `<OffthreadVideo>` decoding a ~1.5 GB R2 source, GPU render box; not this build.

## Appendix — verifications & sources

**Live code (staff-eng, verified):** table names `mixtape_social_posts` (`schema.ts:633`) vs findings' `social_posts` (`:574`); cron `fluncle-social-capture` (`registry:795`, polls Postiz `/missing`) vs cut cron `fluncle-studio-clip`/`clip-sweep`; `mixtape_tracks.start_ms:700`; `set_mixtape_cues` all-or-nothing (`mixtapes.ts:424-465`); `-map` absent in both ffmpeg builders (`clips.ts:137`, `mixtape-set-video.ts:115`); MT limits (`video-variants.md:73-74`); the guarded-flip (`mixtape-social.ts:63-125`); `buildCaption`/`escapeDrawtextValue`; the pre-blessed `mixtape_clip_social_posts` schema comment (`:720`); the disabled Distribute seam (`clip-card.tsx`). (Thread A's `fluncle-l`/`ln`/`l-sweep.sh` were an output-redaction artifact — fiction.)

**Platform (2026, cited):** Graph v22.0 Reels container→publish; 100/24h (immaterial); no API library audio, baked audio muted-or-**blocked** on business accounts; fingerprinting **path-independent** + catches tempo-matched/segmented/altered catalog audio; `copyright_check_status` container pre-check exists (fidelity unverified — best-effort); permalink via the returned media id / `GET /{ig-user-id}/media`; **Postiz has no IG inbox/handoff** (direct `media_publish` only). Sources: Meta Copyright Detection + Content Publishing + IG Media reference; Postproxy Reels API 2026; Zernio Graph API 2026; Foxi / Last Play Distro 2026 copyright; Postiz IG docs. (Full URLs in the thread-A/thread-C research outputs.)

**Canon (design/voice):** Warm Dark, Through-the-Glass, One Voice (Oxanium), Legible Sky (`difference`-blend for text over full-bleed footage), One-Sun budget, grain-under-type (DESIGN.md); the voice stack, Dry/Found rules, Log ID `XXX.F.ZZ`, the sole-em-dash rule, emoji-Telegram-only, the note-agent voiced-`claude -p` precedent (VOICE.md + `docs/agents/note-agent.md`).
