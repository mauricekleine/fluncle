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
GET https://www.fluncle.com/api/tracks/<id>
```

That is the sole entry in `host_permissions`. Page scanning is granted declaratively by the content script's `<all_urls>` match, so no broad host permission is requested for it — which keeps the install warning light. (The brief's fallback to optional host permissions isn't needed with this split.)

## Layout

```text
src/coordinate.ts   The regex + every derivation (web URL, dig, ssh, casing rules). One owner.
src/coordinate.test.ts  bun:test coverage for the regex and derivations.
src/api.ts          The one network call: GET /api/tracks/<id>, narrowed to the fields shown.
src/content.ts      The lens: scan, linkify, dedupe marker, MutationObserver + debounce, hover cards.
src/content.css     Injected styles for the link + hover card (Nostalgic Cosmos, scoped to .fluncle-lens-*).
src/popup.ts/.html  Toolbar popup: lists the active tab's findings via a message to the content script.
src/options.ts/.html  Settings, persisted to chrome.storage.sync.
src/background.ts   Service worker: keeps the per-tab toolbar badge in sync.
src/ui.css          Shared popup/options styles.
src/settings.ts     chrome.storage.sync read/write + change subscription.
src/copy.ts         Every human-facing string, in Fluncle's voice, in one reviewable place.
src/types.ts        Shapes passed between content script, popup, and background.
manifest.json       MV3 manifest (source; copied into dist/).
icons/              16/32/48/128 PNGs, derived from the Fluncle cosmonaut mark.
scripts/build.ts    bun build of the entry points + static-asset copy into dist/.
```

## Develop

```bash
bun run --cwd apps/extension build     # one-shot build → apps/extension/dist
bun run --cwd apps/extension dev       # rebuild on change
bun run --cwd apps/extension typecheck
bun run --cwd apps/extension test
```

Load it in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select `apps/extension/dist`.

## A note on "signals"

The product idea was framed in "signals" language, but Fluncle's voice (VOICE.md) retires "signal" as identity — it belongs to the same radio metaphor as "transmission". A `fluncle://` coordinate is a **finding** (its Log ID), and the lens **finds** them. The copy speaks in that family throughout.
