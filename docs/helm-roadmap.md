# Fluncle's Helm — the roadmap

Status: Draft for the forge pass. This is planning, not canon (AGENTS.md doc conventions); where it conflicts with the codebase or DESIGN.md/VOICE.md, those win.

The Helm is the operator's workflow app: a local daemon (`apps/helm`, `:4190`) plus a native window on the M5 and the M2, holding admin authority server-side and local tools (`ffmpeg`, Rekordbox scripts, OBS, the show orchestrator) at arm's reach. This document scopes what it grows into: the primary admin surface, absorbing web `/admin` station by station until the web app is purely the public product.

## The operating principle

The operator's real problem is context: the pipeline has many small manual actions spread across two machines and several days, and keeping the state machine in his head is the tax. The Helm's job is to BE the context. Its home surface is an attention queue: every manual action the system currently needs, as an actionable row, each knowing its machine, its object, and its age. The operator opens the Helm, does the top rows, and closes it. Zero rows is the success state.

## The design doctrine

This is real workflow software, not a fiction surface. The register is product, not brand (PRODUCT.md's principles carry through palette and typography, never through prose).

- **Everything is an action.** Buttons are verb + object: "Post to TikTok", "Add to tracklist", "Create clip", "Derive cues", "Raise the glass". If a UI element is not an action, a datum, or artwork, it does not ship.
- **No narration.** No section descriptions, no explanatory paragraphs, no personality copy. The failed example, preserved as the counter-example: "The oldest dressed finding still off TikTok. Post it by hand. The caption never survives the inbox, so it's here to copy." The replacement is a row: cover art, `IYRE — Glowing Embers`, `020.2.3Y`, `17d`, [Copy caption] [Copy video URL] [Mark posted]. The data explains itself; the buttons say what happens.
- **Dense instrument.** Tabular rows over cards; small tight type; minimal padding; a full station visible without scrolling at typical window size. The anchors are Raycast and Linear: keyboard-first, instant, earned familiarity, zero decoration, the tool disappears into the task.
- **Keyboard-first.** A command palette (Cmd+K) reaching every action on every station; single-key loops where a station is a queue (the tag station's arrow-key placement); every interactive row focusable.
- **The visual warmth is the music's.** Album art and video posters are the only images. The Warm Dark tokens (Deep Field, Starlight Cream, Eclipse-Gold via @fluncle/ui) carry the identity; gold marks primary actions and the current selection, never status.
- **Numbers behave.** Oxanium `tabular-nums` for every count, age, coordinate, and duration; ages and clocks never jitter their neighbors.
- **States, not spinners.** Every action shows default / running / done / failed inline; long runs stream their real output into the run drawer (the existing SSE pattern). Skeletons for loading surfaces; empty states state the fact and offer the action ("No plans. [Create plan]") in five words, not a paragraph.
- **Motion conveys state only.** 150–250ms, ease-out, reduced-motion collapses to instant. No entrances, no choreography.

## The stations

Each station is listed as its action inventory. Data shown is implied by the actions.

### Attention (home)

- The queue: every pending manual action as a row — [the action button], object, cover, machine badge when it matters, age.
- Sources: untagged findings, unposted-to-TikTok renders, takes without cues, promoted-but-undistributed mixtapes, drafts expiring (TikTok 24h bounce), render-gate flags awaiting an eye, empty drip queue.
- Actions: the row's own primary action inline where possible (Copy caption / Mark posted), else [Open station] deep-linked with the object selected.
- The nudge engine generalizes the 18h rule: one configurable rule per source, daemon-side, per-day dedupe, native notifications. A notification IS its action: clicking opens the Helm at the row.

### Intake

- [Add finding] — paste a Spotify link; the row shows enrichment progressing (automatic stages as passive state, never actions).
- A candidates tray: links parked from anywhere (the palette accepts a URL from the clipboard), each [Add] / [Discard].

### Tag (port #1, replaces web /admin/tag)

- The untagged queue, one finding at a time: cover large, preview audio auto-playing, the vibe matrix under the arrow keys, Enter places, the queue advances. [Skip] [Undo last].
- Progress: `12 left` in the corner. Done state: the empty queue and nothing else.

### Renders

- The render queue as rows: [Requeue video], [Watch] (opens the current take), gate flags surfaced as rows in Attention when a render needs taste review.
- Box visibility: conductor state, current render age, last result — data only.

### Posting

- The next-unposted row (the Attention queue's own row, mirrored here with the full set): [Copy caption] [Copy video URL] [Open post asset] [Mark posted].
- History: posted rows with platform, date, link — data for confidence, no actions beyond [Open].

### Plans (port #2, replaces web /admin/plans)

- [Create plan] — the galaxy-slug handle minted.
- The plan editor: search-and-add rows from the archive, drag to order, [Remove], cue/track count live.
- [Export to Rekordbox] (M2), [Copy handle], [Copy tracklist text] (for Beatport playlist building by hand).

### Show (exists; M5)

- Tracklist picker → [Raise the glass]; the pre-flight as checklist rows (the `[clear]`/`[hold]` tokens are real machine output and stay); [Depart anyway] on holds; [Stand down].
- OBS custody (new): [Arm recording] / [Stop recording] via obs-websocket, the audio meter as a live datum beside it.
- Links: the glass, the phone remote — as buttons, not prose.

### Set lifecycle (exists)

- Capture (M5): the ~/Movies scan as rows (name, size, duration) → [Upload as take] with title/date fields prefilled.
- Cues (M2): [Derive cues] → the parse preview as rows → [Attach to take]. [Export plan to Rekordbox].
- The shelf: plan / take / promoted lanes; [Promote to mixtape] (confirm), [Distribute] (M5), [Announce] (new: the Telegram/Discord leg as a button).
- Set-video (new): [Render set video] → conducts the Unit-O long-form render on the box; state as data.

### Studio (port #3, replaces web Studio; the local-ffmpeg station)

- The take/mixtape picker → the cue rail with waveform, scrub, in/out handles.
- [Create clip] — local ffmpeg cut, seconds not queue-cycles; the clip plays inline immediately; [Re-cut] after nudging handles.
- [Caption clip] — burn-in via the same local lane; [Queue for Instagram] (the drip-feed backend), [Send to posting] (the TikTok tray).
- The hybrid rule: the Helm cuts locally when a source is at hand (local file or a one-time cached R2 fetch); the box clip-sweep remains the autonomous lane for the scheduled drip. One shared recipe module defines the ffmpeg invocation for both lanes; a locally-cut clip is byte-identical to an autonomously-cut one.

### Pulse (exists, tightened)

- The system grid as data: render queue depth, box cron state, surface statuses, glass/bridge liveness, last deploy, storage. No prose under any of it.
- [Send test nudge], [Open /status] — the only actions.

## The machine model

State lives in the Worker; both Helms read and write the same truth through the admin API, so plans, cues, posted-state, and shelf state sync by construction. The Helm adds asset geography: local files (takes in ~/Movies, master.db) are machine-bound, so actions that need them carry a machine badge and appear actionable only where they can run (enforced server-side per manifest, shown as a muted `→ M2` hint elsewhere). Heavy files move through R2, never peer-to-peer.

## Mobile is one card

The only irreducibly-mobile action is posting to TikTok (the app owns the inbox). Web `/admin` therefore shrinks, at the end of the strangler sequence, to a single always-up route: the post card — video download, caption copy, [Mark posted]. Everything else lives in the Helm. A future mobile app is unnecessary until something else becomes genuinely mobile; the card costs nothing to keep.

## The frame decision

Weighed now that one frame is built and battle-tested:

- **The Swift shim (current).** One 517-line file, no toolchain beyond `swiftc`, tray + Dock + WKWebView, daemon custody. Cost discovered in the build: macOS Local Network privacy blanks WKWebView on loopback, requiring the `helm://` URLSession proxy (~110 lines, now written and stable). Pros: zero ecosystem weight, instant rebuilds, the daemon stays the whole brain. Cons: the proxy is bespoke plumbing to maintain; no auto-update (irrelevant: `git pull` + rebuild is the update); WKWebView only.
- **Tauri.** Would replace the shim with a maintained shell (tray, window, updater APIs) and its own IPC. Costs a Rust toolchain in a TS/Go repo and still would not move any logic out of the daemon (it would sidecar it). Verdict: switch only if the shim's proxy or window plumbing becomes a recurring tax; nothing today argues for it.
- **Electron.** Bundles a second Chromium per machine for a two-Mac internal tool on a rig where Chrome already runs. Never.
- **Full native Swift (no web UI).** Would abandon the @fluncle/ui investment, the strangler reuse of web components, and the phone remote's shared surface, in exchange for platform polish the shim already approximates. Verdict: no, structurally.

Decision: the shim is the frame. Revisit only on concrete pain, and Tauri is the named successor if that day comes.

## Sequencing

- **v1.1 — Attention.** The attention queue as home, the nudge engine generalized, the doctrine pass over the three existing stations (delete every sentence; re-type per the density rules; command palette skeleton).
- **v1.2 — The desk ports.** Tag station; Plans station; OBS custody; [Announce].
- **v1.3 — The Studio.** Local-ffmpeg clipping, the shared recipe module, drip-queue and posting-tray integration; set-video trigger.
- **v1.4 — The shrink.** Web /admin reduces to the post card; the admin routes and their tests retire; the surfaces doctrine and docs updated.

Each phase ships complete per the house standard: implementation, tests, docs, canon/product review, and the doctrine check that no narration crept in.

## Open questions for the forge

- The command palette's scope: actions only, or also object search (findings by name → jump to their row anywhere)?
- The attention queue's ordering: pure age, or a weighted urgency (TikTok draft expiry outranks tagging)?
- OBS custody depth: arm/stop only, or scene selection and the meter check absorbed into pre-flight?
- Does the tag station want the plate-era poster instead of cover art as the placement visual?
- Waveform rendering in the Studio: precompute server-side per take, or generate locally on open?
