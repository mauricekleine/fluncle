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
