# The Factory — a finding's life, made playable

`/factory` is Fluncle's assembly line: the **works** where a find is made. The galaxy game (`/galaxy`) is the sky and `/earth` is the ground; the factory is the underworld between them — the pipeline that turns a fresh find into a launched finding. A finding enters on the left, rides a **station per lifecycle step**, piles up in front of the slow machines, and a finished finding boards a ship and lifts off to the Galaxy. _Found → assembled → launched → collected._

Phase 1 (the public page) of the From-Earth-to-Orbit arc (see [docs/ROADMAP.md](./ROADMAP.md) "From Earth to Orbit"). A client-only Canvas app, the same shape as `/earth` and `/galaxy` (`apps/web/src/game/*`): the route boots it via a dynamic import in `useEffect`, the server never touches browser APIs, the bundle stays light.

## The shape

```
apps/web/src/game/factory/
  palette.ts     # the canon ramp (../palette) + a minimal warm-dark steel/belt band
  stations.ts    # the DATA SPINE — stationOf(finding) → 0..7, pure + unit-tested
  stations.test.ts
  sprites.ts     # the 8 procedural machines (one steel cabinet + a per-machine face) + the launch ship
  layout.ts      # the geometry (station x, belt y, slot x) shared by sim + renderer
  sim.ts         # the DOM-free engine: findings → tokens, belt motion, queue piling, launch
  audio.ts       # the quiet motor hum + a per-station clunk + the launch roar
  input.ts       # horizontal pan (drag + A/D + arrows), tap to inspect, Esc, M-mute
  game.ts        # createFactory(container, { onInspect, onLaunch }) → { destroy, setFindings }
apps/web/src/routes/factory.tsx   # the route: polls /api/tracks, boots the game, the inspect pane, noscript
```

It reuses `earth/grain.ts` (the Light-Years pass) verbatim and re-expresses the galaxy/earth primitives side-on: the PNG-or-procedural sprite contract, the canon palette, the integer-upscale fit, the reduced-motion gate, the gesture-gated audio lifecycle. The one new thing over `/earth` is a **1-D pan camera** (Earth follows a 2-D avatar; the factory is watched and scrolled).

## A renderer of true state

The factory is **not a cosmetic animation** — a finding's belt position is derived from its real pipeline state, the same public fields `/api/tracks` already carries. `stationOf()` (`stations.ts`) is the pure spine, the finer-grained sibling of `lib/server/track-stage.ts`:

| #   | Station         | The artifact that advances a finding past it                  |
| --- | --------------- | ------------------------------------------------------------- |
| 0   | intake          | `addedToSpotify && postedToTelegram` (the sync add)           |
| 1   | spectrograph    | `enrichmentStatus === "done"` (BPM, key, the spectral vector) |
| 2   | press           | `note` (the editorial note)                                   |
| 3   | booth           | `observationAudioUrl` (the spoken observation)                |
| 4   | render bay      | `videoUrl` (the footage — the slow one)                       |
| 5   | dispatch        | the first live link (`youtubeUrl ?? tiktokUrl`)               |
| 6   | address printer | both links back (`youtubeUrl && tiktokUrl`)                   |
| 7   | launch pad      | every artifact present → the finding launches into orbit      |

A finding rides to the station **after the last artifact it has** (furthest-reached, never parked on a skipped step — the async pipeline runs in parallel). So findings naturally **pile in front of the slow machines** (today: the address printer, where findings wait on the manual-TikTok link), and that pile _is_ the real backlog, made physical and honest.

## Realtime

**Poll-first, zero new infra.** The route polls `GET /api/tracks?limit=48` on a 15 s react-query `refetchInterval`, SSR-seeded so the first paint (and crawlers) get a populated line. The newest 48 captures every in-flight finding (older ones have already launched). A Durable-Object WebSocket is the later upgrade if true push earns it.

## The rails (canon)

- **Execute calm** (DESIGN.md). A moving conveyor is busy by nature, so the register is held the way `/earth` holds it: slow, dark, warm steel under one sky. Machines sit unlit; a station glows **gold only while it is working a finding** (so gold stays sparse and meaningful — the One Sun budget). The launch pad's beacon + horizon bloom are the one sanctioned gold field (the way up).
- **Cover-led.** A finding rides as its **cover art** in a small frame, so the line stays music-first; a cover that hasn't loaded falls back to the eclipse gold-to-red wash.
- **Light-Years:** the shared grain + scanline pass over every frame, frozen under reduced-motion along with the belt-slat drift, the working-light pulse, and the incoming chevrons.
- **Voice (every word):** sentence case, no exclamation marks, no em dashes, no emoji, said-not-written (the station copy in `stations.ts`, the inspect pane, the hint).
- **A11y:** the inspect pane holds AA on a dimmed plate; a focus ring; Esc closes; the `<noscript>` degrades to a link list of the surfaces the findings live on.

## Sprites

The 8 machines are **procedural placeholders** (`sprites.ts`) — one shared steel `cabinet()` with a consistent upper-left key light, distinguished by a per-machine face (funnel, spectrum screen, piston, mic, vented rack, dish, label slot, gantry). A curated `/factory/<id>.png` overrides any of them on load (the [galaxy-sprites](./galaxy-sprites.md) contract), so the Gemini pass can polish a machine later with zero code change.

## Tests

`stations.test.ts` covers the data spine (the field → station mapping, furthest-reached, the launch cap). Run `bunx vitest run src/game/factory` from `apps/web`.

## Remaining (launch-gated)

- The route is `noindex` and **not yet in `@fluncle/registry`** / the nav — like `/earth`, it lights up on launch (register the surface, flip noindex, add an OG card via `packages/media`).
- The Gemini machine-sprite pass (drop curated PNGs under `public/factory/`).
- Feel iteration (the brief's "ship scruffy but real, then iterate hard"): belt/queue density tuning, the new-finding "N incoming" treatment, and a Durable-Object WebSocket if push earns it.
- The later arc phases — per-track sprites, the collectable binder, public profiles — are tracked in [ROADMAP.md](./ROADMAP.md) under _From Earth to Orbit_.
