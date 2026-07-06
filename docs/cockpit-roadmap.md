# The Cockpit — the roadmap

Status: Final (forge-passed: 3 research threads, taste pass, 3-role adversarial panel). Planning, not canon; where it conflicts with the codebase or DESIGN.md/VOICE.md, those win. Decisions for the operator are at the end.

The Cockpit (today: "Fluncle's Helm", `apps/helm`) is the operator's workflow app: a local Bun daemon (`:4190`) plus a native shim window on the M5 and the M2, holding admin authority server-side (the CLI's stored credentials, in-process) and local tools (`ffmpeg`, the Rekordbox scripts, the visuals orchestrator) at arm's reach. Three stations exist (Show, Set lifecycle, Pulse).

## What the panel changed (read this first)

The draft planned a full strangler: port every web /admin surface into the Cockpit, then shrink web /admin to one card. The panel refuted the port-everything half with two findings the plan now follows:

1. **Porting pure CRUD buys nothing and costs resilience.** Tag, plan-editing, the board dialogs are the same @fluncle/ui React in a browser tab or a WKWebView, on the same machine. Moving them creates the two-surface tax and migrates the whole admin capability onto a bespoke local stack (which already needed one macOS workaround) while deleting the always-up Cloudflare fallback.
2. **"Retire everything" would have broken production.** The "web admin" contract ops have live headless callers — the Instagram drip cron (`drip_clips`), the newsletter cron, the Rekordbox scripts, the box clip-sweep, and the Cockpit itself. UI routes and contract ops are different retirement classes.

**The amended shape: the Cockpit owns what a browser cannot — the attention queue and local-tool custody. Web /admin CRUD stays, reached through the queue's deep-links, and web /admin survives as the durable break-glass admin. Ports happen later, on felt pain, one station at a time, each PR deleting its web counterpart at parity (never a terminal shrink phase).**

## The operating principle

The operator's real problem is context: many small manual actions across two machines and several days, and keeping the state machine in his head is the tax. The Cockpit's job is to BE the context. One system at three zooms:

- **The queue** (home — state zoom): every action the system needs, as a row. Zero rows is the success state.
- **The loop** (source zoom): entering a queue group becomes its focused single-key loop — the tag matrix, the posting row. Tag/Posting/Renders are not stations; they are the queue's drill-ins.
- **The workbench** (object zoom): Show, Set lifecycle, Studio-lane, Plans-lane — surfaces you visit with an object in mind.

The palette and the finding inspector are lenses over the same three zooms, not additional systems. Home is the queue; the palette is the accelerator.

## The design doctrine

Real workflow software, not a fiction surface. Register: product, not brand.

**The naming law (ratified 2026-07-06): canon lives where the crew looks; tools speak plainly.** Public surfaces carry the fiction; internal tooling uses functional names. **Amended by the taste pass: rename the face, keep the plumbing.** Visible strings say Cockpit / the visuals / start / stop (window title, tray, Dock, docs, `fluncle cockpit` as the CLI verb, every UI string including the pre-flight's narration lines); internal identifiers (`com.fluncle.helm`, `helm.key`, `helm://`, `apps/helm`, `packages/live/src/glass`, env vars) keep their names — invisible to the operator, and renaming them bought four migration hazards for zero tax relief. The word is **recording**, not "take" (the schema's word; the law cuts both ways). DESIGN.md's doctrine uses of "glass" (the Through-the-Glass Rule) are web-canon, not the renderer — excluded. The rename is its own zero-feature PR, landed after the queue ships, never coupled to a feature.

- **Everything is an action.** Verb + object: "Post to TikTok", "Add to tracklist", "Create clip", "Derive cues", "Start visuals". If an element is not an action, a datum, or artwork, it does not ship.
- **No narration.** The preserved counter-example: "The oldest dressed finding still off TikTok. Post it by hand. The caption never survives the inbox, so it's here to copy." The replacement is a row: cover, `IYRE — Glowing Embers`, `020.2.3Y`, `17d`, [Copy caption] [Copy video URL] [Mark posted].
- **Dense instrument.** Tabular rows; small tight type; minimal padding; a surface visible without scrolling. Anchors: Raycast, Linear.
- **Keyboard-first.** Single-key loops in the queue; every row focusable; the palette reaches everything.
- **The visual warmth is the music's.** Cover art and posters are the only images; gold marks actions and selection, never status.
- **Numbers behave.** Oxanium `tabular-nums` everywhere; nothing jitters.
- **States, not spinners.** Inline default/running/done/failed; long runs stream into the run drawer; empty states are a fact plus an action.
- **Motion conveys state only** — with one sanctioned exception: **the zero state may celebrate.** The three mandated delight moments: (1) the zero-state reward — the last cover cleared, warmly lit, one word (`clear`), a 200ms settle; (2) tactile action-fire — gold flash, the row completing, an optional soft tick (muteable, reduced-motion-gated); (3) music scores the work — preview audio auto-plays in the tag loop and the posting row. Zero prose, pure Fluncle.

