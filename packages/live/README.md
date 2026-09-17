# @fluncle/live — the glass

The live runtime: Fluncle's journey rendered through the ship's glass while the
operator mixes. Two local processes — the **glass** (`bun run glass`, the WebGL
renderer on :4173) and the **bridge** (`bun run bridge`, plan + fingerprint
identity + supervisor + phone remote + the crew wall on :4180) — bound by
`src/contract.ts`.
Local-only by design (the never-crash rail: no network dependency mid-show).

## The glass (Unit L)

`bun run glass` bundles the browser client and serves a self-contained page.
`$FLUNCLE_GLASS_PORT` overrides the default `:4173`; tests use an alternate port. **The glass resolves `/plan` bridge-first:** at
boot (and whenever the bridge appears or returns) it asks the bridge's `/plan` on
`:4180` and serves THAT when it answers — the operator's real, full plan — falling to
its own committed `src/plan-pointer/tracklist.json` demo fixture only when no bridge
answers, and absent even a tracklist it runs uncharted-space standalone (the failure
floor). It narrates which source won (`plan: 17 findings via the bridge` vs `plan: 5
findings, local fixture — no bridge`). The boot table reports the selected plan source and finding count. `$FLUNCLE_BRIDGE_PORT`
overrides the `:4180` the glass proxies to (default `BRIDGE_PORT`) — a test rig points
the glass at a scratch bridge without touching the operator's live `:4180`. The
standalone demo `tracklist.json` is a deliberate 5-entry stand-in; the bridge's `/plan`
serves the real set, so the two index the SAME list end-to-end (the bridge pointer and
the glass plan stay in lock-step).

Module map (`src/glass/`):

- **`flash-limiter.ts`** — the crown: the REAL WCAG 2.3.1 flash math, pure and
  isomorphic. A source-side `FlashLimiter` (a 1s ring buffer counting opposing
  luminance pairs — ≥10% delta, darker endpoint <0.80 — plus an INDEPENDENT
  saturated-red net; a 4th flash in any trailing second is eased, never emitted)
  and an output-side `FlashMonitor` (the same counters fed the downsampled frame).
  Exhaustively covered by `flash-limiter.test.ts` (3 pass / 4 fail, red
  independence, the 174 BPM = 2.9 Hz boundary).
- **`scene-extract.ts`** — resolves an archived composition to replay-ready
  GLSL + classifies its custom uniforms. Returns `layers[]` for multi-layer composites and classifies position/velocity uniform pairs. Also flags `usesDrop` (a layer reads `u_audioDrop` /
  drives a drop alias — the marker the drop arc keys off) and parses the archived
  `dropShape` (rise/hold/fall) from the composition's `reactivity` prop. Covered by
  `scene-extract.test.ts`.
- **`drop-envelope.ts`** — the drop-reveal engine, pure + isomorphic (the sibling
  of `flash-limiter.ts`/`settle.ts`). `DropEnvelope` drives `u_audioDrop` from the maximum of the DSP signal, a scripted arrival arc, and a live reveal trigger, preserving the authored buildup and payoff in live playback. The **scripted arrival arc** runs buried→crest→settle over the scene's
  span, fired on arrival at / replay of a drop scene — the composition's authored
  dramaturgy, honoring its archived `dropShape` or a canonical ~4s surge / slow
  settle at ~37.5%), and a **live reveal** (a fast ~300ms attack / ~8s release fired
  by the manual `f` key or the `DropDetector`). `DropDetector` is a hysteresis state
  machine over broadband energy (a sustained dip→slam = the DnB drop signature,
  conservative + refractory). The reveal is a smooth seconds-long rise, never a
  strobe, so the flash limiter's output monitor stays authoritative over the flood.
  Covered by `drop-envelope.test.ts`.
