# RFC: Earth — the top-down overworld

**Status:** Draft (research synthesized from 3 code-grounded threads + the landed spike; completeness standard applied) → Final on Maurice's decisions below.
**For:** an overnight build session — an orchestrator + a fan-out of worktree sub-agents (the `agent-orchestration` skill), running on the `earth-overworld` branch, not `main`.
**Canon/authority:** the codebase wins on every conflict. `DESIGN.md` (visual canon), the Voice canon (`packages/skills/copywriting-fluncle/references/voice.md`, which `VOICE.md` points at), `PRODUCT.md` (accessibility), `docs/galaxy-sprites.md` (the sprite pipeline), `apps/web/src/game/*` (the galaxy engine this rhymes with), and `apps/web/src/lib/fluncle-links.ts` (the single source of truth for every URL/handle). This doc is planning, not spec.

> Process note: three divergent read-only research threads (the full surface inventory; the galaxy-engine architecture + the bridge; the canon rails), grounded in the real files and folded in here. The spike at `apps/web/src/game/earth/*` + `apps/web/src/routes/earth.tsx` is Phase 0 — built, viewed, and approved; this RFC turns it into the whole game.

## The standard (definition of done)

Boil the ocean: the whole game, done right, with tests and docs, every thread tied off — the bar is "holy shit, that's done," not "good enough." Concretely:

- **Nothing is deferred or optional.** Every door in the map ships complete (a sprite, a placement, a canon-correct surface card). The decomposition below is _ordering a complete delivery_ across agents, not a menu to cut from.
- **Tests + docs are part of done.** The engine's pure units (collision, camera clamp, walkability, zone transitions, the door-proximity selector) get `*.test.ts` mirroring the galaxy game's existing tests (`apps/web/src/game/*.test.ts`). The game gets a short doc (`docs/earth-overworld.md`) and the route gets real `head`/OG metadata.
- **The only sanctioned "not now":** surfaces we genuinely don't control yet — the **mobile apps** (built, not submitted), **Fluncle Lens** (in Chrome Web Store review), and the **Discord server** (only the Hermes bot exists). These ship as honest _gated_ doors ("coming soon, from the workshop"), which IS complete for what we own. The **Gemini sprite pass** depends on the API key being placed (`~/.fluncle-gemini-key`); the procedural fallbacks ship regardless, so a missing key never blocks the build.
- **Tie off the spike's canon violations** (§8) as part of the build — they are in reach and known.

## 0. Summary — the reframe

- **The unifying simplification: the overworld reinvents almost nothing.** It re-expresses the galaxy game's own primitives in a top-down register — the **PNG-or-procedural sprite contract**, the **canon palette** (`apps/web/src/game/palette.ts`), the **integer-upscale fit**, the **reduced-motion gate**, and the **server-side, Log-ID-keyed progress store** (`apps/web/src/game/progress.ts`) — and adds exactly **one** genuinely new thing: **a camera.** Everything else is content.
- **The whole game is "doors to surfaces we already have."** Every device the player bumps is a door onto a real Fluncle surface (the SSH terminal, Spotify, the onion, the newsletter, …) — and the **rocket** is the one door that opens the _sky_: it launches the existing `/galaxy` game. So the build is overwhelmingly **per-door content** (a sprite + a surface card), which fans out cleanly to parallel agents over a thin shared spine.
- **Truly-coupled vs falsely-coupled.** Truly coupled and must land first: the **engine spine** (camera + multi-zone + grain/scanline + a11y) and the **door framework** (the surface-card system). Independent and parallelizable: **every door** (sprite + card + placement), the **rocket bridge**, the **audio layer**, the **Gemini sprite pass**. Two doors sharing the `earth/sprites.ts` file are _not_ coupled — they touch different sprite maps; agents coordinate by appending, and the orchestrator resolves the registry.
- **The bridge is free.** The galaxy's own boot sequence is _already_ "leaving home" — Earth falls away below the climbing ship (`render.ts` `drawBoot`). So a plain `<Link to="/galaxy">` from the rocket _is_ the launch beat; no shared canvas, no shared live state (the only durable shared state — logged bangers — already round-trips through `progress.ts`).
- **One catch the research already paid for:** the spike's bright green-phosphor terminal is off-canon (the Retint Rule strips phosphor green; cool survives only as a dim accent, never a field). Recolor to warm-dark + cream + a gold prompt, and let the **scanlines + a dim teal phosphor-ghost** carry the CRT feel (§8).

