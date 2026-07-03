# @fluncle/live — the glass

The live runtime: Fluncle's journey rendered through the ship's glass while the
operator mixes. Two local processes — the **glass** (`bun run glass`, the WebGL
renderer page on :4173) and the **bridge** (`bun run bridge`, plan +
fingerprint identity + supervisor + phone remote on :4180) — bound by
`src/contract.ts`. Local-only by design (the never-crash rail: no network
dependency mid-show). The doctrine and architecture live in
[docs/live-longform-visuals-rfc.md](../../docs/live-longform-visuals-rfc.md);
`src/glass/serve.ts` is the working v0.6 seed this package productionizes.

## The bridge (`src/bridge/`, RFC §4)

One stateless-restartable Bun process on `:4180`:

- **`GET /plan`** — the enriched planned tracklist the glass loads on boot: the
  mixtape/plan members (public API, committed fixture fallback) each enriched with
  palette + seed (`props.json`) and the dream-replay scene (`composition.tsx`,
  resolved + classified by `scene.ts`, lifted from the glass seed). The bridge owns
  `/plan` here; the glass keeps its standalone copy on `:4173` for bridge-less mode,
  so **`:4180` takes precedence when the bridge is up**.
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
(`fingerprint.ts` → `mel.ts`: 40 log-mel bins 0-8kHz @ 10Hz, L2-normalized — the
same vector the glass streams); at show time the matcher scores a rolling ~22s
window against the **pending** (pointer+1) fingerprint and advances the pointer on a
confirmed, sustained match. A hybrid gate (margin-over-current **or** a high
absolute override) + sustain + min-dwell keeps the pointer monotone; the energy
dip→surge detector is the **pre-arm hint only** (never advances alone). **Manual
advance / rewind / goto always win, instantly.** Pure and unit-tested.

**Accuracy** (`bun run test:matcher-accuracy`, offline replay of the de-risk spike's
real set — mixtape 019.F.1A, 17 tracks; needs ffmpeg + the spike fixtures via
`FLUNCLE_ALIGN_FIXTURES=<dir>`, excluded from `bun test`): **12 of 14
fingerprintable transitions detected, perfect ordering, zero phantom / out-of-order
advances; 9/16 within ±30s of the hook**, the rest firing earlier at a long blend's
mix-in. The two genuinely-ambiguous tail tracks (where the outgoing preview outscores
the incoming one) fall to the manual nudge — the RFC's sanctioned override. Streaming
plan-scoped fingerprinting on near-identical liquid DnB is at its causal limit here
(the spike's cleaner numbers came from a batch global + monotonic-DP alignment, not a
causal one); the matcher's contract is a monotone, never-wrong-track pointer with the
nudge as the safety net, not a perfect auto-follow.

### The supervisor (`supervisor.ts`, RFC §3)

The out-of-process watchdog: no render heartbeat for >5s ⇒ relaunch the pinned
Chromium (`--app` kiosk, own profile, auto-update disabled; `open -na <app>` on
macOS via `FLUNCLE_CHROMIUM`). Every trip is logged; the OBS fallback scene covers
the relaunch seconds.

### Env

`FLUNCLE_PLAN_MIXTAPE` (default `019.F.1A`), `FLUNCLE_WEB_BASE`,
`FLUNCLE_FOUND_BASE`, `FLUNCLE_CHROMIUM`, `FLUNCLE_GLASS_URL`, `FLUNCLE_FFMPEG`.
