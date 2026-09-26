# Discovery UX: baseline

The starting point for the programme in [README.md](./README.md), measured 2026-09-24 on production with the impeccable `critique` (Nielsen heuristics, 0–4 × 10) and `audit` (a11y, performance, responsive, theming, integrity, 0–4 each) playbooks, mobile Lighthouse, and scripted DOM probes at 1440×900 and 390×844. Every wave re-runs the same measurement so the scores below are the bar to beat.

## Scoreboard

| Page       | Nielsen /40           | Mobile LCP | One-line verdict                                                                                    |
| ---------- | --------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| `/`        | ~28 (25/36, help n/a) | 7.8 s      | On-canon lore page; the lead finding and the tiles are silent.                                      |
| `/search`  | 25                    | 6.1 s      | Honest and linkable; reads genre words as names.                                                    |
| `/tracks`  | 24                    | 4.1 s      | Good filter scaffolding; page 1 is 50 identical placeholder covers, hierarchy inverted, no readout. |
| `/artists` | 26                    | 6.2 s      | Solid A–Z and "Compare sounds"; opens on "0079", "1.8.7", "10365".                                  |
| `/albums`  | 24                    | —          | Covers carry it; tiles omit the artist; no A–Z lane.                                                |
| `/labels`  | 27                    | —          | Cleanest hub; the defining imprints are buried behind numerals.                                     |
| `/fresh`   | 24                    | 7.6 s      | Best "what's new" signal; off the shared plate; four display-size rows from one EP.                 |

Technical audit: **15/20 (Good)** — accessibility 3, performance 2, responsive 3, theming 4, integrity 3. Lighthouse mobile: performance 67–79, accessibility 96–100. The impeccable detector found **0** anti-pattern hits: the identity is specific and coherent. **What is weak is the discovery loop** — see a thing, hear it, follow the thread — which was never wired into the list pages.

## The headline measurement: taps to hear a track

**0 play controls and 0 `<audio>` elements on all 7 pages**, at both sizes. The shared player (`apps/web/src/lib/preview-player.ts`) is mounted only on the track and log pages and the workstations (`/mix`, `/recommendations`, `/chat`).

| From                                    | Path to sound                                                             | Taps     | Keeps your place?         |
| --------------------------------------- | ------------------------------------------------------------------------- | -------- | ------------------------- |
| `/` lead finding or a tile              | → `/log/<id>` → Play                                                      | 2        | No                        |
| A row on `/tracks`, `/search`, `/fresh` | → `/track/<id>` → Play                                                    | 2 + back | No (scroll and page lost) |
| The top rows of `/tracks`               | future-dated releases; the track page has no preview and no outbound link | —        | Dead end                  |
| `/artists`, `/albums`, `/labels`        | → entity page → a track → Play                                            | 3+       | No                        |

**Orphaned audio (verified):** a preview started on a track page keeps playing after navigating to `/tracks`, and no control anywhere can pause it.

## Ten highest-leverage problems

1. **Nothing on the discovery pages plays.** Two taps and a page load to hear anything.
2. **Preview audio is orphaned** across navigation with no visible transport.
3. **No way in by feel.** Search resolves "liquid", "jungle" and "dark neurofunk" as names; "chilled liquid 174" returns nothing. `/tracks` offers year, key, label and an unexplained "galaxy"; no sort.
4. **The hubs open on the long tail.** `/artists`, `/albums`, `/labels` are A–Z only, although track counts and findings exist to order by.
5. **Track rows drop the readout** (duration, BPM, key, year) on `/tracks`, `/search`, `/fresh` and the front-door tiles — DESIGN.md's Readout Rule.
6. **Page 1 of `/tracks` looks dead:** identical placeholder covers, the title quieter than the credit links, future-dated rows first.
7. **Five track-row implementations** that disagree on what is clickable, the date format, the trailing mark and the cover rule. Only `components/track-row.tsx` (on `/findings`) matches DESIGN.md.
8. **Small, split hit targets.** The `/tracks` row link is a 19 px title; Lighthouse `target-size` fails; the capture finds 218 of 218 visible mobile interactive targets under 44 px in at least one dimension.
9. **Wayfinding dead ends.** Hubs link to each other only through the footer (four different footer pairs); search stops at ~13 results with no "see all"; `/albums` has no letter lane; `/fresh` has its own date format and no plate.
10. **Mobile performance.** LCP 6.1–7.8 s; 56 KB of render-blocking CSS; ~160 KB of unused JS per page; Cover Art Archive and Spotify 640 px art served unresized into 36–110 px tiles (up to ~460 KB of savings on `/search`).

## Cross-page inconsistencies

| Aspect        | `/`                                  | `/search`         | `/tracks`       | `/artists` `/albums` `/labels` | `/fresh`                    |
| ------------- | ------------------------------------ | ----------------- | --------------- | ------------------------------ | --------------------------- |
| Track row     | `fd-finding` tile + `FreshStreamRow` | local `TrackRow`  | `TracksHubRow`  | —                              | `FreshStreamRow` + marquee  |
| Clickable     | whole tile                           | whole row         | **title only**  | whole tile                     | whole row                   |
| Readout chips | lead only                            | none              | none            | —                              | none                        |
| Date format   | `Sep 17`                             | none              | `Sep 25, 2026`  | —                              | `17 Sep` / `Sep 16`         |
| Unlit cover   | dimmed artist avatar                 | dimmed cover      | **placeholder** | —                              | dimmed artist avatar        |
| Masthead      | nameplate                            | title             | title + count   | title + count                  | giant "Fresh", **no plate** |
| Pagination    | link out                             | **none (capped)** | pager           | pager                          | **none (one long list)**    |

Site-wide: the palette's sr-only `H2` precedes every page's `H1`; there is no skip link; the top bar carries no route between hubs.

## Must be preserved

- The identity: the plate, the eclipse backdrop, the One Sun budget, the Unlit Rule's silence (no tier badges or nouns), GraphLink and its hover cards, Fluncle's voice on lore pages.
- URL-owned state everywhere, server-rendered answers, aria-live matchlines, and distinct honest empty / miss / failed states.
- The front door's long-scroll grammar (`components/front-door/section.tsx`) and the lead-finding presentation — make them playable, don't redesign them.
- Bounded previews through `/api/preview`; full listening concludes outbound.

## Re-running it

Run `bun run ux:capture -- --base https://www.fluncle.com --out /tmp/fluncle-ux-capture` from the repo root, then read `/tmp/fluncle-ux-capture/summary.md`. The command captures the ten discovery URLs at desktop and mobile sizes, saves viewport and full-page screenshots with per-page metrics JSON, probes taps to sound and orphaned audio, and runs mobile Lighthouse on `/`, `/search?q=liquid`, `/tracks`, `/artists`, `/albums`, `/labels`, and `/fresh`. Use `--pages /,/tracks` to narrow the URL list or `--no-lighthouse` for a faster browser-only run. Failed pages and probes remain in the summary as failures, with reasons in `metrics.json` and the per-page JSON. Lighthouse runs through pinned `bunx lighthouse@13.5.0` and requires local Chrome; its JSON is saved beside the screenshots. Every browser context and Lighthouse run blocks the Simple Analytics script, so a capture against production records no pageviews or discovery events. The pure report tests run under the scripts suite and never contact the network.