- **`glsl-runtime.ts`** — the shared header contract (`CORE_UNIFORMS`), the
  default-vehicle + holding `FRAG`, and the bloom post-pass shaders (mirroring
  `packages/video`'s design). Imports the real `packages/video` GLSL vocabulary.
- **`plan.ts` / `page.ts` / `serve.ts`** — the `/plan` + `/scene` endpoints, the
  HTML shell, and the thin Bun server that bundles the client via `Bun.build`.
- **`client/`** — the bundled browser runtime: `pipeline.ts` (one WebGL2 context,
  one shared FBO chain: base → multi-layer replay composite → crossfade + Warm-Dark
  /grain rails → bloom → screen + async PBO output readback; the `build()` path is
  shared by cold boot AND `webglcontextrestored`), `dsp.ts` (live band DSP + the
  40-bin log-mel frame — dual-resolution: the slow/bass/mel signals keep the 4096-FFT
  window while the transient class rides a second 1024-FFT analyser for ~60ms lower
  onset latency; the `l` key toggles comparison with the single-4096-FFT DSP path),
  `bridge.ts` (the contract client — consumes `ShowState`,
  sends heartbeats + mel + commands, standalone-safe), and `main.ts` (arrivals,
  plate, HUD, keys, the `drop-envelope.ts` arc/reveal wiring, and the RFC §4
  reliability rails).

Operator keys: `→/n` advance · `←/p` rewind · `0` holding · `b` blackout (hold) ·
`-/=` intensity · `1/2/3` vehicle · `m` auto · `v` replay · `f` reveal (fire the drop
flood, live) · `g` bloom · `r` scale · `h` HUD · `d` demo · `l` low-latency DSP (A/B) ·
`Shift+X` context-loss smoke · `i` the keys overlay (`Esc` also closes).

Press `i` in the glass for an on-screen legend of all of the above. That overlay,
the keydown dispatch, and this list's runtime siblings (the boot cheat-sheet in
`serve.ts`) are all generated from the ONE `KEYBINDINGS` table in
`src/glass/keybindings.ts` — the single source of truth, so the legend can never
drift from the behaviour. Add a binding there and it lights up everywhere;
`keybindings.test.ts` guards the table's integrity, and `main.ts`'s handler map
is typed against it so a table entry without a handler fails typecheck. This
Markdown table is the only human-maintained mirror — keep it in step by hand.

## The bridge (`src/bridge/`, Unit B — RFC §4)

One stateless-restartable Bun process on `:4180`:

- **`GET /plan`** — the enriched planned tracklist. `--plan` takes **`all`** (RANDOM-VJ
  MODE, the WHOLE archive as an unordered pool — see below), a **mixtape logId**
  (`019.F.1A`, the calibrated default) **or a plan HANDLE** (a galaxy slug like
  `dark-aurora-roller` — the normal live flow, since a plan exists before the set is
  played); the shape routes the resolver (`isAllPlan` first, then `classifyPlanRef`). A handle resolves through
  the admin API (reusing the CLI's stored token) to its ordered plan cues, each mapped to
  a finding, then down the SAME enrichment path: palette + seed (`props.json`) and the
  dream-replay scene (`composition.tsx`, resolved + classified by the glass's
  `scene-extract.ts` — the one extractor in the package). A miss holds loudly, naming
  requested-vs-loaded, and falls to the committed fixture. The glass keeps its standalone
  `/plan` on `:4173` for bridge-less mode, so **`:4180` takes precedence when the bridge
  is up**.
- **`ws://:4180/state`** — the fused `ShowState` at 30Hz (`seq`/`t`, per-channel
  staleness, pointer/pending/match, intensity, blackout, pre-arm). Ingests
  `ShowCommand`s on the same socket: the glass's 10Hz `mel` frames (the matcher
  feed), manual nudges, blackout, intensity, and render heartbeats.
- **`GET /remote`** — the phone web-remote (`remote.ts`), a canon surface served on
  the LAN: big NEXT / PREV, the current + next finding, hold-to-engage blackout,
  intensity, and channel health in canon colours.
- **`GET /crew`, `GET /crew/wall`, `GET /crew/moderate`** — THE CREW WALL (`crew.ts` +
  `crew-page.ts`), the room's own logos on the show screen. See below.
- **`GET /health`**, **`GET /scene?logId=`** — resource reads.

### The crew wall (`crew.ts`, `crew-page.ts`)

Everyone in the room is on the same WiFi, so they put their own logo on the screen behind the
decks. Three LAN pages on `:4180` beside `/remote`, and one store:

- **`/crew`** — the page a stranger opens off a QR: pick an image, optional name, send. An
  ARRIVAL surface, so its copy speaks plain (no cosmos vocabulary; nobody scanning a code at a
  party has read the lore).
