# The Cockpit — the roadmap

Status: Forged draft (post-research, pre-panel). This is planning, not canon (AGENTS.md doc conventions); where it conflicts with the codebase or DESIGN.md/VOICE.md, those win.

The Cockpit (today: "Fluncle's Helm", `apps/helm` — the rename is v1.1 item 0) is the operator's workflow app: a local Bun daemon (`:4190`) plus a native shim window on the M5 and the M2, holding admin authority server-side (the CLI's stored credentials, in-process) and local tools (`ffmpeg`, the Rekordbox scripts, the visuals orchestrator) at arm's reach. Three stations already exist (Show, Set lifecycle, Pulse). This document scopes what it grows into: the primary admin surface, absorbing web `/admin` station by station until the web app is purely the public product.

## The operating principle

The operator's real problem is context: the pipeline has many small manual actions spread across two machines and several days, and keeping the state machine in his head is the tax. The Cockpit's job is to BE the context. Its home surface is an attention queue: every manual action the system currently needs, as an actionable row, each knowing its machine, its object, and its age. The operator opens the Cockpit, does the top rows, and closes it. Zero rows is the success state.

## The design doctrine

This is real workflow software, not a fiction surface. The register is product, not brand (PRODUCT.md's principles carry through palette and typography, never through prose).

**The naming law (ratified 2026-07-06): canon lives where the crew looks; tools speak plainly.** Public surfaces carry the fiction (findings, the Galaxy, Log IDs) because there the story is the product. Internal tooling uses functional names, because every invented noun in a tool is a tax on the operator's mental context. Renames this ratifies: **Fluncle's Helm → the Cockpit** (app name, window, tray, Dock, `fluncle cockpit`, docs), **the glass → the visuals** ([Start visuals]), **the bridge → the sync server**, raise/stand down → start/stop. The Log ID and finding vocabulary stay everywhere: they are data, not decoration.

- **Everything is an action.** Buttons are verb + object: "Post to TikTok", "Add to tracklist", "Create clip", "Derive cues", "Start visuals". If a UI element is not an action, a datum, or artwork, it does not ship.
- **No narration.** No section descriptions, no explanatory paragraphs, no personality copy. The failed example, preserved as the counter-example: "The oldest dressed finding still off TikTok. Post it by hand. The caption never survives the inbox, so it's here to copy." The replacement is a row: cover art, `IYRE — Glowing Embers`, `020.2.3Y`, `17d`, [Copy caption] [Copy video URL] [Mark posted]. The data explains itself; the buttons say what happens.
- **Dense instrument.** Tabular rows over cards; small tight type; minimal padding; a full station visible without scrolling at typical window size. The anchors are Raycast and Linear: keyboard-first, instant, earned familiarity, zero decoration, the tool disappears into the task.
- **Keyboard-first.** The command palette (below) reaches every action; single-key loops where a station is a queue; every interactive row focusable.
- **The visual warmth is the music's.** Album art and video posters are the only images. The Warm Dark tokens (via @fluncle/ui) carry the identity; gold marks primary actions and the current selection, never status.
- **Numbers behave.** Oxanium `tabular-nums` for every count, age, coordinate, and duration; ages and clocks never jitter their neighbors.
- **States, not spinners.** Every action shows default / running / done / failed inline; long runs stream real output into the run drawer (the existing SSE pattern). Skeletons for loading surfaces; empty states state the fact and offer the action ("No plans. [Create plan]") in five words, not a paragraph.
- **Motion conveys state only.** 150–250ms, ease-out, reduced-motion collapses to instant. No entrances, no choreography.

## The command palette

Built on the Command primitive already vendored in @fluncle/ui (cmdk 1.1.1, proven under React 19 in this repo — zero new dependencies). Two groups: Actions and Objects (findings, plans, takes, mixtapes — server-searched async with `shouldFilter` off, `keywords` carrying Log IDs and galaxy-slug handles so `020.2.3Y` finds its row). Linear's law applies: **actions scope to the active station and selection**, with the station shown as a badge above the input; the nested-pages pattern (Backspace pops) drills from an object into its actions. The palette is the app's front door.

## Attention (home)

The mechanics are the proven Linear/Superhuman queue shape: each row has a single-key primary action that fires and **auto-advances** to the next row; snooze hides a row **until a chosen time or until its state changes, whichever comes first** (never a dumb timer); the zero state is the design's whole point. Ordering is weighted urgency: deadline-bearing sources decay toward now, age-based sources grow linearly, ties fall to oldest-first; each source declares its own curve.

The sources, with their data-honesty verdicts (T1-verified):

| Source                               | State today                                                                                                                                                                          | Verdict                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Untagged findings                    | `listTracks({placement:"unplaced"})` + free count                                                                                                                                    | EXISTS                        |
| Unposted to TikTok                   | `social_posts` reads; the Pulse station computes it today                                                                                                                            | EXISTS                        |
| Takes without cues                   | `hasVideo && tracklist.length===0` off `list_recordings`                                                                                                                             | EXISTS                        |
| Promoted, undistributed              | `mixtapes.status='distributing'` + null social URLs                                                                                                                                  | EXISTS                        |
| TikTok draft gone stale (24h bounce) | `status='draft'` rows carry their push time; the deadline math is new, and the current freshness logic counts a draft as "gone out" — a bounced draft never resurfaces. Fix both.    | PARTIAL — small honest build  |
| Render awaiting taste review         | No gate verdict exists server-side (judge outputs live in R2 bundles only). Needs a verdict write-back (one column or table the render box POSTs into) before this source can exist. | NEEDS NEW STATE — scoped v1.2 |
| Drip queue empty                     | `list_clip_posts` + pending-clip counts                                                                                                                                              | EXISTS                        |

The nudge engine generalizes the shipped 18h rule: one rule per source, daemon-side, per-day dedupe, native notifications; a notification IS its action (clicking opens the Cockpit at the row).

## The stations

Each station is its action inventory. Three exist today (Show, Set lifecycle, Pulse); the rest port from web /admin, which is bigger than a first look suggests: the pipeline board alone carries the Tag, Enrich, Note, Context, Observation, and Push dialogs plus the Discogs/Last.fm workflow cells, and every one of those needs a home before the board retires.

### Intake

- [Add finding] — paste a Spotify link; enrichment stages render as passive state.
- A candidates tray: parked links, each [Add] / [Discard].

### The finding inspector (new in this revision — the board's orphan home)

Reached from any finding row or the palette: one drawer with the per-finding actions the web board's dialogs own today — [Tag], [Enrich], [Edit note], [Edit context], [Observation], [Push] — plus the workflow cells (Discogs/Last.fm state) as data. The board retires only when this inspector covers every cell.

### Tag (port #1)

- The untagged queue, one finding at a time: cover art large (decided), preview audio auto-playing, the vibe matrix under the arrow keys, Enter places and advances. [Skip] [Undo last].
- `12 left` from the existing filtered count. Done state: the empty queue.

### Renders

- The render queue as rows: [Requeue video], [Watch]. Box state (conductor phase, current render age, last result) as data.
- Gate flags surface in Attention once the verdict write-back exists (v1.2).

### Posting

- The next-unposted row with the full set: [Copy caption] [Copy video URL] [Open post asset] [Push TikTok draft] [Mark posted] [Mark failed] — the web Push dialog's exact capabilities (it is the proven prototype; the TikTok 5-per-24h cap warning carries over).
- History rows: platform, date, link.

### Plans (port #2)

- [Create plan]; the editor: search-and-add from the archive, drag to order, [Remove], autosave, [Copy handle], Beatport deep-links (all exist on web and port).
- New work, not ports: [Export to Rekordbox] (M2, wraps the existing script) and [Copy tracklist text].

### Show (exists; M5)

- Tracklist picker → [Start visuals]; the pre-flight as checklist rows (the `[clear]`/`[hold]` tokens are real machine output and stay); [Depart anyway]; [Stop].
- OBS stays out (decided): the operator is in OBS anyway for the Twitch stream; the Cockpit never layers over it.
- Links: the visuals page, the phone remote.

### Set lifecycle (exists)

- Capture (M5): the ~/Movies scan → [Upload as take]. At upload, the daemon also generates the take's two analysis artifacts locally and uploads them beside it: the visual waveform (`audiowaveform -b 8` peaks JSON) and the energy envelope (`analyze-set`, today staged only at mixtape-distribute time — this moves it to take-upload, keyed by recording id). New wiring, local-run, no Worker involvement.
- Cues (M2): [Derive cues] → preview rows → [Attach to take]. [Export plan to Rekordbox].
- The shelf: plan / take / promoted lanes; [Promote to mixtape] (confirm); [Distribute] (M5).
- [Announce] is NEW plumbing, not a port: no mixtape announce op exists (the Telegram machinery is findings-only today). Scope: one operator-tier op + button for the Telegram crew announcement; the newsletter mention stays in the newsletter flow.
- [Render set video] runs LOCALLY (corrected: `set:render` is the operator's evening GPU job and the M5 is the GPU machine) — a streamed run, not a box conduction.

### Studio (port #3 — the local-ffmpeg station, scoped at its TRUE size)

The web Studio is 1,500 lines and owns more than clipping. The port covers all of it:

- The cue rail (ports: RecordingCueRail, the energy lane, the Video scrubber and crop frame — all Worker-free components), rendered against the take's precomputed peaks + envelope; region in/out handles via wavesurfer v7 Regions.
- [Create clip] — the local lane calls the ONE existing recipe: `clipCutFfmpegArgs` (already pure, tested, and single-sourced in apps/cli; extracted to a shared package so CLI, box, and Cockpit import one function — byte-identical output by construction). An optional `h264_videotoolbox` throwaway preview gives instant [Re-cut] feedback and is never the published artifact.
- The clip library + drip controls (absorbing web /admin/clips, including #325's kill switch, batch schedule, per-clip drip state): [Pause drip] / [Resume], [Schedule clip], [Remove from schedule]. Same table, same ops — a clip auto-enrols on create; no parallel queue exists or ever will.
- [Publish as mixtape], the promoted-mixtape block (dream note, SoundCloud link, the distribution strip, [Make YouTube public], the set-video toggle), and [Resync from cues] — the second half of the real Studio, previously unscoped.
- OPEN DECISION (operator): [Caption clip] burn-in contradicts the shipped deliberate choice that clips go out clean (set footage reads badly under captions; the caption belongs to the platform post). If it ships anyway, it is libass with a semi-transparent box, never drawtext — but the default position is: clips stay clean, the action does not ship.

### Newsletter (previously unaddressed)

The weekly authoring/send surface exists on web /admin and is desk work. It ports late (v1.3) as a small station (the draft view + [Send] against the existing flow) or explicitly stays web until absorbed; it is named here so the strangler never orphans it.

### Pulse (exists, tightened)

- The system grid as data. [Send test nudge], [Open /status].

## The machine model

State lives in the Worker; both Cockpits read and write the same truth through the admin API. The Cockpit adds asset geography: machine-bound files (takes in ~/Movies, master.db) badge their actions server-enforced per manifest, shown as a muted `→ M2` hint elsewhere. Heavy files move through R2, never peer-to-peer.

## The shrink end-state (corrected)

Web /admin ends as: **the post card** (the Push dialog's capabilities as one always-up route: video download, caption copy, push draft, mark posted) **plus the permanent auth plumbing** — the four OAuth start/callback pairs (Spotify admin-login AND Spotify API, YouTube, Mixcloud) and logout are the only way to mint the provider tokens the CLI, box, and enrichment depend on, and they survive forever. The Spotify callback multiplexes admin-login with API reconnect; neither purpose may be deleted. Everything else — board, tag, plans, studio, clips, newsletter routes and their server functions — retires as its Cockpit station absorbs its daily use.

The drip tension is ratified: #325's web drip controls shipped as the only operator control while this direction formed; they are throwaway by construction. No further web-side drip UI; the Studio station absorbs the controls in v1.3; v1.4 deletes /admin/clips including them.

## The frame decision

- **The Swift shim (current, shipped).** 517 lines, `swiftc`, tray + Dock + WKWebView + daemon custody + the `helm://` loopback proxy (macOS Local Network privacy blanks WKWebView on loopback; the proxy serves via URLSession — bespoke but stable).
- **Tauri v2 (the named successor, criteria sharpened).** Its webview layer ships, as a maintained primitive, exactly the custom-protocol plumbing the shim hand-rolled. Flip to Tauri only when (a) the proxy/window plumbing becomes a recurring maintenance tax, or (b) a real mobile target materializes (Tauri v2 iOS/Android is GA). Neither is true today.
- **Electron**: never (a second Chromium for a two-Mac internal tool). **Full native Swift**: structurally wrong (abandons @fluncle/ui and the strangler reuse).

## The rename sweep (v1.1 item 0 — measured radius)

- **glass → visuals**: ~245 sites (packages/live 22 files + apps/helm show-control/shim + 9 docs). Careful: incidental "glass" in apps/web styles/game files is NOT the renderer — excluded.
- **bridge → sync server**: ~214 sites (15 files + docs + contract).
- **helm → cockpit**: ~241 sites. The five tricky pieces: (1) the LaunchAgent label migration (`launchctl bootout` the old `com.fluncle.helm` before installing `com.fluncle.cockpit` — the CLI owns the transition); (2) persisted config filenames (`helm.key`, `helm-dir`, `helm-nudge.json`, the log) migrate-on-first-boot so the key and nudge dedupe survive; (3) the /Applications app is a NEW bundle id — the installer removes the old app; (4) the `helm://` URL scheme may stay as internal plumbing (invisible, shrinks the radius) — decided at sweep time; (5) the tray glyph needs a new SF Symbol (no "cockpit" wheel exists).
- Non-sites, verified: no registry entries, no turbo.json references — the sweep is code+docs+launchd+configs only.

## Sequencing

- **v1.1 — Names + Attention.** The rename sweep (clean break, migrations above); the attention queue as home with the five EXISTS sources; the nudge engine generalized; the doctrine pass over the three existing stations (delete every sentence; re-type per density rules); the command palette on the vendored primitive; the finding inspector skeleton.
- **v1.2 — The desk ports.** Tag; Plans (+ the two new export actions); the finding inspector completed (board-cell parity); the announce op; the gate-verdict write-back (unlocks the taste-review attention source); the stale-draft fix.
- **v1.3 — The Studio, whole.** The cue rail against upload-time peaks+envelope; the shared clip-recipe module; local cut + videotoolbox preview; the clip library + drip controls absorbed; publish-as-mixtape + the promoted block + resync; the newsletter station (or its explicit deferral).
- **v1.4 — The shrink.** Web /admin reduces to the post card + the permanent OAuth plumbing; every retired route's tests and server functions go with it; the surfaces doctrine and docs updated.

Each phase ships complete per the house standard: implementation, tests, docs, product review, and the doctrine check that no narration crept in.

## Open decisions (operator)

- [Caption clip]: ship it (libass, boxed) or honor the standing clips-ship-clean decision? Default: clean, no action.
- The newsletter: port as a v1.3 station, or keep web until a later phase?
- The `helm://` scheme: rename with the sweep or keep as invisible plumbing? Default: keep.