## 1. Context & goals

**Why now.** Fluncle's galaxy game is first-person among the stars; there is no top-down view of _the ground Fluncle left from_. The narrative gap — "we have the sky but not the ground" — is also a product opportunity: a single walkable surface that is a living map of **every** place Fluncle exists on the web, each reachable by walking up and pressing a key. It doubles as the "find Fluncle everywhere" surface map that `/status` gestured at ([[status-surfaces-flex]]).

**Goals (in reach this build):**

1. A scrolling, camera-follow top-down overworld at `/earth`, GBC-meets-cosmos, on the canon ramp, holding every canon rail (§8).
2. The complete device→surface map (§4) — every owned destination + iconic protocol surface as a door, gated doors honestly marked.
3. The rocket bridge into `/galaxy` (§5) and the return.
4. Audio, the Gemini sprite pass, tests, docs, a11y, SEO/OG — the completing slices.

**Honest calibration.** What we control: the game, the doors, the look, the bridge, the tests/docs. What we don't: whether the gated surfaces (mobile/Lens/Discord) go live — those ship as gated doors and light up the day each launches (the same pattern as the `/status` map). Scope ceiling is a real risk for one night (§Risks); the sequencing front-loads the spine so the game is _playable and shippable_ even if the long tail of doors isn't 100% complete by morning.

## 2. The spine (the engine) — lands first, the shared dependency

Today's spike is one fixed `14×11` screen drawn at `224×176` with **canvas coords == world coords and no camera** (`apps/web/src/game/earth/game.ts`). The spine grows it to a scrolling, multi-zone world. All changes are localized to `earth/game.ts` and `earth/room.ts`; reuse, don't fork, the galaxy primitives.

