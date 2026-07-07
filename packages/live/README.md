# @fluncle/live — the glass

The live runtime: Fluncle's journey rendered through the ship's glass while the
operator mixes. Two local processes — the **glass** (`bun run glass`, the WebGL
renderer on :4173) and the **bridge** (`bun run bridge`, plan + fingerprint
identity + supervisor + phone remote on :4180) — bound by `src/contract.ts`.
Local-only by design (the never-crash rail: no network dependency mid-show). The
doctrine and architecture originate in the live+longform RFC (shipped #287–#291;
now in git history).

## The glass (Unit L)

`bun run glass` bundles the browser client and serves a self-contained page.
`$FLUNCLE_GLASS_PORT` overrides the default `:4173` (the operator's live instance
may hold it — tests boot elsewhere). **The glass resolves `/plan` bridge-first:** at
boot (and whenever the bridge appears or returns) it asks the bridge's `/plan` on
`:4180` and serves THAT when it answers — the operator's real, full plan — falling to
its own committed `src/plan-pointer/tracklist.json` demo fixture only when no bridge
answers, and absent even a tracklist it runs uncharted-space standalone (the failure
floor). It narrates which source won (`plan: 17 findings via the bridge` vs `plan: 5
findings, local fixture — no bridge`) so the boot table can never again show the demo
while the bridge holds the real set (the first-set debrief bug). `$FLUNCLE_BRIDGE_PORT`
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
  GLSL + classifies its custom uniforms. Now returns `layers[]` (multi-layer
  composites like 011.9.8I) and classifies velocity pairs (a position uniform +
  its `…Vel` sibling, e.g. 011.1.3X's `u_glide`/`u_glideVel`) — closing the last
  two replay gaps to 17/17. Also flags `usesDrop` (a layer reads `u_audioDrop` /
  drives a drop alias — the marker the drop arc keys off) and parses the archived
  `dropShape` (rise/hold/fall) from the composition's `reactivity` prop. Covered by
  `scene-extract.test.ts`.
- **`drop-envelope.ts`** — the drop-reveal engine, pure + isomorphic (the sibling
  of `flash-limiter.ts`/`settle.ts`). Plate-era compositions build toward a reveal
  driven by `u_audioDrop`, but live that uniform rode a slow energy-over-swell proxy
  that never crested — the buildup played, the payoff (025.5.5T the warship) never
  fired. `DropEnvelope` folds three sources into the one drop drive by `max`: the
  DSP living idle, a **scripted arrival arc** (buried→crest→settle over the scene's
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
  onset latency; the operator A/Bs it against the legacy single-4096 path with `l`),
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

- **`GET /plan`** — the enriched planned tracklist. `--plan` takes a **mixtape logId**
  (`019.F.1A`, the calibrated default) **or a plan HANDLE** (a galaxy slug like
  `dark-aurora-roller` — the normal live flow, since a plan exists before the set is
  played); the shape routes the resolver (`classifyPlanRef`). A handle resolves through
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
- **`GET /health`**, **`GET /scene?logId=`** — resource reads.

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

**Tier-A — full-song references (RFC full-audio, HELD on the operator's M5 re-tune):** the swap is GATED behind `FLUNCLE_FULL_SONG_FINGERPRINT` (`shouldFingerprintFullSong`, default OFF) so merging it is a live-path no-op — only when an operator token is present AND the flag is on ("1"/"true") does `boot()` (`serve.ts`) fingerprint the FULL SONG instead of the 30s preview, pulling each finding's captured master from the private `fluncle-source-audio` bucket through the operator-tier `get_source_audio` endpoint (`fingerprintPlanFullSong` → `fingerprintSourceAudio`, authed with the CLI's stored token), so a DJ mixing a section the preview never contains can still match (the 2 auto-match misses). A token alone never flips it — the operator sets the flag AFTER the M5 re-tune. Any other state (no token, or the default flag-off) fingerprints previews, and either way the never-crash rail holds (any fetch/decode miss → null frames the matcher skips; fetch-at-boot, held in memory, network-free during the show). A full song is ~10× a preview, so `bestOffsetScore` budget-caps its `offsetStep` (`budgetedOffsetStep`: ≤`OFFSET_POSITION_BUDGET` sliding positions per call, `offsetStep` as the floor for short refs) — which also normalizes the score scale across a MIXED full/preview plan (the reality during the capture-backfill and the terminal unmatched tail). The accuracy harness (below) reads `full/<i>.<ext>` and enforces `spurious == 0` as a HARD GATE; the swap ships only once the operator re-anchors `anchors.json` from full audio, recalibrates the skip params (`skipThreshold`/`skipMargin`/`skipSustainMs`) on the mixed config, `test:matcher-accuracy` is green (`spurious == 0`), and then sets `FLUNCLE_FULL_SONG_FINGERPRINT=1` in the show env to flip the live matcher.

**Accuracy** (`bun run test:matcher-accuracy`, offline replay of the de-risk spike's
real set — mixtape 019.F.1A, 17 tracks; needs ffmpeg + the spike fixtures via
`FLUNCLE_ALIGN_FIXTURES=<dir>`, excluded from `bun test`): **12 of 14
fingerprintable transitions detected, perfect ordering, zero wrong-track /
out-of-order advances; 8/16 within ±20s of the hook**, the rest firing minutes early
where the preview's content already plays in the blend. The two tracks whose
previews never score against the set (a weak/mismatched preview master) fall to the
manual nudge — the RFC's sanctioned override. Streaming plan-scoped fingerprinting on
near-identical liquid DnB is at its causal limit here (the spike's cleaner numbers
came from a batch global + monotonic-DP alignment, not a causal one); the matcher's
contract is a monotone, never-wrong-track pointer with the nudge as the safety net,
not a perfect auto-follow. Thresholds are calibrated in the shape-normalized domain —
re-run the harness after touching `mel.ts` or the gates.

### The supervisor (`supervisor.ts`, RFC §3)

The out-of-process watchdog: no render heartbeat for >5s ⇒ relaunch the pinned
Chromium (`--app` kiosk, own profile, auto-update disabled; `open -na <app>` on
macOS via `FLUNCLE_CHROMIUM`). Every trip is logged; the OBS fallback scene covers
the relaunch seconds.

### Env

`FLUNCLE_PLAN_MIXTAPE` (default `019.F.1A`), `FLUNCLE_WEB_BASE`,
`FLUNCLE_FOUND_BASE`, `FLUNCLE_CHROMIUM`, `FLUNCLE_GLASS_URL`, `FLUNCLE_FFMPEG`,
`FLUNCLE_BRIDGE_PORT` (the `:4180` the glass proxies its `/plan` to; default
`BRIDGE_PORT`). A plan HANDLE additionally reads the admin API base + token from the
env (`FLUNCLE_API_TOKEN` / `FLUNCLE_API_BASE_URL`) or `~/.config/fluncle/.env.production`
(the CLI's stored credential, read-only).

The plate-era gallery: `FLUNCLE_SHOW_PLAN=src/glass/fixtures/plan-plate-era.json bun src/glass/serve.ts` raises the glass standalone on the first twelve plate-era findings — the lounge-mode demo of the new-era worlds (arrows travel, `v` replays the arrival arc, `f` fires the reveal).
