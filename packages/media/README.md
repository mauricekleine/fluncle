# @fluncle/media

Reusable **image-asset** rendering for Fluncle. Where [`@fluncle/video`](../video/README.md) renders per-track motion clips, this package renders **stills** — link-preview cards, static covers, and other one-frame brand images — through the same Remotion toolchain. Each asset is a Remotion `<Still>` rendered to a checked-in file via `renderStill`. Read [DESIGN.md](../../DESIGN.md) (the Nostalgic Cosmos visual canon) and [VOICE.md](../../VOICE.md) (the copy canon) before authoring or editing an asset; this README does not duplicate that doctrine.

## The first asset: the Galaxy OG card

`src/remotion/galaxy-og.tsx` is the Open Graph / link-preview card for the `/galaxy` route (1200×630). It is a gate screen in the Nostalgic Cosmos: a warm near-black Deep Field ground, a single Eclipse-Gold banger-diamond (the One Sun, the game's star motif) with a soft Eclipse-Glow halo, a quiet seeded starfield, the `FLUNCLE'S GALAXY` brand mark in Oxanium caps, the tagline _Every banger out there is a star._ in Starlight Cream, and a grain + scanline wash over the whole frame (the Light-Years Rule). It obeys the canon in code: One Sun (exactly one gold light, ~10% of the frame), Warm Dark (no cold black, no rival gradient), Light-Years (grain + scanlines always on).

It renders to `apps/web/public/galaxy/og.png`, which is a **committed static asset** — it is NOT built at deploy time. The `/galaxy` route's `head()` points `og:image` at `/galaxy/og.png`. Regenerate and commit it when the card's design changes.

## Social banners & covers

`src/remotion/cosmos-banner.tsx` is the shared banner/cover for the social profiles — one `CosmosBanner` renders the **floating cosmonaut** (`public/fluncle-cosmonaut.png`, the founding figure) against a warm Deep Field cosmos (a single Eclipse-Gold sun, a seeded starfield, a grain + scanline wash) at any frame size. Banners are **wordless** — the platform shows the channel name as text, and the `FLUNCLE` wordmark lives on the cover art, not here. Per-platform dimensions, formats, and safe areas live in `src/remotion/socials-specs.ts` — the single source of truth, shared by the registry (`root.tsx` maps it to `<Still>`s) and the render script.

The **safe-area contract**: platforms crop a banner differently across devices, so each spec's `safe` box is the centered region the platform always shows (YouTube's is just 1235×338 of its 2048×1152). The cosmonaut is sized off that box's height so the hard mobile crop still catches the figure, and the cosmos bleeds to the edges.

`bun run render:socials` writes the claimed accounts (`render: true`) to `docs/socials/banners/` — drop each straight into the platform's profile uploader. The current set: YouTube channel banner (2048×1152 PNG) and Mixcloud cover (2048×512 PNG). SoundCloud (2480×520) and X (1500×500) are wired in with `render: false` — previewable in Studio, written once those accounts exist. The Spotify playlist cover is the founding cover art, **not** generated here. The spec table + the brand asset map live in [docs/socials/README.md](../../docs/socials/README.md).

## Conventions (mirrors `@fluncle/video`)

- **Code-generated, deterministic.** Everything on screen is generated from code — CSS, SVG, transforms — so a render is reproducible from source alone. The bitmap exceptions are the fonts (Oxanium woff2 under `public/fonts`, byte-identical to the `apps/web` copies) and the cosmonaut cutout (`public/fluncle-cosmonaut.png`, Maurice's founding artwork — the one image we composite rather than re-draw). No `Math.random()` and no wall-clock time inside a composition; seed any procedural layer via Remotion's `random()`.
- **Tokens, not hex literals chosen by hand.** Colors come from [`@fluncle/tokens`](../tokens) (`colors.deepField`, `colors.eclipseGold`, …), which mirrors DESIGN.md.
- **ANGLE GL.** `remotion.config.ts` and the render script set `gl: "angle"` (Metal on Apple Silicon) so any WebGL-backed layer has a real headless context, matching `@fluncle/video`.

## Regenerate the OG card

Run from `packages/media` (or with `bun run --cwd packages/media …`). Use **bun**, never npm/pnpm/yarn.

```bash
bun run render:og        # bundles, selects GalaxyOg, renders apps/web/public/galaxy/og.png at 1200×630
bun run render:socials   # renders the claimed social banners/covers into docs/socials/banners/
bun run studio      # Remotion Studio — live scrub the asset while editing
bun run typecheck   # tsgo --noEmit, the quality check for any change here
```

Stills render headless through a Chromium that Remotion downloads on first run; `render:og` needs that browser available (the same toolchain `@fluncle/video` uses).

## Add another image asset

1. Author a self-contained composition at `src/remotion/<name>.tsx` (a named `React.FC`, fully code-generated, tokens from `@fluncle/tokens`, fonts from `./fonts`).
2. Register it as a `<Still>` in `src/remotion/root.tsx` with its `id`, `width`, and `height`.
3. Add a render script to `package.json` (mirror `render:og`: bundle → `selectComposition` → `renderStill` to the asset's committed destination), and document the command above.