- **Camera-follow** (`earth/game.ts`): decouple the internal canvas from the map — a fixed `VIEW_W/VIEW_H` viewport (mirroring the galaxy's fixed `INTERNAL_HEIGHT = 270`, integer-upscaled with `image-rendering: pixelated`), a `camera = { x, y }` in the closure, lerped each frame to center the player and **clamped to the world bounds** (`clamp(player.x − VIEW_W/2, 0, WORLD_W − VIEW_W)`), eased with the galaxy's `ease` helper (`sim.ts`). `render()` wraps the world draw in `ctx.translate(-round(camX), -round(camY))`; `drawTiles()` iterates only the visible tile band (perf); `fit()` keys off the viewport, not the map.
- **Multi-zone world** (`earth/room.ts`): promote the single `MAP`/`DEVICES`/`SPAWN`/`isWalkable` exports to a data-driven `Zone` record `{ id, map, devices, spawn, edges }` and a `ZONES` registry (mirrors the galaxy's data+behavior-table philosophy). V1 ships **one large contiguous overworld** (the zones as spatial regions — see §4 layout); the `Zone`/edge model is in place so future _interiors_ (walk into the workshop → an interior surface) are data, not a re-architect. `isWalkable(zone, tx, ty)` and `zoneDims(zone)` become per-zone. Use **"surface"/"zone"**, never "room" (canon, §8).
- **The Light-Years pass** (new — the spike skipped it): a full-frame **grain + scanline** post-pass over the canvas every frame (the galaxy bakes this in `render.ts`; do the same here — never bake grain into a sprite). Tunable amount, boiling, present every frame.
- **Reduced-motion gate**: read `matchMedia("(prefers-reduced-motion: reduce)")` (as `render.ts:117` does) and **freeze ambient motion only** — grain-crawl, scanline-roll, the idle step-bob, any zone-transition fade — while **player movement stays live** (gameplay is not "motion").
- **Input**: extract the inlined key handling into `earth/input.ts` mirroring `game/input.ts`'s consume-once-edge + `state()` shape (it currently does not reuse the shared module). Add a **gold focus path** and a visible interact affordance. Keyboard is the floor; pointer/touch (tap-to-move or a d-pad) is a polish slice.
- **Zone transitions**: edge-warp rects (`{ rect, toZone, toSpawn }`) tested against the player's feet in `update`; on overlap, swap the active zone, reset to `toSpawn`, recompute `WORLD_W/H`, reclamp the camera, play a short `deepField`-alpha fade (the galaxy's `drawTowed` fade pattern). Device doors (the existing `nearest`/`onEnterSurface` flow) coexist: **edges move between zones, devices open surfaces.**

## 3. The door framework — lands first, alongside the spine

The spike's `SurfaceScreen` (`routes/earth.tsx`) is the seed. Generalize it into a **registry-driven surface-card system**: each `Surface` variant maps to a card component; the canon owns the card chrome; the per-door slices only add a variant + its copy.

- **The card chrome** (shared): warm-dark panel, cream ink, AA contrast held **over the grain** (the lever is panel opacity, not dimmer text — DESIGN.md's Legible Sky Rule), a gold focus ring, "esc — back to Earth" footer, keyboard-dismiss. Three card _shapes_ the research surfaced: the **terminal** (the SSH door — recolored, §8), the **link card** (a destination: a title, a said-not-written line, a gold CTA that _heats_ on focus — the Ignition Rule), and the **gated card** ("coming soon" for mobile/Lens/Discord).
- **Copy register** (every word passes the Voice canon, §8): the **Web register** (warm, quiet, in-fiction), the **Dry Rule** (no exclamation marks), **no em-dashes** (except `Artist — Title`), **sentence case**, **no emoji** (Telegram-only), **"surface" not "room"**, verbs un-costumed (never "beam up a track"), said-not-written. Use the canon vocabulary (banger, finding, Log ID, the Galaxy, the crew, selector; "Found Jun 4" dates).
- **URLs come from `fluncle-links.ts`** — every card imports the canonical constant (`spotifyPlaylistUrl`, `telegramUrl`, `onionUrl`, `galaxyUrl`, `siteUrl`, …); never hardcode a URL or handle in a card.

## 4. The device→surface map + the world layout

The doors, grouped by region. Status: **LIVE** (real card now) · **GATED** (coming-soon card; lights up at launch) · **BRIDGE** (routes to the galaxy). Props are the spike's GBC vocabulary; every surface URL resolves through `fluncle-links.ts`.

**Landing Site (spawn, center) — home & the log**
| Prop | Surface | Card | Status |
|---|---|---|---|
| Recovered logbook (the log plate) | `/log` — The Log | link | LIVE |
| Cover-art monolith / signpost | `/` — Fluncle's Findings (the archive) | link | LIVE |
| Notice board | `/about` | link | LIVE |

**The Workshop (west) — the machines**
| Prop | Surface | Card | Status |
|---|---|---|---|
| Green CRT | the SSH terminal (`ssh` the `rave` host) | **terminal** (recolored) | LIVE |
| Floppy / tower PC | the `fluncle` CLI (brew + npm) | link (install) | LIVE |
| Boombox | Spotify — "Fluncle's Findings" (`spotifyPlaylistUrl`) | link | LIVE |
| Turntable / record crate | `/mixtapes` | link | LIVE |
| Vintage radio | `radio.fluncle.com` (`/radio`) | link | LIVE |

**The Comms Mast (east) — the channels**
| Prop | Surface | Card | Status |
|---|---|---|---|
| Mailbox | the newsletter (subscribe; `newsletter.fluncle.com`) | link | LIVE |
| Pager / CB radio | Telegram `@fluncle` (`telegramUrl`) | link | LIVE |
| Camcorder / little TV | TikTok + YouTube (`tiktokUrl`, `youtubeUrl`) | link | LIVE |
| Robot NPC (walks, talks) | Hermes / Discord — meet the crew | gated (Discord server unbuilt; the bot is live) | GATED |
| Wall of polaroids | Instagram (`instagramUrl`) | link | LIVE |

**The Edge / Onion Patch (south) — the protocol surfaces**
| Prop | Surface | Card | Status |
|---|---|---|---|
| Giant onion | the Tor onion (`onionUrl`) — the archive over Tor | link | LIVE |
| Telephone switchboard | dig DNS (`dig.fluncle.com`) | link (the dig recipe) | LIVE |
| Server rack / fuse box (blinking) | `/status` — the monitoring board | link | LIVE |
| Little robot terminal | the MCP server (`/mcp`) — the archive as agent tools | link (for the machines) | LIVE |

**The Observatory / Launch Pad (north) — the sky**
| Prop | Surface | Card | Status |
|---|---|---|---|
| Telescope | a peek at the Galaxy (flavour + the galaxy link) | link | LIVE |
| Rocket on the pad | `/galaxy` — the Galaxy game | **bridge** (§5) | BRIDGE |

**Gated / future (placed in the workshop yard, locked)**
| Prop | Surface | Card | Status |
|---|---|---|---|
| Nokia 3310 | the mobile apps (App Store / Play) | gated | GATED |
| Magnifying glass / spectacles | Fluncle Lens (Chrome extension) | gated | GATED |

**Optional (low priority):** an "identity papers / passport" prop → the KG corroboration anchors (MusicBrainz/Wikidata/Last.fm/Discogs, the `sameAs` set). One card listing the claimed identities. Ship only if time allows.

**Layout.** One contiguous scrolling overworld in a hub-and-spokes shape: the Landing Site at center (spawn), the Workshop west, the Comms Mast east, the Edge south, the Launch Pad north (you _climb toward the sky_ — the rocket is the northern edge). Warm-dark ground paths connect the regions; the cosmos shows at the world's outer border (the spike's ground-island-in-the-starfield, scaled up). The feed/discovery surfaces (RSS, sitemap, OpenAPI, llms.txt, the calendar/podcast feeds) are **not** doors — they are machine discovery, not destinations; the `<noscript>` fallback (§Acceptance) links them for crawlers.

## 5. The rocket bridge (→ the Galaxy)

**Recommendation: a plain TanStack `<Link to="/galaxy">` from the React layer, fired by a new `rocket` device whose surface is a new `"galaxy"` variant.** No shared live game-state object (the engines are independent closures with different coordinate models; the only durable shared state — logged Log IDs — already round-trips through `progress.ts`, which `/galaxy` reads fresh on boot).

Files: add `rocket` to `DeviceKind` + `makeDeviceSprites()` (`earth/sprites.ts`); add `"galaxy"` to the `Surface` union + place the rocket in the Launch Pad zone (`earth/room.ts`); branch `surface === "galaxy"` in `SurfaceScreen` to a `LaunchCard` whose CTA is `<Link to="/galaxy">` ("take the rocket up"). On click, TanStack unmounts `EarthPage` → its effect cleanup runs `gameRef.current?.destroy()` → `GalaxyPage` mounts and boots into its gate. The galaxy's own boot _is_ the launch (Earth falling away).

**Optional polish (1-flag, additive):** give `/galaxy` a `validateSearch` for `?launch=1`; when set, `createGame` starts at `phase: "boot"` (skipping the gate) and resumes audio on the click-gesture (legal autoplay). The return loop is the inverse: a small "back to Earth" `<Link to="/earth">` on the galaxy end-screen.

## 6. Audio (Earth is currently silent)

The galaxy's thesis — _the only music in the galaxy is the findings_ — is first-person and stream-driven (`audio.ts`); Earth is the _ground_, pre-flight, so a different register fits: a quiet, loop-able **chiptune ambient bed** + synthesized **SFX** (a soft footstep tick, a door-open chime, the rocket ignition), all WebAudio-synth (no assets, like the galaxy's `blip()` SFX), gated on first gesture, mute-toggle (M) and reduced-motion/`prefers-reduced-motion` aware, and **suspended on tab-hide** (mirror `audio.ts`'s visibility handling). Ambient is off by default-respectful; SFX carry the feedback. This is one self-contained slice.

## 7. The Gemini sprite pass (the real props)

The PNG-or-procedural contract means this is pure upgrade with zero engine risk. For each device prop + the player (and tiles if wanted), run `packages/media/scripts/generate-galaxy-sprites.py` with `GEMINI_API_KEY` from the environment (read from `~/.fluncle-gemini-key`, never echoed/committed), the tight prompt recipe (8-bit NES pixel art, transparent bg, exact canon hexes, no text/shadow/grain, single warm light), quantize to the ramp, drop into `apps/web/public/earth/<name>.png` — it takes over on next load. **Taste-gate every sprite in a driven browser past hydration** (the onion is first in line — it reads balloon-y procedurally). This slice is **orchestrator-run** (needs the key + visual judgment), not a worktree agent.

## 8. Canon corrections to the spike (must-fix, folded into the build)

The spike was approved for _feel_; these are the canon rails it must meet to ship:

1. **Recolor the SSH terminal + CRT screen.** Drop the bright green-phosphor _field_. The terminal card: warm-dark (Tape Black) panel, **cream ink**, a **gold `$` prompt** (the one light), **scanlines** + a **dim teal (`coolTeal`) phosphor-ghost** as a sparing accent. The CRT sprite's screen uses `coolTeal`, not a bright phosphor. (Retint Rule: phosphor green arrives off-canon and _leaves_ in our hues.)
2. **Retire the off-ramp palette tokens.** `earth/palette.ts`'s `phosphor`/`phosphorDim` go (or redefine as `coolTeal`-derived). Re-evaluate the warm-dark `ground`/`groundDim`/`groundLit` tones: keep as a **minimal, deliberate warm-dark extension** bridging Tape Black→Cream Dim (on the Warm-Dark axis), **but get it canon-reviewed** — or derive the ground straight from Tape Black if review prefers strict-on-ramp. (Decision §D2.)
3. **Add the grain + scanline pass** (§2, the Light-Years Rule) — currently absent.
4. **Reduced-motion gating** (§2) — currently absent.
5. **Voice cleanup:** "surface"/"zone" never "room" (incl. consider renaming `room.ts`→`world.ts`); fix the onion card's em-dash; no exclamation marks; sentence case; no emoji; said-not-written; un-costume any verb on a control.
6. **A11y:** AA over the grain (opacity lever), gold focus ring, keyboard dismiss, a `<noscript>` that links the real surfaces (the doors map to real routes — degrade to a plain link list).
7. **Run the `canon-reviewer` agent** on the final UI/copy before merge to `main`.

## Sequencing & ownership (the overnight fan-out)

Branch **`earth-overworld`** (off `main`, with the spike + this RFC committed). The orchestrator pushes it; worktree sub-agents branch from the pushed tip and **PR into `earth-overworld`** (never `main`); the orchestrator reviews + merges each PR into the branch, ping-pongs to clean. **Nothing merges to `main` overnight** — a push to `main` auto-deploys, and the game ships to prod only after Maurice reviews in the morning ([[merge-without-asking-when-safe]] does not extend to a prod deploy of an unfinished surface).

1. **Pilot — the spine (§2) + the door framework (§3) + the canon corrections (§8).** One agent (or the orchestrator), landed and merged to the branch FIRST — it is the shared dependency; everything else builds on its `Zone`/camera/card APIs. De-risks the most. Includes the engine `*.test.ts`.
2. **Fan out the doors (§4)** — one agent per region (Workshop / Comms / Edge / Landing / gated-yard). Each adds its props' sprites (procedural), `Surface` variants, cards (voice-correct, URLs from `fluncle-links.ts`), and placements. Independent; they append to `earth/sprites.ts`/`room.ts`/the card registry — the orchestrator resolves registry merges.
3. **The rocket bridge (§5)** — one agent (depends on the door framework + a `/galaxy` `validateSearch` touch).
4. **Audio (§6)** — one agent, self-contained.
5. **Polish & close-out** — pointer/touch input, the OG card (Remotion, `packages/media`, like the galaxy OG), the route `head`/SEO, `docs/earth-overworld.md`, the `<noscript>` link list, a final `canon-reviewer` pass.
6. **The Gemini sprite pass (§7)** — orchestrator-run as PNGs land; taste-gated; can overlap everything (zero engine risk).

The critical path is **1 → (2,3,4 in parallel) → 5 → review**. The one thing that de-risks the most: land the pilot spine cleanly before fanning out, so no door agent is coding against a moving `Zone`/card API.

## Decisions needed BEFORE handoff

- **D1 — Terminal recolor.** Confirm §8.1 (warm-dark + cream + gold prompt + dim-teal phosphor-ghost + scanlines). Default if you don't say otherwise: yes, recolor.
- **D2 — Ground tone.** A minimal warm-dark `ground` extension (canon-reviewed) vs strict-on-ramp (ground = Tape Black + speckle). Default: minimal extension, canon-reviewed.
- **D3 — World shape.** One contiguous hub-and-spokes overworld (recommended) vs interior-zones-behind-edges from V1. Default: contiguous; zone model in place for later interiors.
- **D4 — Door set for the night.** Ship the full §4 map, or a named subset if the night is short? Default: full map; the sequencing keeps it shippable if the tail doesn't finish.
- **D5 — Rocket gate.** Skip the galaxy gate via `?launch=1` (drop straight into the boot) vs land on the gate. Default: skip — it reads as one launch.
- **D6 — Audio.** Quiet chiptune ambient + SFX (recommended, mute-able) vs SFX-only vs silent. Default: ambient + SFX.
- **D7 — Prop vocabulary.** The §4 props are a proposal (Nokia, boombox, switchboard…). Any you want swapped before the sprite work? Default: as listed.

## Acceptance criteria

- `/earth` is a scrolling camera-follow overworld; every §4 door opens its canon-correct card (or routes, for the rocket); gated doors show honest coming-soon cards.
- All canon rails hold: on-ramp palette, gold ≤10% / One Sun, grain+scanline pass, dark-only, reduced-motion freezes ambient (not gameplay), AA over the grain, gold focus ring, "surface"-not-"room", Dry Rule, no em-dash/emoji, said-not-written copy. `canon-reviewer` passes.
- The rocket launches `/galaxy` and a "back to Earth" link returns; logged-banger state (if used) reads through `progress.ts`, no new storage.
- `bun run --cwd apps/web typecheck` + `bunx oxlint --type-aware --deny-warnings` clean; engine `*.test.ts` cover collision, camera clamp, walkability, zone transitions, door proximity; `bun run --cwd apps/web build` succeeds.
- `docs/earth-overworld.md` written; the route has real `head`/OG; a `<noscript>` degrades to a link list of the real surfaces.
- Verified in a driven browser past hydration (screenshots): the overworld, a terminal card, a link card, a gated card, the rocket launch.

## Risks & open questions

- **Scope-in-one-night.** ~18 doors + spine + audio + Gemini is a lot. Mitigation: the spine lands first and the game is playable/shippable with any subset of doors; doors are independent, so partial completion is graceful, not broken.
- **Parallel agents converging / colliding** on `sprites.ts`/`room.ts`/the card registry ([[video-batch-diversity]] is the analogue). Mitigation: one region per agent, append-only, orchestrator resolves the registry; assign distinct props per agent at launch.
- **Worktree base drift** — sub-agents branch from the _pushed_ tip ([[worktree-agents-branch-from-origin]]); push the pilot before fanning out, or door agents won't see the `Zone`/card APIs.
- **Camera/tilemap perf** at a large world — cull to the visible band (§2), don't redraw the whole map.
- **The onion sprite** reads balloon-y procedurally — the Gemini pass is the fix; it's first in line.

## Appendix — sources

- Surface inventory: `apps/web/src/lib/fluncle-links.ts`, `apps/web/src/routes/*`, `docs/socials/README.md`, `docs/public-surfaces-checklist.md`, `apps/web/src/routes/status.tsx`, `docs/dig.md`, `docs/tor.md`, `docs/agents/*`.
- Engine + bridge: `apps/web/src/game/{game,render,sim,sprites,input,audio,palette,progress,placement}.ts`, `apps/web/src/routes/galaxy.tsx`, `apps/web/src/game/earth/*`, `apps/web/src/routes/api/me/galaxy-progress*`.
- Canon rails: `DESIGN.md`, `packages/skills/copywriting-fluncle/references/voice.md`, `PRODUCT.md`, `docs/galaxy-sprites.md`, `apps/web/src/game/palette.ts`.

---

## Handoff — the goal prompt (paste-ready)

> Build the Earth top-down overworld per `docs/earth-overworld-rfc.md`. Work on the `earth-overworld` branch (the spike + RFC are committed there); never push to `main`. Orchestrate per the `agent-orchestration` skill: first land the **pilot** — the engine spine (camera-follow, multi-zone `Zone`/`ZONES` model, the grain+scanline Light-Years pass, reduced-motion gating, `earth/input.ts`), the door-framework (registry-driven surface cards: terminal/link/gated shapes, voice-correct, URLs from `fluncle-links.ts`), and the §8 canon corrections (recolor the terminal off green; retire the off-ramp tokens; "surface" not "room"; a11y) — with engine `*.test.ts`. Then fan out worktree sub-agents, one per region, to build every door in §4 (sprite + card + placement), plus the rocket bridge (§5) and the audio layer (§6). Hold every canon rail (§8); run `canon-reviewer` before any merge. Keep `typecheck` + strict `oxlint` + `build` green. I (the orchestrator) run the Gemini sprite pass (§7) from `~/.fluncle-gemini-key` as PNGs land, taste-gated in a driven browser. Boil the ocean: the whole map, tests, `docs/earth-overworld.md`, OG/SEO, the `<noscript>` fallback. Stop and report at a playable, reviewed `earth-overworld` branch for Maurice to merge to `main` in the morning.
