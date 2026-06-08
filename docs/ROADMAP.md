# Roadmap

Open ends we'll pick from when starting new work. Not a commitment or an order of operations — a living reference list. Add to it freely; move items into a PR when they get picked up.

> **Briefs are subordinate to the codebase.** The linked briefs (`tiktok-brief.md` and others) were brainstormed with people outside the codebase and the brand. Treat them as intent, not spec: where a brief deviates from how the code actually works or from the canon ([DESIGN.md](../DESIGN.md), [PRODUCT.md](../PRODUCT.md), [VOICE.md](../VOICE.md)), the codebase and canon win. Translate the idea into Fluncle's terms when you pick it up.

## Video pipeline → production

The social-video kit (`packages/video`) renders locally today; these turn it into a running, published surface.

- **Video agent on Spinup.** Stand up the per-track video agent as a Spinup harness, the same shape as the Friday newsletter agent (`docs/newsletter-agent.md`): a repo checkout, bun, ffmpeg, the firecrawl CLI, one trackId in, one MP4 + report out. Its constitution is the `fluncle-video` skill (`packages/skills/fluncle-video`), fetchable raw from GitHub for an agent without the repo. Publishing stays operator-controlled — the agent renders and reports; a human reviews and posts.
- **Store videos on Cloudflare R2.** A home for rendered MP4s outside git (rendered artifacts are never committed). Decide the bucket layout (keyed by trackId), access (public read vs signed), and who writes (the agent, or the operator after review). The `tracks/*.tsx` archive stays the source of truth; R2 holds the disposable build products.
- **Show videos on web as song previews.** Surface the R2 videos on fluncle.com as previews on track rows / the cover frame. Through-the-Glass and One Pane still apply; the video is a pane on the cosmos, not a hero. Mind autoplay/reduced-motion, poster frames, and that a missing video degrades gracefully to today's layout.

## TikTok auto-pipeline (the capstone)

The full vision in [docs/tiktok-brief.md](./tiktok-brief.md): "Maurice discovers bangers, Fluncle does everything else." Add a track via `ssh rave.fluncle.com`, and the system resolves metadata, resolves a legal preview, analyzes the audio, renders a 9:16 video, writes a caption, and pushes a TikTok **draft** — fully automatic. The only human steps stay manual on purpose: attach the official TikTok sound (the pipeline suggests the start offset from the drop analysis), then publish. That keeps all music licensing inside TikTok's ecosystem — preview audio is for analysis only, never uploaded.

The three video items above are the front half of this pipeline already in motion; the brief is where they're headed. What the capstone adds beyond them:

- **Pipeline orchestration + status lifecycle.** A per-track state machine (`queued → preview_resolved → analyzed → rendering → rendered → draft_pushed → awaiting_publish → posted_verified`, plus `needs_review / stale_draft / failed`) and the `social_posts` storage to back it. Triggered from a track being added, not a manual agent run.
- **Caption + public marker generation.** Captions in Fluncle's voice (VOICE.md) with artist/track/Spotify link/hashtags; the post carries the discovery's **canonical log identifier** (see the logbook section below) as both an on-screen/caption marker and the key for publication reconciliation. This replaces the brief's bespoke `rave://7F3A` / `transmission FLN-...` markers — there is one identity per discovery, used everywhere.
- **TikTok Content Posting API integration.** A TikTok developer app, OAuth for `@fluncle`, draft upload (video + caption, no music, no publish), and the token storage that needs (`TIKTOK_CLIENT_ID/SECRET`, access + refresh tokens).
- **Reconciliation agent.** An hourly check that matches recent TikTok posts to public markers and flips `social_post.status` to `posted_verified` with the live URL — so publication state is observed, not hand-tracked.
- **Text overlays from verified facts.** Artist / track / year burned into the render (label/genre optional), reusing the video kit's facts-with-sources discipline.

Explicitly out of scope for V1 (per the brief): automatic publishing, Instagram, YouTube Shorts, performance/engagement analytics. The one human action stays: choose song, attach official sound, press publish.

## The logbook — Fluncle as a traveler's archive

