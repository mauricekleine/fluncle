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

The TypeScript placement and simulation authority is pinned by frozen golden fixtures under `apps/web/src/game/testdata/`; `golden-fixtures.test.ts` fails on drift. Regenerate those outputs through Vitest's V8 runtime while preserving fixture inputs; Bun's JavaScriptCore can differ by one unit in the last place for `Math.sin` and `Math.cos`, which breaks the exact comparison. Asset workflow (the canon ramp, the Nano-Banana pass, the procedural-fallback contract) is [docs/galaxy-sprites.md](./galaxy-sprites.md).

The carrier previews enter the Web Audio gain and pan graph through the same-origin `/api/preview` proxy so the graph can read them without third-party CORS failures. A missing preview stays silent while its star remains navigable.

The renderer draws on a 270px canvas and enlarges it by an integer scale so pixels and text stay crisp. It warms the canvas fonts before the first frame; HUD text is positioned from the measured cap height of `H`, since CSS font metric overrides can move Canvas's `top` baseline and strings without ascenders would otherwise jump. The gate plate uses alphabetic baselines before the HUD draws. Film texture is stronger over the world than over instruments so the readouts remain legible.

Fuel is the flight sim's only run-ending pressure: a dry tank drifts and tows the ship home, while asteroid hits spend fuel and black holes transport it with a survivable top-up. A tow preserves the lifetime log and rebuilds the same seeded frontier. Reaching every star only starts the flight home when the run logged at least one new star; a returning player with a complete lifetime log cannot win merely by spawning beside Earth.

A signed-in progress merge accepts at most 10,000 distinct Log IDs per request, after trimming and deduplication. The caller controls this list, so the per-hour request limiter alone cannot bound one merge; overflow rejects the entire merge rather than silently dropping progress. The server resolves and writes IDs in bounded SQL batches, and only certified findings can be collected.

## The atlas

**C** toggles the atlas in flight (C or Esc closes it): a full-screen top-down map of the voyage — the in-game chart and the demo surface in one, because the map shows the archive's growth inherently: with every new finding, the galaxy grows.

- **One curve, one source of truth.** The map draws `spiralPoint` from `placement.ts` — the exact function `placeStars` places with — so the thread and its stars cannot drift apart. `placement.test.ts` pins the invariant (a placed star's `x/y/radius` equal `spiralPoint(θ)`/`spiralRadius(θ)` bit-for-bit).
- **The read.** The spiral is a dim warm line from Earth's clear-space edge to just past the frontier tip (marked with a quiet gold diamond). Earth keeps the radar's blue idiom at center; the ship is a cream chevron along its heading. A star logged this run is a small bright cream mark, a star only in the signed-in lifetime log a quieter cream fill (map knowledge carries across deaths), and an uncharted star a dim hollow gold ring.
- **The readout.** The star under the pointer (or, keyboard-only, the star nearest the ship) gets a log-card chip: its `fluncle://` coordinate in Oxanium plus the Artist — Title line. A corner caption tells the growth story deadpan: `142 findings · day 0–37 of the voyage` (the day numbers are the Log ID's own day-sectors).
- **The rules.** Opening the chart freezes the sim (a map read never burns fuel) but not the audio — it is an instrument, not a pause; while it is up, keys steer nothing. The view is a static zoom-to-fit (whole spiral plus the ship, with margin); there is no pan/zoom easing, and the only motion — the close-hint blink — stills under reduced motion. The atlas is keyboard-only; touch play never sees the hint lines.

The pure geometry (`atlas.ts`) is unit-tested in `atlas.test.ts`; the drawing lives with the rest of the renderer in `render.ts`.