- **`/crew/moderate`** — the operator's queue: thumbnail, name, `Approve` / `Reject`, and
  `Remove` for anything already up. Refreshes itself every 3s.
- **`/crew/wall`** — the overlay OBS reads as a **Browser Source**. Transparent ground, one
  logo at a time crossfading on the dwell, parked in a corner, with a QR card carrying the LAN
  URL so the stream itself tells the room where to go. Tunable from the source URL with no code
  edit: `?corner=tl|tr|bl|br` `&size=<px>` `&opacity=<0-1>` `&dwell=<ms>` `&qr=0`
  `&qr-corner=tl|tr|bl|br` `&qr-size=<px>`. The QR card scales with the canvas; the room's
  screen is the path it is sized for, and a stream watched on a phone wants `qr-size` raised.

The rails, in the bridge's house style:

- **The operator gate is ON by default.** An upload lands `pending` and reaches the wall only
  once he approves it. `FLUNCLE_CREW_AUTO_APPROVE=1` skips the queue for a room he trusts —
  anyone on the WiFi then reaches the stream directly, so it is opt-in and never the default.
- **Raster only, decided by MAGIC BYTES** (PNG / JPEG / WebP / GIF), never by the filename or
  the browser's claimed content-type. **SVG is refused outright**: it executes script, and the
  wall is a browser source pointed at the stream.
- **Bounded** — 2 MB a file, 60 logos a wall, 5 uploads a minute per address, all from
  `contract.ts`. The rate gate runs BEFORE the body is read, and an oversized body is refused
  on its declared `content-length` rather than buffered first.
- **Never-crash** — every store entry point is total and returns a discriminated outcome
  (`{ok:false, reason}`), a corrupt index starts clean rather than throwing, and the wall keeps
  walking the order it holds when a poll fails. A logo deleted mid-show fires the `<img>` error
  path and advances instead of freezing.
- **Restartable** — the logos and their states live in the gitignored `packages/live/.crew/`
  (override with `FLUNCLE_CREW_DIR`), so a bridge restart mid-set keeps the wall. An index
  entry whose file has gone missing is dropped on load, never served as a hole.
- **One shuffle implementation** — the rotation order is drawn bridge-side by the SAME
  `createShuffleBag` the RANDOM-VJ director uses (`/crew/roll`, where `?last=` rotates the order
  so the seam between two rolls cannot repeat a logo). The browser holds no shuffle of its own
  to drift out of step, and it polls the cheap `/crew/version` rather than rebuilding a roll
  every few seconds.
- Uploader-supplied text is rendered with `textContent`, never `innerHTML`.

LAN-local by design, exactly like `/remote`: no auth, nothing in `@fluncle/registry`, never on
the open internet. `run show` prints the three URLs and a scannable code in its boot table.

The QR is encoded offline by `src/qr.ts` (byte mode, level M, versions 1-10) — no hosted QR
service, because the rig has no network dependency mid-show. `qr.test.ts` pins a golden matrix
plus the structural invariants; the golden is only as good as the day a real scanner read it, so
**`bun run --cwd packages/live qr:verify`** is that day, repeatable: it renders every case and
decodes it with OpenCV's `QRCodeDetector`, requiring the source string back. Run it after any
change to `src/qr.ts`. It needs `uv` and is outside `bun test` for the same reason
`test:matcher-accuracy` is.

### The plan-scoped fingerprint matcher (`matcher.ts`, the star)

A set is planned, so identity is a tiny search: at show start the bridge
fingerprints each planned finding's official 30s preview
(`fingerprint.ts` → `mel.ts`: 40 log-mel bins 0-8kHz @ 10Hz, amplitude-accumulated
to mirror the glass's browser DSP, then **shape-normalized** — mean-subtract + L2,
which strips per-analyzer spectral tilt and collapses the amplitude-vs-power
difference, so the glass's raw wire frames and the ffmpeg fingerprints compare
content, not analyzer); at show time the matcher scores a rolling ~22s window
against the **pending** (pointer+1) fingerprint and advances the pointer on a
confirmed, sustained match. A hybrid gate (margin-over-current **or** a high
absolute override) + sustain + min-dwell keeps the pointer monotone; a
**skip-ahead** rule (pending+1 confirming strongly while the pending stays weak
advances two — still monotone-forward) stops a weak/unmatchable preview from parking
the pointer; the energy dip→surge detector is the **pre-arm hint only** (never
advances alone). **Manual advance / rewind / goto always win, instantly.** Pure and
unit-tested.