The largest item, the one the others point at. The full vision in [docs/narrative-brief.md](./narrative-brief.md): Fluncle is a cosmonaut keeping a logbook; every discovery is a **log entry** with a permanent, surface-independent identity; the banger is the artifact attached to an observation. **Chosen direction: a co-equal reframe** — the log becomes as central as the music, not a cosmetic layer. That means real canon surgery (PRODUCT.md, VOICE.md, DESIGN.md all get edits), not a bolt-on. The music-first product and the warm uncle don't get deleted; they get a second, equally-weighted axis — the journey — built alongside them.

**The spine — one canonical identifier per discovery.** The load-bearing primitive: `fluncle://<id>` is the true identity of a discovery, and every surface is just a representation of it.

```
fluncle://241.7.3A
  ├─ https://fluncle.com/log/241.7.3A     (web: a log page, not a row)
  ├─ on-screen overlay + caption           (TikTok)
  ├─ <guid>fluncle://241.7.3A</guid>       (RSS: the observation feed)
  ├─ fluncle log 241.7.3A                  (CLI)
  ├─ ssh rave.fluncle.com 241.7.3A         (SSH: the recovered terminal)
  └─ social_post reconciliation key        (TikTok pipeline, above)
```

- This **subsumes the TikTok capstone's marker** — there is one identity per discovery, doing the trail and the reconciliation at once. No separate `rave://` scheme.
- **Identifier design.** Derive it deterministically from real facts (e.g. discovery date + a sequence + a check character) so it reads "recovered, not generated" but stays reconstructable and reconcilable — better than a random code, and the date/coordinate/stardate ambiguity comes for free. Opaque to users, meaningful to the system. The exact `241.7.3A` shape and what it encodes is a design decision to settle when picked up.
- **New surfaces it implies:** `/log/<id>` pages on the web (the log as the object: observation, recovered artifact, related logs), RSS as the observation feed, and possibly Discord. The website becomes an archive you browse, not only a feed you scroll.

**The canon surgery (codebase + canon still arbitrate the words).** A co-equal reframe edits the canon; it does not let the brief overrule it. When this is picked up:

- **PRODUCT.md** — evolve the thesis so the log/observation is a primary object and the banger is its artifact, while keeping publishing operator-controlled, music-first, and Fluncle's Findings intact. The journey and the music are co-equal, not one over the other.
- **VOICE.md** — formalize the logbook register as the deep end of the existing **Depth Gradient**: SSH / the archive / RSS speak as a "recovered terminal from a research vessel" (exploratory, scientific, a little lonely), while the warm bruv uncle still holds the surface (web, Telegram, email). Metabolize the brief's vocabulary through the existing ban list: **"transmission" and "signal" stay out**; adopt **log, observation, discovery, archive, recovered, artifact, sector**. "Banger" stays the primary word — the log frames the banger, never demotes it.
- **DESIGN.md** — a log page and archive view as new panes on the cosmos (Through-the-Glass, One Pane still apply); the identifier rendered as a typographic object (Oxanium, tabular, the instrument-panel calm).

## Brand & web

- **Website overhaul from the moodboard.** Revisit fluncle.com against `packages/video/moodboard/MOODBOARD.md` — the texture families, the Retint Rule, the first-party collages, the One-Sun stage-light grammar. The video kit has pushed the visual language well past where the web currently sits; pull the web up to match (within DESIGN.md's rules — this is evolution, not a second system).
- **Audit moodboard → canon docs.** Review whether anything proven out in the moodboard and the video kit (texture families, the Retint Rule, vehicle grammar, the One-Sun-through-the-vehicle clarification) should be promoted into [DESIGN.md](../DESIGN.md), [PRODUCT.md](../PRODUCT.md), or [VOICE.md](../VOICE.md) — or stay video-local. The risk to weigh: keeping doctrine in one place vs. bloating the canon with things only the video surface needs. Decide per concept; cross-link rather than duplicate.
  - **Includes the logbook reframe.** The co-equal reframe above is the heaviest canon decision on the list: PRODUCT.md gains a co-primary "log/observation" thesis, VOICE.md formalizes the logbook register as the deep end of the Depth Gradient (and re-skins the narrative brief's vocabulary through the ban list — "transmission"/"signal" out, log/observation/discovery/archive/sector in), and DESIGN.md gains the log-page/archive panes. Resolve these as part of this audit, not piecemeal per feature.
