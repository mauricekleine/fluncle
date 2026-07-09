# Fluncle's Galaxy — the game

`/galaxy` (also `galaxy.fluncle.com`) is the flight through Fluncle's Findings: every banger is a star placed at its Log ID coordinate, and you fly a first-person cockpit out from Earth to log them all. A client-only Canvas app — the route boots it via a dynamic import in `useEffect`, the server never touches browser APIs, the bundle stays light.

## The shape

```
apps/web/src/game/
  placement.ts   # the voyage spiral: Log-ID day-sector → θ on ONE Archimedean thread (spiralPoint
                 # is the exported curve); frontier seeding (set-dressing, black holes, asteroids)
  sim.ts         # the fixed-step flight sim (pure state-in/state-out; fuel is the one true stake)
  atlas.ts       # the pure math behind the atlas (zoom-to-fit, mark states, the caption)
  render.ts      # the 270p pixel renderer: cockpit view, HUD, gate/pause/end plates, the atlas
  game.ts        # the conductor: catalogue load, master phase, the loop, events → audio/telemetry
  input.ts       # keyboard + touch (arrows/AD steer, space boosts, M mute, C atlas, Esc pause)
  audio.ts       # the synth bed + carrier audio; progress.ts syncs the signed-in lifetime log
  sprites.ts     # procedural sprites; curated PNGs in public/galaxy/ override on load
apps/web/src/routes/galaxy.tsx   # the route
```

The placement and sim are pinned by frozen golden fixtures under `apps/web/src/game/testdata/`, and `golden-fixtures.test.ts` fails on any drift. (These were once the shared golden with a Go port of the sim that ran in the SSH terminal; that terminal game has been retired, so the fixtures now live in `apps/web` as the sole home of the TypeScript authority.) Asset workflow (the canon ramp, the Nano-Banana pass, the procedural-fallback contract) is [docs/galaxy-sprites.md](./galaxy-sprites.md).

## The atlas

**C** toggles the atlas in flight (C or Esc closes it): a full-screen top-down map of the voyage — the in-game chart and the demo surface in one, because the map shows the archive's growth inherently: with every new finding, the galaxy grows.

- **One curve, one source of truth.** The map draws `spiralPoint` from `placement.ts` — the exact function `placeStars` places with — so the thread and its stars cannot drift apart. `placement.test.ts` pins the invariant (a placed star's `x/y/radius` equal `spiralPoint(θ)`/`spiralRadius(θ)` bit-for-bit).
- **The read.** The spiral is a dim warm line from Earth's clear-space edge to just past the frontier tip (marked with a quiet gold diamond). Earth keeps the radar's blue idiom at center; the ship is a cream chevron along its heading. A star logged this run is a small bright cream mark, a star only in the signed-in lifetime log a quieter cream fill (map knowledge carries across deaths), and an uncharted star a dim hollow gold ring.
- **The readout.** The star under the pointer (or, keyboard-only, the star nearest the ship) gets a log-card chip: its `fluncle://` coordinate in Oxanium plus the Artist — Title line. A corner caption tells the growth story deadpan: `142 findings · day 0–37 of the voyage` (the day numbers are the Log ID's own day-sectors).
- **The rules.** Opening the chart freezes the sim (a map read never burns fuel) but not the audio — it is an instrument, not a pause; while it is up, keys steer nothing. The view is a static zoom-to-fit (whole spiral plus the ship, with margin); there is no pan/zoom easing, and the only motion — the close-hint blink — stills under reduced motion. The atlas is keyboard-only; touch play never sees the hint lines.

The pure geometry (`atlas.ts`) is unit-tested in `atlas.test.ts`; the drawing lives with the rest of the renderer in `render.ts`.
