# @fluncle/live — the glass

The live runtime: Fluncle's journey rendered through the ship's glass while the
operator mixes. Two local processes — the **glass** (`bun run glass`, the WebGL
renderer on :4173) and the **bridge** (`bun run bridge`, plan + fingerprint
identity + supervisor + phone remote on :4180) — bound by `src/contract.ts`.
Local-only by design (the never-crash rail: no network dependency mid-show). The
doctrine and architecture live in
[docs/live-longform-visuals-rfc.md](../../docs/live-longform-visuals-rfc.md).

## The glass (Unit L)

`bun run glass` bundles the browser client and serves a self-contained page.
`$FLUNCLE_GLASS_PORT` overrides the default `:4173` (the operator's live instance
may hold it — tests boot elsewhere). `$FLUNCLE_SHOW_PLAN` points at a tracklist a
`fluncle run show --plan` bridge writes; absent that, the committed
`src/plan-pointer/tracklist.json` demo fixture drives arrivals, and absent even a
tracklist the glass runs uncharted-space standalone (the failure floor).

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
  two replay gaps to 17/17. Covered by `scene-extract.test.ts`.
- **`glsl-runtime.ts`** — the shared header contract (`CORE_UNIFORMS`), the
  default-vehicle + holding `FRAG`, and the bloom post-pass shaders (mirroring
  `packages/video`'s design). Imports the real `packages/video` GLSL vocabulary.
- **`plan.ts` / `page.ts` / `serve.ts`** — the `/plan` + `/scene` endpoints, the
  HTML shell, and the thin Bun server that bundles the client via `Bun.build`.
- **`client/`** — the bundled browser runtime: `pipeline.ts` (one WebGL2 context,
  one shared FBO chain: base → multi-layer replay composite → crossfade + Warm-Dark
  /grain rails → bloom → screen + async PBO output readback; the `build()` path is
  shared by cold boot AND `webglcontextrestored`), `dsp.ts` (live band DSP + the
  40-bin log-mel frame), `bridge.ts` (the contract client — consumes `ShowState`,
  sends heartbeats + mel + commands, standalone-safe), and `main.ts` (arrivals,
  plate, HUD, keys, and the RFC §4 reliability rails).

Operator keys: `→/n` advance · `←/p` rewind · `0` holding · `b` blackout (hold) ·
`-/=` intensity · `1/2/3` vehicle · `m` auto · `v` replay · `g` bloom · `r` scale ·
`h` HUD · `d` demo · `Shift+X` context-loss smoke.

## The bridge (`src/bridge/`, Unit B — RFC §4)

One stateless-restartable Bun process on `:4180`:

- **`GET /plan`** — the enriched planned tracklist: the mixtape/plan members
  (public API, committed fixture fallback) each enriched with palette + seed
  (`props.json`) and the dream-replay scene (`composition.tsx`, resolved +
  classified by the glass's `scene-extract.ts` — the one extractor in the package).
  The bridge owns `/plan` here; the glass keeps its standalone copy on `:4173` for
  bridge-less mode, so **`:4180` takes precedence when the bridge is up**.
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
`FLUNCLE_FOUND_BASE`, `FLUNCLE_CHROMIUM`, `FLUNCLE_GLASS_URL`, `FLUNCLE_FFMPEG`.