## The queue (home)

Mechanics (proven Linear/Superhuman shapes, trimmed to one operator):

- Single-key primary action per row, **auto-advancing**.
- **Two-tier ordering**, not per-source curves: deadline rows by time-to-deadline, everything else oldest-first. (The curve framework was speculative generality for exactly one deadline source.)
- **Snooze until time** (plain); **"Won't do"** as a distinct, undoable, permanent dismissal — without it, deliberately-ignored rows make the queue a guilt list.
- **A bounded working set**: due-today/top-N counts toward zero; older rows age into a cold backlog visible on demand. Zero stays winnable.
- **One daily digest nudge** ("4 waiting, oldest 17d"); only true deadlines (the TikTok bounce) earn an individual push. A notification IS its action: it opens the Cockpit at the row.
- **Trust rule**: never surface a row the daemon cannot confirm is actionable (inherit the posting gatherer's conservatism). One false row kills the queue.

The sources (data-honesty verified):

| Source                                           | State today                                                                                                                                                                                                                                                                              | Verdict               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Untagged findings                                | `listTracks({placement:"unplaced"})` + count                                                                                                                                                                                                                                             | EXISTS                |
| Unposted to TikTok                               | `social_posts`; Pulse computes it today                                                                                                                                                                                                                                                  | EXISTS                |
| Recordings without cues                          | `hasVideo && tracklist.length===0` off `list_recordings`                                                                                                                                                                                                                                 | EXISTS                |
| Promoted, undistributed                          | `mixtapes.status='distributing'` + null social URLs                                                                                                                                                                                                                                      | EXISTS                |
| TikTok draft stale (24h bounce)                  | draft rows carry push time; deadline math is new; the current freshness logic counts a draft as "gone out" — fix both                                                                                                                                                                    | PARTIAL — small build |
| Unreviewed renders (renamed from "taste review") | No verdict state exists; the LLM taste judge was prototyped and dropped. Honest options: `finalize_track_video` (agent-tier, the box's natural last POST) also writes a `gate.advisories[]` summary, or a `video_reviewed_at` column + an operator [Mark reviewed]. Phase 2, either way. | NEEDS NEW STATE       |
| Drip queue empty                                 | `list_clip_posts` + pending counts                                                                                                                                                                                                                                                       | EXISTS                |

Rows for sources whose actions are not yet native **deep-link to the web /admin surface** — the queue routes; the operator never has to remember which world a task lives in.

## The workbenches

### Show (exists; M5)

- Picker → [Start visuals]; the pre-flight checklist ([clear]/[hold] are real machine output); [Depart anyway]; [Stop]. OBS stays out (decided). Links: the visuals page, the phone remote. `packages/live` internals and the `show` script are rename-excluded (the Cockpit walks up to them by path).

### Set lifecycle (exists; grows the local-tool wins)

- Capture (M5): ~/Movies scan → [Upload as recording]. **At upload, a spawned streamed run** executes `analyze-set` (first-time staging — it exists as code but was never staged to R2 for anything; its envelope already contains `peaks[]`, so the separate audiowaveform binary is dropped) and uploads `recordings/<id>/studio-envelope.json` via a **net-new agent-tier arbitrary-key presign op** (the current recording presign is multipart-only with a hardcoded key); `promote_recording` copies the artifact forward to the mixtape's key.
- Cues (M2): [Derive cues] → preview → [Attach]. [Export to Rekordbox] lives HERE (it already exists in this station; the draft's Plans-station copy was an ownership overlap — resolved to one owner).
- The shelf: plan / recording / promoted lanes; [Promote to mixtape]; [Distribute] (M5); **[Announce]** — new plumbing (one operator-tier op: the Telegram crew announcement; nothing mixtape-shaped exists today); [Render set video] — a local streamed run of the operator's GPU job.

### The Studio lane (the local-ffmpeg win, cut to what earns the move)

- **[Create clip], locally**: the one existing recipe `clipCutFfmpegArgs` — extracted to **@fluncle/contracts** (dep-light, already shared by CLI and Cockpit; the box needs no import, it runs the compiled CLI) — cuts in seconds against the local or R2-cached master; the clip plays inline; [Re-cut]. This kills the hidden out-of-band CLI render step in today's flow.
- The cue rail renders against the upload-time envelope (wavesurfer v7 Regions for in/out handles).
- The clip library's drip controls (kill switch, schedule) stay web for now, deep-linked; they move only if felt pain says so — and no further web-side drip UI gets built either way.
- [Caption clip] does not ship (decided): clips go out clean per the standing decision; captions belong to the platform post.
- Publish-as-mixtape, the promoted-mixtape block, resync-from-cues: stay web, deep-linked. Port on felt pain.

### Plans, Tag, the finding inspector, Newsletter

- Stay web, deep-linked from the queue. If daily use later argues for a port, each port PR deletes its web counterpart at parity, and the tag loop ships as the queue's drill-in first (one component, three doors: the loop, the inspector action, the palette).

## The posting cards (two rituals, two cards)

- **The desk push** (Cockpit posting row): [Copy caption] [Push TikTok draft] [Open post asset] [Mark failed] — the web Push dialog's capabilities, with the 5-drafts-per-24h warning.
- **The phone finish** (web, always-up, deliberately mobile — the one admin surface designed for the phone): the draft is already in the TikTok inbox; the card carries caption-copy, **the official-sound search string** (title + artist), cover-save to camera roll, and **a URL-paste field + [Mark posted]** (the flow requires the real share URL). This card is the web /admin end-state's centerpiece and never leaves the web.

## The machine model

State lives in the Worker; both Cockpits read/write the same truth through the admin API. Machine-bound assets (recordings in ~/Movies, master.db) badge their actions, server-enforced. Heavy files move through R2.

## The permanent API (what never retires)

UI routes and contract ops retire separately. The admin/agent contract ops with headless callers survive regardless of any UI decision — among them: `drip_clips` (the drip cron), the newsletter ops (the Friday cron), the clip-cut chain (the box sweep + CLI), the recordings/cues ops (Rekordbox scripts + the Cockpit), the track enrichment ops (the box crons + skills). The four OAuth start/callback pairs (Spotify login AND API, YouTube, Mixcloud) + logout are permanent plumbing — the only way to mint provider tokens. The Spotify callback multiplexes admin-login with API reconnect; neither purpose may be deleted.

## The frame decision

The Swift shim stays (517 lines, tray + Dock + WKWebView + custody + the `helm://` loopback proxy). Tauri v2 is the named successor — its webview layer ships the custom-protocol plumbing the shim hand-rolled — triggered only by recurring proxy/window maintenance tax or a real mobile target. Electron never; full native Swift structurally wrong.

## Sequencing (inverted by the panel: value first, churn last)

- **Phase 1 — The queue + the mixtape-day wins.** The attention queue as home (the five EXISTS sources; two-tier order; snooze/won't-do; bounded working set; digest nudge; the zero-state reward; deep-links for everything non-native). The local clip-cut (@fluncle/contracts extraction). The [Announce] op. Upload-time envelope staging (the new presign op + spawned analyze-set). The stale-draft fix. **Then stop and see what's actually still wanted.**
- **Phase 2 — Names + the second ring, on felt pain.** The face-only rename as its own zero-feature PR (visible strings; counts corrected: the raw radius was ~888 sites, which is exactly why the plumbing keeps its names). The unreviewed-renders source (pick the honest write-back). The palette (the vendored cmdk primitive; actions + objects, Linear's scoping law) — deferred here because station tabs + the queue already reach everything for one operator. The tag loop as the first drill-in port if tagging friction persists.
- **Phase 3+ — Ports on felt pain only.** Each port PR deletes its web counterpart at parity. No terminal shrink phase exists; web /admin converges naturally toward the finish card + OAuth plumbing + whatever never earned a port.

Each phase ships complete: implementation, tests, docs, product review, and the doctrine check that no narration crept in.

## Decisions before handoff (operator)

1. **The direction amendment** — the panel's strongest recommendation, adopted in this Final: the Cockpit is additive (queue + local tools), web /admin CRUD survives as break-glass, ports happen on felt pain instead of by program. This softens the ratified "remove it entirely from the web app." Confirm or override.
2. **Phase 1 as scoped** — the queue + local clip-cut + announce + envelope staging, nothing else. Confirm.
3. **[Caption clip] stays unshipped** (clips go out clean) — confirm.
4. **The face-only rename** (Cockpit/visuals on every visible string; plumbing keeps helm/glass identifiers) — confirm, or order the full 888-site sweep knowing its cost.