**Full-song references.** Full-song fingerprinting is opt-in through `FLUNCLE_FULL_SONG_FINGERPRINT` and requires an operator token; previews remain the default. On fetch or decode failure, the matcher skips null frames and continues network-free during the show. Before enabling the flag, regenerate `anchors.json` from full audio, calibrate the skip thresholds on the mixed fixture set, and require `test:matcher-accuracy` to report `spurious == 0`. Full-song audio is pulled through the operator-tier `get_source_audio` endpoint (`fingerprintPlanFullSong` → `fingerprintSourceAudio`). `bestOffsetScore` budget-caps full-song scanning with `budgetedOffsetStep` at ≤`OFFSET_POSITION_BUDGET` sliding positions per call and uses `offsetStep` as the floor for short references.

**Fingerprint unit tests** (`fingerprint.test.ts`, in the ordinary `bun test`, no ffmpeg and no network): the s16le chunk-boundary reassembly (`createS16leSink` — a sample's two bytes can land in different ffmpeg stdout chunks) and all four never-crash fetch rails. The bytes → real frames success path is not covered here; that stays the accuracy run's job.

**Accuracy.** `bun run test:matcher-accuracy` replays the matcher against local fixtures and requires ffmpeg plus `FLUNCLE_ALIGN_FIXTURES=<dir>`; it is excluded from `bun test`. The harness checks monotonic ordering, transition timing, and spurious advances. The runtime contract is a monotone, never-wrong-track pointer with manual nudge for unmatchable previews. Rerun the harness after changing `mel.ts` or matcher gates.

### RANDOM-VJ MODE (`--plan all`, `vj.ts`)

RANDOM-VJ MODE is a **different job** from the plan-scoped matcher. The plan/matcher path answers "has the PENDING planned finding started yet?" — it needs an ordered tracklist and an identity to recognize. RANDOM-VJ MODE answers a set where the DJ plays **anything, in any order, possibly tracks that aren't in the archive at all**. It still tries to show **THAT finding** when the DJ plays one — the datagram carries the live deck's identity, resolved on flip — and falls back to a fresh shuffle draw when it can't. Random is the graceful degradation, not the goal: an on-brand visual that **changes on each transition**, drawn from the **whole archive**, never repeating within a set.

- **The pool** — `bun run bridge --plan all` builds the pool from `buildAllFindingsPlan` (`plan.ts`): the WHOLE archive drained from the public merged feed (`GET /api/v1/tracks`, cursor-paginated — `fetchAllArchiveRows` follows `nextCursor` through `URLSearchParams` so the base64 cursor survives URL-encoding), then enriched down the SAME `props.json`/`composition.tsx` path the ordered plans use, at bounded concurrency (8). The feed rows already carry the member metadata (`logId`/`title`/`artists`/`durationMs`), so there is no per-id round-trip — only `enrich` re-hits `found.fluncle.com`. **Fluncle's own mixtape is excluded** (`isMixtapeCoordinate` — the `F`-galaxy middle char of `NNN.G.CC`; the feed rows include it but the VJ pool is the ~60 findings only, ~55 replayable, the rest riding the default-vehicle morph). It is served over `/plan` exactly like any other plan, so the glass renders it with no changes. VJ mode has no fallback tracklist, so it **fails fast + loud**: a non-OK / thrown feed fetch (`www.fluncle.com` fronts a Cloudflare rule that 403s crawler-ish user-agents), a repeating/runaway cursor (a pagination safety rail), or an empty resolved pool throws, and the bridge exits non-zero rather than boot a visual-less show.
- **No fingerprinting** — because there is no identity to match, `boot()` (`serve.ts`) returns `frames: null` for every entry, so the matcher never advances on its own (`channels.matcher` reads `off`). Only `isAllPlan` disables fingerprinting; every other plan reference fingerprints and matches.
- **The director** — a **shuffle-bag** (`createShuffleBag`, pure + seedable): random WITHOUT replacement (every finding shows exactly once before any repeats), reshuffled on exhaust, and never the same finding back-to-back — including across the reshuffle boundary. Seeded per set with `mulberry32(Date.now())`. `take(index)` removes a still-pending index from the current cycle so a finding shown by a **canonical identity match** (below) isn't then re-drawn at random this cycle; the anti-repeat boundary covers a taken index too.
- **The transition channel — CLOSING THE LOOP** — a `node:dgram` UDP listener bound **only** in VJ mode (`startVjTransitionListener`). The DJ-mixer sender on the other machine fires one datagram per mix transition, optionally carrying the identity of the track that went live (read on the mixing machine by `deckwatch.py`, since the bridge can't OCR a screen on the other Mac):

  ```json
  {
    "type": "transition",
    "deck": 2,
    "identity": { "title": "…", "artist": "…", "bpm": 173, "key": "5A" }
  }
  ```

  On each **valid** datagram `serve.ts`'s `selectVjIndex` runs **one code path**:
  - **identity present + resolves** (`resolveDeck` against the pool — a `PlanEntry[]` is structurally a `Finding[]` because it carries `bpm` and `key`) → `goto(match.index)`: the wall shows **THAT finding**, and the index is `take`n from the bag. The resolve is **on flip** (the bass swap), the ratified fusion timing — reading the deck earlier is fine, swapping earlier is forbidden.
  - **no identity, or it resolves to nothing** (OCR noise, or the DJ played a track that simply isn't a finding) → `goto(bag.next())`: a fresh shuffle draw. Random is the graceful degradation, never the WRONG specific finding.

  Which path was taken (matched logId + score, or the fallback reason) is logged. Malformed / non-JSON / wrong-`type` / bad-`deck` datagrams are **ignored silently**, and a malformed `identity` degrades to "no identity" without rejecting the transition (the never-crash rail). The port defaults to `VJ_TRANSITION_PORT` (`9000`), overridable via `FLUNCLE_VJ_TRANSITION_PORT` (set `0` for an ephemeral OS-assigned port). It binds on all interfaces so a **LAN/VPN peer** can reach it — **LAN-local by design**, like the rest of the live rig (no auth; keep it off the open internet). Covered by `vj.test.ts` (the bag guarantees incl. `take`, the parser incl. identity variants, a live ephemeral-socket round-trip) and `serve.test.ts` (the `selectVjIndex` match-vs-fallback decision).

### The supervisor (`supervisor.ts`, RFC §3)

The out-of-process watchdog: no render heartbeat for >5s ⇒ relaunch the pinned
Chromium (`--app` kiosk, own profile, auto-update disabled; `open -na <app>` on
macOS via `FLUNCLE_CHROMIUM`). Every trip is logged; the OBS fallback scene covers
the relaunch seconds.

### Env

`FLUNCLE_PLAN_MIXTAPE` (default `019.F.1A`), `FLUNCLE_WEB_BASE`,
`FLUNCLE_FOUND_BASE`, `FLUNCLE_CHROMIUM`, `FLUNCLE_GLASS_URL`, `FLUNCLE_FFMPEG`,
`FLUNCLE_BRIDGE_PORT` (the `:4180` the glass proxies its `/plan` to; default
`BRIDGE_PORT`), `FLUNCLE_VJ_TRANSITION_PORT` (RANDOM-VJ MODE's UDP transition port;
default `VJ_TRANSITION_PORT` = `9000`), `FLUNCLE_CREW_DIR` (where the crew wall keeps its
logos; default the gitignored `packages/live/.crew/`), `FLUNCLE_CREW_AUTO_APPROVE` (skip the
operator's approval queue — opt-in, never the default). A plan HANDLE additionally reads the admin API base + token from the
env (`FLUNCLE_API_TOKEN` / `FLUNCLE_API_BASE_URL`) or `~/.config/fluncle/.env.production`
(the CLI's stored credential, read-only).

The plate gallery: `FLUNCLE_SHOW_PLAN=src/glass/fixtures/plan-plate-era.json bun src/glass/serve.ts` runs the first twelve plate-based findings as a standalone lounge-mode demo.
