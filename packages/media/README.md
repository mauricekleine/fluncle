# @fluncle/media

Reusable **image-asset** rendering for Fluncle. Where [`@fluncle/video`](../video/README.md) renders per-track motion clips, this package renders **stills** — link-preview cards, static covers, and other one-frame brand images — through the same Remotion toolchain. Each asset is a Remotion `<Still>` rendered to a checked-in file via `renderStill`. Read [DESIGN.md](../../DESIGN.md) (the Nostalgic Cosmos visual canon) and [VOICE.md](../../VOICE.md) (the copy canon) before authoring or editing an asset; this README does not duplicate that doctrine.

## The first asset: the Galaxy OG card

`src/remotion/galaxy-og.tsx` is the Open Graph / link-preview card for the `/galaxy` route (1200×630). It is a gate screen in the Nostalgic Cosmos: a warm near-black Deep Field ground, a single Eclipse-Gold banger-diamond (the One Sun, the game's star motif) with a soft Eclipse-Glow halo, a quiet seeded starfield, the `FLUNCLE'S GALAXY` brand mark in Oxanium caps, the tagline _Every banger out there is a star._ in Space Grotesk (the body face — Oxanium never sets a sentence) in Starlight Cream, and a grain + scanline wash over the whole frame (the Light-Years Rule). It obeys the canon in code: One Sun (exactly one gold light, ~10% of the frame), Warm Dark (no cold black, no rival gradient), Light-Years (grain + scanlines always on).

It renders to `apps/web/public/galaxy/og.png`, which is a **committed static asset** — it is NOT built at deploy time. The `/galaxy` route's `head()` points `og:image` at `/galaxy/og.png`. Regenerate and commit it when the card's design changes.

## Social banners & covers

`src/remotion/cosmos-banner.tsx` is the shared banner/cover for the social profiles — one `CosmosBanner` renders the **floating cosmonaut** (`public/fluncle-cosmonaut.png`, the founding figure) against a warm Deep Field cosmos (a single Eclipse-Gold sun, a seeded starfield, a grain + scanline wash) at any frame size. Banners are **wordless** — the platform shows the channel name as text, and the `FLUNCLE` wordmark lives on the cover art, not here. Per-platform dimensions, formats, and safe areas live in `src/remotion/socials-specs.ts` — the single source of truth, shared by the registry (`root.tsx` maps it to `<Still>`s) and the render script.

The **safe-area contract**: platforms crop a banner differently across devices, so each spec's `safe` box is the centered region the platform always shows (YouTube's is just 1235×338 of its 2048×1152). The cosmonaut is sized off that box's height so the hard mobile crop still catches the figure, and the cosmos bleeds to the edges.

`bun run render:socials` writes the claimed accounts (`render: true`) to `docs/socials/banners/` — drop each straight into the platform's profile uploader. The current set: YouTube channel banner (2048×1152 PNG), Mixcloud cover (2048×512 PNG), SoundCloud header (2480×520 PNG), and Twitch banner (1200×480 PNG). X (1500×500) is wired in with `render: false` — previewable in Studio, written once that account exists. The Spotify playlist cover is the founding cover art, **not** generated here. The spec table + the brand asset map live in [docs/socials/README.md](../../docs/socials/README.md).

## The mobile app icon

`src/remotion/app-icon.tsx` is the mobile app icon (`apps/mobile`) — one `<AppIcon>` composition rendered at the 1024² master size, parametrized by `variant` so it renders every candidate. The candidate set lives in `src/remotion/app-icon-specs.ts` (id + slug + variant + rationale), shared by the registry (`root.tsx`) and the render script. The **live candidates are the existing brand mark — the drifting traveler** (`public/fluncle-cosmonaut.png`, the founding figure), composited onto three canon backgrounds: **traveler** (plain Deep Field), **traveler-stars** (the quiet starfield — the site avatar's vibe), **traveler-glow** (a faint warm eclipse halo behind the figure). The figure is scaled from its measured alpha bounding box (398×488 inside the 1180² cut) to ~72% of icon height and re-centred on the figure, so it reads as a figure at 60px — the raw cut's ~41% figure height is exactly why the site avatar is unusable as an icon as-is. Four invented marks (eclipse / stamp / cover / diamond) remain as exploration. Every variant fills an opaque Deep Field ground (iOS rejects alpha), bakes **no** rounded corners (iOS/Android apply their own mask), and keeps load-bearing content inside a central safe zone.

`bun run render:app-icons` renders each candidate to `out/app-icon/icon-<slug>.png` — `out/` is gitignored, so these are **throwaway working stills**, not committed assets.

**The pick is resolved (operator, 2026-07-12): variant `traveler` — the figure on plain Deep Field.** The production set lives in `MOBILE_ASSET_SPECS` (same specs file): `bun run render:mobile-assets` renders the picked icon master (`icon.png`, opaque), the Android adaptive-icon foreground (`adaptive-icon.png`, transparent, figure at 58% for Android's tighter adaptive mask), and the splash mark (`splash-icon.png`, transparent, the traveler small over an edge-faded starfield) into `apps/mobile/assets/` — **committed** files referenced by `apps/mobile/app.config.ts` (`icon`, `android.adaptiveIcon`, the `expo-splash-screen` plugin's `image`). Icon + splash are NATIVE assets: regenerating them needs a native rebuild (`expo run:ios` / a new EAS build), not a JS reload.

## Conventions (mirrors `@fluncle/video`)

- **Code-generated, deterministic.** Everything on screen is generated from code — CSS, SVG, transforms — so a render is reproducible from source alone. The bitmap exceptions are the fonts (Oxanium + Space Grotesk woff2 under `public/fonts`, byte-identical to the `apps/web` copies) and the cosmonaut cutout (`public/fluncle-cosmonaut.png`, Maurice's founding artwork — the one image we composite rather than re-draw). No `Math.random()` and no wall-clock time inside a composition; seed any procedural layer via Remotion's `random()`.
- **Tokens, not hex literals chosen by hand.** Colors come from [`@fluncle/tokens`](../tokens) (`colors.deepField`, `colors.eclipseGold`, …), which mirrors DESIGN.md.
- **Both brand faces are EMBEDDED, with their metric overrides.** `src/remotion/fonts.ts` loads Oxanium (display: brand marks, and every numeral/coordinate/date) and Space Grotesk (body: reading text, titles, labels — max weight 700, its axis ceiling), each carrying the One Box `ascent`/`descent`/`line-gap` overrides from DESIGN.md §3 so the two faces sit on one optical centre line. This is the **Canon Travels Rule**: a render environment has no system fonts and no stylesheet to cascade from, so it must embed the faces itself. Never set text here in a bare `sans-serif` — that resolves to Helvetica on a Mac and DejaVu Sans on a Linux box, and the same committed asset ships in two different typefaces. Use `OXANIUM_STACK` or `SPACE_GROTESK_STACK`.
- **ANGLE GL — and it is load-bearing for the fonts.** `remotion.config.ts` and all three render scripts set `gl: "angle"` (Metal on Apple Silicon) so any WebGL-backed layer has a real headless context, matching `@fluncle/video`. It also keeps `@remotion/fonts`' `loadFont` viable: `loadFont` calls `new FontFace().load()`, whose Promise **never settles under the `swangle` software-GL renderer** (which is why `@fluncle/video` embeds its fonts as base64 `@font-face` CSS instead). There is deliberately no `FLUNCLE_GL` escape hatch here. **If you ever add a software-GL path to this package, move `fonts.ts` to the base64 pattern first** — otherwise the render hangs rather than fails.

## Regenerate the OG card

Run from `packages/media` (or with `bun run --cwd packages/media …`). Use **bun**, never npm/pnpm/yarn.

```bash
bun run render:og          # bundles, selects GalaxyOg, renders apps/web/public/galaxy/og.png at 1200×630
bun run render:app-icons      # renders the mobile app-icon candidates (1024²) into out/app-icon/ (gitignored)
bun run render:mobile-assets  # renders the PICKED icon + adaptive foreground + splash into apps/mobile/assets/ (committed)
bun run render:socials     # renders the claimed social banners/covers into docs/socials/banners/
bun run studio      # Remotion Studio — live scrub the asset while editing
bun run typecheck   # tsc --noEmit, the quality check for any change here
```

Stills render headless through a Chromium that Remotion downloads on first run; `render:og` needs that browser available (the same toolchain `@fluncle/video` uses).

## Add another image asset

1. Author a self-contained composition at `src/remotion/<name>.tsx` (a named `React.FC`, fully code-generated, tokens from `@fluncle/tokens`, fonts from `./fonts`).
2. Register it as a `<Still>` in `src/remotion/root.tsx` with its `id`, `width`, and `height`.
3. Add a render script to `package.json` (mirror `render:og`: bundle → `selectComposition` → `renderStill` to the asset's committed destination), and document the command above.
