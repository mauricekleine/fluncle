# Earth — the top-down overworld

`/earth` is Fluncle's top-down overworld game: the **ground Fluncle left from**. The galaxy game (`/galaxy`) is first-person among the stars; Earth is the ground under that sky, walked top-down (Pokémon-on-a-Game-Boy-Color, in the Nostalgic Cosmos). Every device you bump is a **door into a real Fluncle surface**, and the rocket on the northern launch pad is the door into the Galaxy game. *"We have the sky but not the ground"* — now both, joined.

Built per [docs/earth-overworld-rfc.md](./earth-overworld-rfc.md). A client-only Canvas app, the same shape as the galaxy game (`apps/web/src/game/*`): the route boots it via a dynamic import in `useEffect`, the server never touches browser APIs, the bundle stays light.

## The shape

```
apps/web/src/game/earth/
  palette.ts     # the canon ramp (../palette) + a minimal warm-dark soil band
  sprites.ts     # the shared INK table + makeSprite + the player + ground/void tiles
  camera.ts      # the follow-camera (pure, unit-tested)
  world.ts       # the hub-and-spokes overworld terrain + REGION_BOXES (pure, unit-tested)
  grain.ts       # the full-frame grain + scanline pass (the Light-Years Rule)
  input.ts       # keyboard input (consume-once edges + held movement)
  audio.ts       # the quiet all-synth ambient bed + SFX (gesture-gated, M-mute)
  game.ts        # createEarth(container, { onEnterDoor }) → { destroy, resume }
  registry.ts    # auto-registers regions/*.ts (import.meta.glob) → DOORS + prop sprites
  regions/
    _shared.ts   # the RegionModule + DoorDef contract
    workshop.ts  edge.ts  landing.ts  comms.ts  launch.ts   # one file per region (pure data)
  cards/
    _types.ts _chrome.tsx        # CardProps + the shared card bodies
    surface-card.tsx             # the generic card that reads @fluncle/registry
    registry.tsx                 # auto-registers cards/*.tsx (import.meta.glob)
    workshop.tsx comms.tsx landing.tsx launch.tsx   # one file per region's custom cards
apps/web/src/routes/earth.tsx    # the route: boots the game, renders the door overlay, noscript
```

The engine adds exactly **one** thing the galaxy game doesn't have — a **camera** — and otherwise re-expresses the galaxy's own primitives top-down: the PNG-or-procedural sprite contract, the canon palette, the integer-upscale fit, the reduced-motion gate, and (available, not yet wired) the server-side Log-ID progress store (`apps/web/src/game/progress.ts`).

## Doors → surfaces

Every door opens one of three things:

- **An owned surface** — `surface: "<name>"` where `<name>` is a [`@fluncle/registry`](../packages/registry/src/index.ts) surface (e.g. `web.log`, `subdomain.onion`, `mcp.server`). The generic `SurfaceCard` reads the URL + blurb straight from the registry, so a door never hardcodes a URL or drifts from canon. This is the single source of truth (#165).
- **A custom card** — `card: "<id>"` for anything the registry doesn't carry: the recovered SSH terminal, the social channels (Spotify/Telegram/YouTube/Instagram, from `apps/web/src/lib/fluncle-links.ts`), the gated clients (mobile, Lens, Discord), and the rocket's launch card.
- The **rocket** is just a custom card whose body is a typed `<Link to="/galaxy">` — the galaxy's own boot sequence is "Earth falling away", so the link *is* the launch.

## Adding a door (the runbook)

The whole point of the auto-registration: **adding a region or a door is adding a file** — no shared file is edited, so this fans out across agents without collisions.

1. **A new region** → add `regions/<id>.ts` exporting `export default { id, props, doors }` (copy `regions/workshop.ts`). Place its doors inside its `REGION_BOXES.<id>` tile box (`world.ts`). Prop ids must be globally unique — prefix them `<id>_`.
2. **The sprites** are pure char-grids drawn through the shared `INK` table (`sprites.ts`); `'.'`/`' '` is transparent. Keep a prop ~14–22px wide, rows equal length; it anchors bottom-center and draws upward. A curated PNG at `apps/web/public/earth/<prop>.png` overrides the procedural sprite on load (the galaxy contract, [docs/galaxy-sprites.md](./galaxy-sprites.md)) — that is the Gemini sprite-pass lever.
3. **Owned-surface doors** need no card — `surface: "<registry name>"` renders the generic `SurfaceCard`. **Custom doors** add `cards/<id>.tsx` exporting `export const cards: CardEntry[]` of `{ Card, id }` (named function components; copy `cards/workshop.tsx`), and reference it with `card: "<id>"`.

## The rails (canon)

- **Palette:** the canon ramp only (`sprites.ts` `INK` samples `palette.ts`). Gold marks the doors/goal only, ≤10% of any view (One Sun Rule). Warm-dark everything (Warm Dark Rule). Cool hues (`coolBlue`/`coolTeal`) only as a sparing accent, never a field (Retint Rule) — the CRT terminal is cream-on-warm-dark with a dim-teal phosphor ghost, **not** a green wash.
- **Light-Years:** a full-frame grain + scanline pass (`grain.ts`) over every frame, never baked into a sprite.
- **Reduced-motion:** the engine freezes ambient motion (grain crawl, the step-bob, the prompt caret) while keeping player movement.
- **Voice (every card word):** sentence case; no exclamation marks; no em dashes; no emoji; "surface" never "room"; said-not-written; verbs un-costumed.
- **A11y:** card text holds AA over the grain (opacity is the lever, not dimmer text); a gold focus ring; Esc closes; the `<noscript>` degrades to a link list of the real surfaces.

## Tests

`camera.test.ts` (clamp + follow) and `world.test.ts` (terrain walkability, region-box bounds) cover the pure engine. Run `bunx vitest run src/game/earth` from `apps/web`.

## Remaining (launch-gated)

- The Gemini sprite pass (replace the procedural props with curated PNGs under `public/earth/`) — see [docs/galaxy-sprites.md](./galaxy-sprites.md).
- The route is `noindex` until launch; flip it + add an OG card (Remotion, `packages/media`, like the galaxy OG) when the game ships.
- The gated doors (mobile, Lens, Discord server) light up when each surface launches.
