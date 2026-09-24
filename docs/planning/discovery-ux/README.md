# Discovery UX programme

A run of continuous UI improvements that makes seven public pages work like a true music-discovery platform while staying in the Nostalgic Cosmos: `/`, `/search`, `/tracks`, `/artists`, `/albums`, `/labels`, `/fresh`. This is a planning document under `docs/planning/`, never specification; PRODUCT.md, DESIGN.md and VOICE.md win wherever it disagrees, and anything that ships lands in canon and code, after which the matching section here is deleted.

- [research.md](./research.md) — market data, fan voices, platform teardown
- [personas.md](./personas.md) — Jade, Marcus, Priya, Dave (design for) and Tom (don't over-serve)
- [user-stories.md](./user-stories.md) — DX-01…DX-35, by epic, with done-when evidence
- [decisions.md](./decisions.md) — the operator's rulings from the design interview
- [baseline.md](./baseline.md) — impeccable critique + audit, Lighthouse, taps-to-sound, measured before any change

## The diagnosis in one line

The identity is strong (the impeccable detector finds nothing generic; every page scores "Acceptable" on Nielsen), but **the discovery loop — see it, hear it, follow the thread, keep it — was never wired into the list pages.** Nothing on the seven pages plays, the search can't hear feelings, the hubs open on the alphabet's long tail, and five different track rows disagree with each other.

## What makes this Fluncle's and nobody else's

These ideas come from the research, translated into the canon's own motifs rather than borrowed from a streaming app. Every ruling behind them is in [decisions.md](./decisions.md).

1. **The Discman** (internal codename). The cover art's figure floats up tethered to a Discman by a headphone cable. The persistent preview player is that object: a warm-dark bottom bar that appears on the first play and carries the sound across every page, with the queue position in Oxanium tabular (`4/30`). It is a player, not a transport: the page never advances because of it.
2. **Every list is a tape.** Play on any row queues the list around it, from the front door's findings to a label's releases, and it stops at the end with one way on. Lean-back for Priya, a quick scan for Marcus, and the page stays a scroll.
3. **The tether.** "More like this" opens the sonic view of any track and the player keeps a trail of seed covers, the headphone cable, so a rabbit hole is visible and walkable back.
4. **Styles the data taught us.** A style engine seeded from the Discogs styles Fluncle already stores and spread across the catalogue by sound, surfaced as a chip row Jade can tap without knowing a single subgenre word. Galaxies stay the lore map of findings, each with a plain sound line.
5. **A finite week.** `/fresh` counts weeks of releases, not rows, remembers in the browser where you got to, and says when you have heard it all.
6. **Hubs with a pulse.** Artists, labels and albums open on their weight, tiles play, albums name their artist, and a Browse menu joins the five hubs.
7. **Follow by email.** Following an artist or label is one magic-link email away and pays off in a weekly Friday digest, the email half of Marcus's ritual.

Bolder ideas held for Wave 7 (each needs a ruling first): moods and energy, a galaxy **Star Chart** to wander by ear, **Plot a Course** between two findings, and feel knobs on `/radio`.

## Waves

Each wave is a set of independent PRs from linked worktrees. A wave ships when its stories' done-when evidence is met on production and the baseline re-measure beats the previous numbers.

| Wave                               | Outcome                                                                                                                                                                                                                                                                                                                                | Stories            | Main files                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 · Ground                         | The baseline capture committed as a repo script; the style-seed spike (read-only, one production pull); `shape` briefs for the Discman, the unified row, the style chip row, the Browse menu and the `/fresh` release entry; DESIGN.md and PRODUCT.md amendments drafted.                                                              | —                  | `scripts/`, `DESIGN.md` §5, `PRODUCT.md`                                                                                                                                                                 |
| 1 · Hear it now                    | The Discman (queue, Media Session, one-sound rule); the unified row (play-on-cover, readout, unlit real covers, ⋮ menu, no date column, whole-row target) adopted everywhere a track list renders, detail pages included; the lead finding plays; future-dated releases held back.                                                     | DX-01–10           | `lib/preview-player.ts`, `components/nav/public-chrome.tsx`, `components/track-row.tsx`, `tracks-hub-row.tsx`, `fresh/shared.tsx`, `search/search-results-list.tsx`, `front-door/*`, `track-artwork.tsx` |
| 2 · Find it by feel                | The style engine and its nightly diff-only sweep; the style lexicon and guard test; the chip row on `/tracks`, `/search` and the front door; confident style chips on rows; the galaxy pill off `/tracks` and galaxy sound lines; live type-ahead on `/search`; "see all" handoffs; the tether; no-results that still hands you music. | DX-11–16           | `lib/search-results.ts`, `lib/server/search.ts` ([docs/search.md](../../search.md)), `routes/search.tsx`, `routes/tracks.tsx`, a new style sweep beside the cluster engine                               |
| 3 · A finite week                  | `/fresh` as week buckets of releases, standouts, since-last-visit, the end of the window, back on the plate.                                                                                                                                                                                                                           | DX-17–20           | `routes/fresh.tsx`, `components/fresh/*`                                                                                                                                                                 |
| 4 · Hubs with a pulse              | Most-tracks default with the "this month" strip and the Most tracks · Recently active · A–Z switch (with the latest-release column); album artist, year and letter lane; tiles that play; the top-bar Browse menu.                                                                                                                     | DX-21–25           | `routes/{artists,albums,labels}.index.tsx`, `catalogue-hub-section.tsx`, `catalogue-groups.tsx`, `components/nav/*`                                                                                      |
| 5 · Keep and follow                | Magic-link join and sign-in (password kept for existing accounts); Follow by email with the weekly digest sweep; local-first Save for any track; native share. Astra reviews the auth change.                                                                                                                                          | DX-28–30, DX-33–35 | `lib/server/public-auth.ts`, `lib/server/resend.ts`, save routes, a new digest timer under `docs/agents/hermes/`                                                                                         |
| 6 · Fast and accessible (parallel) | Mobile LCP ≤ 3.0 s on all seven; covers at tile size; render-blocking CSS and unused JS cut; heading order, skip link, label mismatches fixed.                                                                                                                                                                                         | DX-31–32           | `lib/media.ts` (`albumCoverAtSize`), `styles.css`, route chunks                                                                                                                                          |
| 7 · Out past the map               | Moods and energy, Star Chart, Plot a Course, radio knobs: each proposed with a `shape` brief and built only on ruling.                                                                                                                                                                                                                 | —                  | —                                                                                                                                                                                                        |

**Order and overlap.** Wave 0 first. Then Waves 1 and 6 run in parallel (disjoint files). Wave 2 starts once the spike clears its bar; Waves 3, 4 and 5 build on Wave 1's player and row, in that order, and Wave 5 goes last because it changes auth.

## The improvement cycle (every PR)

1. **Shape.** `impeccable shape` on the slice against the personas, stories and [decisions](./decisions.md).
2. **Build** in a linked worktree from the last pushed `main`.
3. **Measure on the preview.** Run the baseline capture script and `impeccable audit` + `impeccable critique` on the touched pages; attach the before/after numbers to the PR.
4. **Walk the personas.** A fresh-context agent plays each affected persona through their scripted scenario (below) on the preview at the persona's device size and reports taps, time, dead ends and confusion.
5. **Gate the canon.** `canon-reviewer` on every UI change; any public string drafted through `copywriting-fluncle` first, with the Flat Copy Test blocking.
6. **Independent review** from the other provider, fresh context (routing below).
7. **Merge, deploy, verify.** Autonomous once every gate passes, one PR at a time; PRs with bigger visual changes carry before/after screenshots; Workers Build watched to completion; the capture script re-run on production; `docs/user-stories.json` (the story × surface matrix, `bun run stories:build`) updated where support changed.

## Persona scenarios (the acceptance script)

Each becomes a Playwright journey in the E2E suite once its wave ships, so the loop can never silently break again.

- **Jade, 390×844, from `/`:** hear three different tracks within 60 seconds without leaving the page; find "something that sounds like the lead finding"; send one to Spotify.
- **Marcus, 1440×900, `/fresh`:** reach the end of this week's releases in under ten minutes; distinct releases at the top; copy a share link that unfurls; follow a label with one email and receive the Friday digest (Resend test mode).
- **Priya, 390×844, locked phone:** start a list from any shelf with one tap and let ten previews play straight through; pause from the Discman on a different page.
- **Dave, 1440×900, `/labels`:** reach a defining imprint in one click, hear three of its tracks from the tile or label page, reach a newer artist in two hops.
- **Tom, 1440×900, `/search`:** a half-remembered title resolves; the row shows BPM and key; the preview plays in place; the outbound buy/listen link is one tap.

## Measures

| Measure                                                        | Baseline               | Target                      | Source                                                                                                    |
| -------------------------------------------------------------- | ---------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Taps to first sound, per page                                  | 2–3+ (0 play controls) | 1 on all seven              | capture script DOM probe                                                                                  |
| Nielsen critique, per page                                     | 24–28 / 40             | ≥ 32 on every page          | `impeccable critique`                                                                                     |
| Technical audit                                                | 15 / 20                | ≥ 18                        | `impeccable audit`                                                                                        |
| Mobile LCP                                                     | 4.1–7.8 s              | ≤ 3.0 s                     | Lighthouse mobile                                                                                         |
| Lighthouse accessibility                                       | 96–100                 | 100 on all seven            | Lighthouse mobile                                                                                         |
| Previews per discovery session; similar hops; outbound listens | current funnel         | trending up after each wave | the aggregate `discovery_preview` / `discovery_similar` / `discovery_outbound` beacons on `/admin/funnel` |

## Routing

Following `mk-agent-orchestration`: this session (Opus 5.5) leads — decomposition, the shape briefs, integration, merges.

- **UI slices that carry canon or public copy** (the Discman, the unified row, `/fresh`, the hubs, galaxy sound lines): Claude executor (Opus 5.5 at medium effort), because the `copywriting-fluncle` and `canon-reviewer` gates need a Claude-capable executor.
- **Plumbing with an executable gate** (the capture script, image resizing, search-intent routing in the resolver, E2E journeys): GPT-6 Sol at high, or Luna at max for the exact-recipe pieces.
- **Review:** Sol at max for routine PRs; Astra for the Discman, the style engine and the magic-link auth change, since those decide whether the programme's keystones ship (auth changes always get independent review).
- **Persona walkthroughs:** fresh-context Claude agents, one per persona, never the agent that built the slice.

## Decisions

All ruled; see [decisions.md](./decisions.md). The programme reopens a ruling only when the operator does.
