# Fluncle Lens

A Chrome extension (Manifest V3) that surfaces the findings hidden across the web. It scans any page for `fluncle://XXX.Y.ZZ` coordinates (a finding's Log ID), turns each into a link to the finding's log page, and enriches it with a hover card pulled from the public API.

## What it does

- A content script scans visible text on every page for `fluncle://` coordinates and replaces each with a subtle gold-underlined link to `https://www.fluncle.com/log/<id>` (new tab, `rel="noopener noreferrer"`).
- Hovering a coordinate shows a card with the finding's metadata and quick actions (open in Fluncle, open in Spotify, copy the coordinate / web URL / `dig` / `ssh` command).
- The toolbar popup lists every finding on the current page with the same actions; the toolbar badge shows the count (capped at `9+`).
- The options page toggles scanning, hover cards, and the link target.

## Privacy

The lens scans locally. No page content, URL, DOM text, or browsing history ever leaves the browser. The only network call is a public read of a single finding by its Log ID, made only after a valid coordinate is detected on the page:

```
GET https://www.fluncle.com/api/v1/tracks/<id>
```

That is the sole entry in `host_permissions`. Page scanning is granted declaratively by the content script's `<all_urls>` match, so no broad host permission is requested for it — which keeps the install warning light. (The brief's fallback to optional host permissions isn't needed with this split.)

## Layout

```text
src/coordinate.ts   The regex + every derivation (web URL, dig, ssh, casing rules). One owner.
src/coordinate.test.ts  bun:test coverage for the regex and derivations.
src/api.ts          The one network call: GET /api/v1/tracks/<id>, narrowed to the fields shown.
src/content.ts      The lens: scan, linkify, dedupe marker, MutationObserver + debounce, hover cards.
src/content.css     Injected styles for the link + hover card (Nostalgic Cosmos, scoped to .fluncle-lens-*).
src/popup.ts/.html  Toolbar popup: lists the active tab's findings via a message to the content script.
src/options.ts/.html  Settings, persisted to chrome.storage.sync.
src/background.ts   Service worker: keeps the per-tab toolbar badge in sync.
src/ui.css          Shared popup/options styles.
src/settings.ts     chrome.storage.sync read/write + change subscription.
src/copy.ts         Every human-facing string, in Fluncle's voice, in one reviewable place.
src/types.ts        Shapes passed between content script, popup, and background.
src/fonts/          The bundled Oxanium woff2 (the brand display face) for popup + options.
manifest.json       MV3 manifest (source; copied into dist/).
icons/              The wired 16/32/48/128 PNGs the manifest loads (generated; see make-icons.sh).
icons-variants/     The three 128 store-icon candidates (a/b/c) for review.
store-assets/       The 1280×800 Web Store listing screenshots (1/2/3).
scripts/build.ts    bun build of the entry points + static-asset copy (icons, fonts) into dist/.
scripts/bundle.ts   Builds, then zips dist/ into the ready-to-upload web-store/ .zip.
scripts/make-icons.sh       Regenerates the icon variants + the wired set from the source art.
scripts/make-screenshots.sh Regenerates the 1280×800 store screenshots from the built CSS.
```

## Develop

```bash
bun run --cwd apps/extension build     # one-shot build → apps/extension/dist
bun run --cwd apps/extension dev       # rebuild on change
bun run --cwd apps/extension typecheck
bun run --cwd apps/extension test
```

Load it in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select `apps/extension/dist`.

## Package for the Chrome Web Store

```bash
bun run --cwd apps/extension bundle    # builds, then zips → apps/extension/web-store/fluncle-lens-<version>.zip
```

One command. It runs a fresh build and zips the **contents** of `dist/` (so `manifest.json` sits at the archive root) with the full icon set and fonts inside — then upload that `.zip` at `chrome.google.com/webstore/devconsole`. The icon set is part of the zip, so the store picks it up (an earlier upload missed the icon because it wasn't in the zip).

## Icons

```bash
bun run --cwd apps/extension icons     # → icons-variants/icon128-{a,b,c}.png + wires icons/ to the default
```

`scripts/make-icons.sh` (ImageMagick) regenerates three 128×128 store-icon candidates from the source art and fans the chosen one (default `a`; pass `a`/`b`/`c`) out to the `16/32/48/128` set the manifest loads. Each candidate is 96×96 of art inside 16px of transparent padding (the store guideline):

- **a** — the cosmonaut mark on a gold-rimmed deep-field disc (clean brand coin; the wired default).
- **b** — a circular crop of the cover (eclipse + cosmonaut porthole).
- **c** — a rounded-square crop of the cover (album-tile read).

## Store screenshots

```bash
bun run --cwd apps/extension build && bash apps/extension/scripts/make-screenshots.sh
```

Drives headless Chrome over the extension's own CSS to capture three 1280×800 listing shots (24-bit PNG, no alpha) into `store-assets/` — so the shots can't drift from the product.

## A note on "signals"

The product idea was framed in "signals" language, but Fluncle's voice (VOICE.md) retires "signal" as identity — it belongs to the same radio metaphor as "transmission". A `fluncle://` coordinate is a **finding** (its Log ID), and the lens **finds** them. The copy speaks in that family throughout.
