# Three discovery concepts, held

Evidence for one decision: **which product model should govern Fluncle's public web when it becomes a drum & bass discovery platform** ([docs/planning/ROADMAP.md](../../planning/ROADMAP.md) § _The overhaul_). Three end-to-end concepts are built on one snapshot of real archive data so the thing that differs between them is the model and never the records.

**Nothing here is a recommendation.** No concept is proposed, ranked, or scored, and the branch is held unmerged. The comparison below states what each one buys and what it costs; the choice is the operator's.

Read them in the browser at `/concepts` (see _Running the exhibit_ below), or read the retained screenshots in [`evidence/`](./evidence).

---

## The three models

|                              | **A · Front page**                                                                           | **B · Desk**                                                                                            | **C · Run**                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Product model**            | Fluncle places, you read. Discovery is editorial placement.                                  | You ask, the archive answers. Discovery is filtering.                                                   | You travel. Discovery is a sequence with branches.                                   |
| **Information architecture** | A front page, then a page per record and a page per graph node. Hierarchy; depth is a click. | One persistent board. A direct arrival on an artist or a label IS that board, pre-filled. No sub-pages. | One stop at a time, a trail behind and branches ahead. No lists anywhere.            |
| **Interaction model**        | Navigation only. No controls, no client state, no URL state beyond the path.                 | Facets, chips, and a sonic seed. Every piece of state is in the URL.                                    | Transport. Keys and branch controls move you; a state transition carries the change. |
| **What answers "what next"** | An edited block Fluncle placed.                                                              | A predicate the visitor composed.                                                                       | A branch the lane offered.                                                           |
| **Shape of the surface**     | A document.                                                                                  | A tool.                                                                                                 | A player.                                                                            |

These are three different products, not three skins. A skin swap would leave the reading order, the URL space, and the set of gestures unchanged; each of these changes all three.

---

## What every concept holds constant

Held fixed on purpose, so the comparison is about the model:

- **The world.** Dark, warm, cover-led, one sun. The incumbent visual canon ([DESIGN.md](../../../DESIGN.md)) is unchanged and unextended: same palette, same two faces, same grain architecture, same elevation doctrine.
- **The data.** One capture, one row shape, one set of records (below).
- **Familiar music labels.** Artist, track, album, label, BPM, key, released, play. No concept asks a visitor to learn a word to use it.
- **No lore prerequisite and no sign-in.** Every journey below works for an anonymous stranger who has never heard of Fluncle. The fiction is present in the theme and in Fluncle's own written lines, never as a toll at the door — the level-1 / level-99 ladder from the overhaul's direction.
- **The Unlit Rule.** A record Fluncle certified carries a coordinate and may take Eclipse Gold. A record he has not is unlit, has no coordinate, and is **never named** — no badge, no heading, no noun. The distinction between broad archive utility and selective taste is carried by light and placement in all three, and by no word in any of them. `tests/e2e/concepts.spec.ts` asserts this mechanically.
- **Bounded or outbound listening only, and only where real evidence backs it.** Every listening control on every concept points at a URL the archive actually holds (Spotify, Apple Music, YouTube). A record with none gets no control rather than a dead one. Concept C additionally wires the product's own bounded-preview relay; see its data-coverage note.

---

## The data

Every record, count, cover, note, and listening link on all three surfaces comes from one capture of Fluncle's own **public, unauthenticated** API. Nothing is generated, sampled, or filled in.

```
bun run --cwd apps/web concepts:capture
```

- **Source:** `https://www.fluncle.com` (public API v1)
- **Endpoints:** `/api/v1/findings`, `/api/v1/tracks?certified=false`, `/api/v1/tracks/fresh`, `/api/v1/search/archive`, `/api/v1/{artists,labels,albums}/{slug}`
- **Committed to:** `apps/web/src/concepts/discovery/fixture/` (~280 KB, and `meta.json` records the capture time and the production build it was taken from)

What it holds: every certified finding in the archive, a slice of the uncertified catalogue, the current release window, six artist/label/album dossiers, and — the piece nothing else could supply — **eight real sonic rankings** taken from production's own `sounds like` tier, which ranks by cosine distance over MuQ embeddings that no public endpoint exposes.

**The tradeoff this buys and costs**, and it applies to all three equally: the concepts read the OUTPUT of Fluncle's Archive / Fresh / Findings / search / entity / similarity / outbound primitives rather than executing those primitives in-process. A concept surface is therefore honest about the data and silent about the query cost. Any of the three, built for real, would read `listTracks`, `listFreshReleases`, `resolveArtistPageData`, `searchArchive`, and `getSimilarFindings` directly, and would inherit their measured behaviour and their scale limits — see the per-concept performance rows.

---

## The three journeys, per concept

Each concept proves the same three journeys. Every URL below is reproducible against a running exhibit.

### A · Front page

| Journey                               | Where                                                           | What happens                                                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Zero input**                        | `/concepts/front`                                               | A stranger who types nothing gets a lead record with Fluncle's own line about it, a column of the rest of what he recommends, a band of what came out lately, and a grid of earlier picks. |
| **Seed → unfamiliar sonic neighbour** | `/concepts/front` → a record → `/concepts/front/track/090.6.2K` | The record's own page carries **Close in sound**: Fluncle's ranking of what sits nearest it, most of which he has never certified, each row carrying a real outbound destination.          |
| **Direct entity landing**             | `/concepts/front/on/label/hospital-records`                     | The imprint's dossier: its factual bio, its counts, its findings under a heading that names them, the rest of what Fluncle holds in an unheaded block below, then the sonic step out.      |

### B · Desk

| Journey                               | Where                                   | What happens                                                                                                                                                  |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zero input**                        | `/concepts/desk`                        | The whole board, certifications first and newest release inside that, with live tempo, key, and label counts and a row of records the board can rank against. |
| **Seed → unfamiliar sonic neighbour** | `/concepts/desk?soundsLike=090.6.2K`    | The sonic facet replaces the candidate set with Fluncle's own ranking and the board says the order is by sound. Every other facet still narrows inside it.    |
| **Direct entity landing**             | `/concepts/desk?label=Hospital+Records` | The same board, pre-filled and headed by the imprint's identity. There is no separate entity document.                                                        |

### C · Run

| Journey                               | Where                                         | What happens                                                                              |
| ------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Zero input**                        | `/concepts/run`                               | The lane opens on a real record with branches already ahead of it.                        |
| **Seed → unfamiliar sonic neighbour** | `/concepts/run` → the **sound** branch        | The lane re-anchors on the record playing now and steps into Fluncle's ranking around it. |
| **Direct entity landing**             | `/concepts/run?entity=label:hospital-records` | The lane opens on what Fluncle holds at that node, named.                                 |

---

## The evidence

Retained in [`evidence/`](./evidence), regenerated by:

```
bun run --cwd apps/web scripts/e2e-stack.ts        # an isolated stack on :3140
bun run --cwd apps/web concepts:evidence           # in a second shell
```

- **Desktop (1440 × 900) and mobile (390 × 844)** screenshots of every journey above, for all three concepts, plus the exhibit index.
- **Keyboard evidence:** a shot per concept taken after tabbing in, so the focus indicator is visible rather than asserted.
- **Failure evidence:** the front page with every third-party cover host aborted, and the Desk's empty result.
- **Motion evidence:** a still cannot carry a state transition, so Concept C's branch step is captured as two **filmstrips** — one at `prefers-reduced-motion: no-preference`, one at `reduce`. Placed beside each other they are the reduced-motion proof.
- `evidence/manifest.json` records what each picture is evidence of.

| Files                                                                          | What it is evidence of                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exhibit/index-desktop.jpg` · `exhibit/index-mobile.jpg`                       | The exhibit index: what each concept is for and where the data came from.                                                                                                                          |
| `front/zero-input-desktop.jpg` · `front/zero-input-mobile.jpg`                 | Zero-input discovery: a visitor who types nothing gets a lead, a column of recommendations, and what came out lately.                                                                              |
| `front/seed-to-neighbour-desktop.jpg` · `front/seed-to-neighbour-mobile.jpg`   | A known seed continues to unfamiliar sonic neighbours through the Close in sound block, with an accurate outbound destination on each row.                                                         |
| `front/entity-landing-desktop.jpg` · `front/entity-landing-mobile.jpg`         | A direct entity landing: identity and dossier, findings first, the rest unheaded, then the sonic step out.                                                                                         |
| `front/keyboard-focus-desktop.jpg` · `front/keyboard-focus-mobile.jpg`         | Keyboard operation: the focus ring is visible on the first reachable control.                                                                                                                      |
| `front/covers-unavailable-desktop.jpg` · `front/covers-unavailable-mobile.jpg` | Resilient real-data loading: with every third-party cover host failing, the page keeps its structure and falls back to the eclipse gradient.                                                       |
| `desk/zero-input-desktop.jpg` · `desk/zero-input-mobile.jpg`                   | Zero-input discovery: the whole board with live facet counts and no query typed.                                                                                                                   |
| `desk/seed-to-neighbour-desktop.jpg` · `desk/seed-to-neighbour-mobile.jpg`     | A known seed continues to unfamiliar sonic neighbours: the board holds Fluncle's own ranking around the anchor.                                                                                    |
| `desk/entity-landing-desktop.jpg` · `desk/entity-landing-mobile.jpg`           | A direct entity landing is the board pre-filled and headed by that entity.                                                                                                                         |
| `desk/empty-desktop.jpg` · `desk/empty-mobile.jpg`                             | The empty state names what happened and offers a way back.                                                                                                                                         |
| `desk/keyboard-focus-desktop.jpg` · `desk/keyboard-focus-mobile.jpg`           | Keyboard operation: the focus ring is visible on a facet control.                                                                                                                                  |
| `run/zero-input-desktop.jpg` · `run/zero-input-mobile.jpg`                     | Zero-input discovery: the lane opens on a real record with branches ahead.                                                                                                                         |
| `run/entity-landing-desktop.jpg` · `run/entity-landing-mobile.jpg`             | A direct entity landing opens the lane on what Fluncle holds at that node.                                                                                                                         |
| `run/reduced-motion-desktop.jpg` · `run/reduced-motion-mobile.jpg`             | Under prefers-reduced-motion: reduce the lane still reads; nothing slides or fades.                                                                                                                |
| `run/frames-motion.jpg` · `run/frames-motion/`                                 | Six frames across one branch step at `prefers-reduced-motion: no-preference`. All six differ (`manifest.json` → `filmstrips.motion.distinctFrames` 6 of 6): the cross-fade is genuinely in flight. |
| `run/frames-reduced.jpg` · `run/frames-reduced/`                               | The same step under `reduce`. The burst settles and the tail frames are byte-identical (`filmstrips.reduced.distinctFrames` 4 of 6): there is no animation to ground, because none runs.           |

Contrast is not read off the palette either. Every pane in this world is translucent over the cover-art backdrop and the sun bloom, so what sits behind a line of text is a composite the stylesheet never names. `bun run --cwd apps/web concepts:contrast` photographs it — it hides the ink, keeps the layout, screenshots the element's own box, averages the pixels, and computes the ratio. Sixteen samples across the three concepts; the lowest clears 8:1 against WCAG AA's 4.5:1 floor.

The assertions a picture cannot carry live in `apps/web/tests/e2e/concepts.spec.ts`: SSR of every concept, the tier is never named, outbound links are real destinations opened with `rel="noreferrer"`, the keyboard reaches real controls with a visible focus indicator, Concept C's motion is genuinely absent under `reduce`, the exhibit is `noindex` and in no sitemap or feed, and the product's own surfaces are unchanged and do not link it.

---

## Running the exhibit

The exhibit needs a server. The isolated e2e stack is the one to use — it needs no credentials and no production access:

```
bun run --cwd apps/web scripts/e2e-stack.ts        # :3140
open http://127.0.0.1:3140/concepts
```

It requires `turso` and `sqld` on `PATH` (the same prerequisite the e2e suite already has).

---

## What this branch changes, and what it does not

**Added** (all of it under `concepts`-named paths, and all of it removable by deleting those paths):

- `apps/web/src/routes/concepts*.tsx` — the exhibit's routes.
- `apps/web/src/routes/-concepts-data.ts` — the three resolvers.
- `apps/web/src/concepts/discovery/**` — the model, the snapshot read, the snapshot, the per-concept stylesheets.
- `apps/web/src/components/concepts/**` — the concepts' components.
- `apps/web/scripts/capture-concept-fixture.ts` and `apps/web/tests/browser/concepts-evidence.ts`, with their two `package.json` scripts.
- `apps/web/tests/e2e/concepts.spec.ts`.

**Touched** — one line, in one existing file:

- `apps/web/src/components/nav/public-chrome.tsx` adds `/concepts` to the chromeless prefixes, because each concept proposes its own arrival and navigation and mounting the incumbent colophon over one would answer the question the exhibit exists to ask.

**What it costs the product, measured.** A production build puts the whole exhibit behind lazy chunks and adds nothing to what every page already pays. The snapshot compiles into a server-only chunk (`dist/server/assets/-concepts-data-*.js`) and appears in no client bundle. Each concept's client chunk is between 1.5 KB and 9.5 KB and loads only on its own route. Each concept's stylesheet is a separate asset reached through the route's `head` with `?url`, so none of it joins the app-wide render-blocking sheet: `shared.css` 1.9 KB, `front.css` 4.9 KB, `desk.css` 8.5 KB, `run.css` 5.5 KB, and `styles-*.css` — the one sheet every page blocks on — is untouched.

**Unchanged.** No existing public URL, permanent identifier, or anonymous access path moves. No public API, feed, MCP, CLI, publishing, account, recommendation, playlist, radio, or operator contract changes. No migration, no vendor, no authentication requirement, no full-song hosting, no identity tracking, no personalization, no paid action. The exhibit is `noindex, nofollow`, is registered in no `@fluncle/registry` surface, and appears in no sitemap or feed.

---

## The tradeoffs

Stated per concept, per axis. Read down a column to understand one concept; read across a row to compare them on one question. No axis is weighted, and no total is computed — weighting them is the decision this document exists to inform.

### A · Front page

| Axis                         | What it buys                                                                                                                                                                                                                                                                                             | What it costs                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Product**                  | The clearest expression of what Fluncle actually is: one person with taste, saying what is good and why. Fluncle's own written line about a record is the page's best asset, and this is the only concept that gives it room. A stranger understands the offer in one screen without touching a control. | It scales with **Fluncle's writing**, not with the archive. Ninety-seven recommendations make a good front page; 122,000 archive tracks are almost entirely unreachable from it. It answers "what should I hear" beautifully and "do you have X" not at all.                  |
| **Information architecture** | Conventional and immediately legible: a page, sections, links, sub-pages. Every unit has a URL, so every unit is shareable, crawlable, and cacheable. Depth is opt-in, which is exactly the level-1 / level-99 ladder the overhaul asks for.                                                             | The hierarchy has to be maintained. Placement is an editorial act, so somebody decides the lead — and today that somebody is a recency rule, not a judgement. A real version needs either an operator lever or an honest automatic policy, and the concept does not have one. |
| **Interaction**              | Nothing to learn and nothing to break. No client state, no controls, no hydration dependency: the page works fully with JavaScript off.                                                                                                                                                                  | The visitor cannot express intent. Wanting 174 rollers in D minor is not a thing this surface can hear. Every intent has to be anticipated by placement in advance.                                                                                                           |
| **Accessibility**            | The strongest of the three by construction. It is a document: correct heading order, one landmark per block, links as links, no custom widget, no focus management, no live region needed. Reading order and DOM order are the same.                                                                     | The stretched-anchor entry row means a pointer user's whole row is clickable while a screen-reader user hears only the title link — a standard, well-understood tradeoff, but it is one.                                                                                      |
| **Responsive**               | Reflows honestly: the editorial grid collapses to one column, the lead stays the lead. Nothing is hidden on a phone.                                                                                                                                                                                     | The lead's cover is the first viewport on a phone, so the column below it costs a scroll. On a small screen this reads more like a poster than a front page.                                                                                                                  |
| **Performance**              | The lightest of the three: server-rendered HTML, no client state, no client fetch. The heaviest bytes are cover images, which are lazy below the fold.                                                                                                                                                   | It ships the most images per screen. On a constrained link the release band and the earlier grid are the cost, and neither is what the visitor came for.                                                                                                                      |
| **Real-data coverage**       | Uses the richest part of the archive — notes, chips, covers, coordinates, imprint edges, real bios — and it visibly rewards records that have all of it.                                                                                                                                                 | It is also the concept that most exposes a data gap: a finding without a note gets a hole where the writing should be, and a lead needs both a cover and a sentence. The resolver picks the first record that has both, which quietly hides the gap rather than solving it.   |
| **Resilience**               | Every absence degrades to less page rather than to broken page: no cover falls back to the eclipse gradient, no chip is dropped, no listening link means no control.                                                                                                                                     | The band of what came out lately is thin data by nature — no cover, no tempo, no key — so it looks impoverished next to the certifications above it. That is honest, and it still reads as a weaker block.                                                                    |
| **Implementation**           | The smallest build of the three, and the one that reuses the most of what exists: it is close in shape to the incumbent home, `/log`, and the graph pages.                                                                                                                                               | The editorial policy is the real work and it is not in this concept. Section placement, the lead rule, and the release window would all need deciding before it could ship.                                                                                                   |

### B · Desk

| Axis                         | What it buys                                                                                                                                                                                                                                                                     | What it costs                                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Product**                  | The only concept whose ceiling is the size of the archive rather than the size of Fluncle's writing. It makes 122,000 tracks addressable and it answers "do you have X" and "174 rollers in D minor" directly. It is also the only one that lets a DJ use the archive as a tool. | It asks the visitor to already know what they want. A stranger with no query in mind gets a board, not an offer, and Fluncle's taste — the thing that makes the archive worth anything — is reduced to a marker inside a result set. The selector recedes behind the index.                              |
| **Information architecture** | One surface, no hierarchy to maintain, and no page that can go stale. Every state is a URL, so every board is shareable, bookmarkable, and back-button-undoable, and a direct entity arrival needs no separate document.                                                         | It collapses the graph. An artist, a label, and a record stop being places and become predicates, which costs them their identity, their dossier prose as a destination, and — decisively — their standalone indexable page. The archive's SEO surface is built out of exactly those pages.              |
| **Interaction**              | Composable and honest: facets narrow, chips remove, nothing is hidden behind a mode. The sonic facet is the strongest single move in the exhibit — one action turns a record you know into a ranked neighbourhood you do not.                                                    | The most to learn of the three, and the most ways to reach a state that returns nothing. Facet composition is strict on purpose (an artist chosen inside a sonic neighbourhood keeps the sonic anchor), which is one consistent rule but not always the one a visitor expected.                          |
| **Accessibility**            | Every control is a real link with `aria-current`, so state is announced rather than implied; the result count is a live region; the row wash answers focus as well as hover.                                                                                                     | The board is the most tab-stop-dense surface of the three — several gestures per row over sixty rows — and the mobile facet rail is a JavaScript disclosure, so it is the one piece of the exhibit that needs hydration to open (its search field inside is a real GET form and works without).          |
| **Responsive**               | The rail collapses into a disclosure and the board keeps full width; nothing is dropped on a phone, only folded.                                                                                                                                                                 | A facet rail is a desktop idea. On a phone the visitor must open a panel to do the one thing the concept is for, which is a real tax on the core gesture.                                                                                                                                                |
| **Performance**              | Fully server-rendered per URL and cacheable per state, because state is the URL. No client fetch.                                                                                                                                                                                | Faceting a real 122,000-row corpus is the expensive query shape in this repo. Counts across five facet groups are five aggregate reads per board, and the sonic facet is a vector scan — `docs/database-performance.md` and `docs/vector-serving.md` are the binding constraints, and they are not free. |
| **Real-data coverage**       | Reads the widest slice of the archive: findings and crawled catalogue in one board, with tempo, key, and label counts computed over both.                                                                                                                                        | Also the concept most exposed by thin rows. A crawled catalogue row has no cover, no BPM, no key, and usually no listening link, so a board that leans catalogue-side is visibly poorer than one that leans findings-side. The default order leads with certification for exactly this reason.           |
| **Resilience**               | Facet counts, the empty state, and the unrankable-seed fallback are all real code paths in the evidence set, and each says plainly what happened.                                                                                                                                | A board capped at 60 rows with the true total beside it is honest and incomplete: the other rows are unreachable in the exhibit. Pagination is deliberately not built (this is bounded evidence, not a product), and it is real work in the shipped version.                                             |
| **Implementation**           | Structurally simple: one route, one resolver, one URL contract. Nothing to keep in sync.                                                                                                                                                                                         | The most engineering of the three at real scale, and the one whose cost lands on the database rather than the page. It also needs an answer for what happens to the entity pages it dissolves.                                                                                                           |

### C · Run

| Axis                         | What it buys                                                                                                                                                                                                                                    | What it costs                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Product**                  | The lowest-effort discovery in the exhibit: one decision at a time, always with a next, and never a page to read. It is also the only concept that makes the sonic ranking feel like a place you can travel rather than a list you can consult. | It gives up breadth entirely. There is no way to see what the archive contains, no way to get back to a record you passed four stops ago except the trail, and no way to ask a question. It is the concept a visitor cannot use to look anything up.                                                                                      |
| **Information architecture** | Every stop is a URL, so a stop is shareable and the browser Back button genuinely walks the trail. A direct entity arrival opens the lane on that node without needing a document.                                                              | One stop at a time is a hostile shape for search engines and for anyone who wants an overview: there is no page listing anything, so nothing accumulates crawlable text. Coming from an entity landing, the node itself is named once and then left behind.                                                                               |
| **Interaction**              | The richest of the three and the only one where motion carries meaning rather than decoration: the cross-fade IS the state change. Keyboard transport makes it genuinely fast, and every shortcut also exists as a real focusable control.      | It is the only concept a visitor has to learn, and the only one where a wrong branch costs a step to undo. Its branch set is generated, so the quality of the journey is entirely the quality of the ranking behind it.                                                                                                                   |
| **Accessibility**            | A live region announces each stop, every branch is a link before it is a shortcut, the trail is a real ordered list of back-steps, and the transport keys refuse to fire inside a field or steal Enter from a focused control.                  | A single-focus player is the hardest shape to make legible to a screen reader, because the thing that changed is the whole screen. The announcement carries `Artist — Title` and nothing else; a reader who wants the chips has to go find them.                                                                                          |
| **Responsive**               | The best mobile shape of the three by a distance: one thing on screen, thumb-reachable branches, the cover height-bounded by viewport so the primary branch can never be pushed below the fold.                                                 | The desktop version is mostly empty. A 1440-wide viewport holding one record is generous framing or wasted room depending on your reading of it.                                                                                                                                                                                          |
| **Performance**              | The smallest payload per view: one record, one cover, three branch cards.                                                                                                                                                                       | Each step is a full navigation, so a long run is many round trips where the other two concepts are one. Prefetching the branches would fix it and would also multiply the reads.                                                                                                                                                          |
| **Real-data coverage**       | Rewards the deepest data in the archive — cover, note, chips, coordinate, outbound — and it is the only concept where the sonic neighbourhood is the primary mode of travel rather than a secondary block.                                      | The bounded preview is wired to the product's own `/api/preview/<logId>` relay, which is database-backed, so in this snapshot-driven exhibit it resolves for nothing and the lane falls back to the outbound destinations. The path is real and the degradation is visible in the evidence; the working preview is not demonstrated here. |
| **Resilience**               | Every absence is a real code path: no cover, no chips, no outbound link, a single-branch stop, and a stop at the end of the lane with no "keep going".                                                                                          | The lane can strand: an uncertified stop deep in a sonic neighbourhood may offer only one branch, so the run narrows rather than widening. That is honest about the data and it is also a worse experience than the other two at the same depth.                                                                                          |
| **Implementation**           | The most self-contained: one route, one resolver, one URL contract, no hierarchy.                                                                                                                                                               | The most bespoke UI in the exhibit — a transport, a motion moment, a keyboard map, an audio element and its failure states — and therefore the most surface to maintain and the most to get wrong on a device nobody tested.                                                                                                              |

---

## Open questions this exhibit surfaced

Not blockers on the choice; things the choice will have to answer.

1. **Which AREA the arrival surface belongs to is a canon question, not a concept detail.** All three concepts here speak the **catalogue** register at the door — plain nouns, third person, no nameplate — on the strength of the overhaul's stated direction ("the catalogue is level 1"; "no cosmos vocabulary where a stranger lands"). But DESIGN.md's Three Areas Rule and VOICE.md §5 both currently place the home arrival in the **lore** area, whose ratified masthead is the "Fluncle's Findings" nameplate over "Drum & bass bangers from another dimension." The roadmap is planning and loses to canon as written. Whichever concept is chosen, adopting it at the door is an amendment to DESIGN.md and VOICE.md, and it should be made deliberately rather than inherited from an exhibit.
2. **What happens to the graph pages** if the Desk model wins. `/artist/<slug>`, `/label/<slug>`, and `/album/<slug>` carry the archive's indexable weight ([docs/album-entity.md](../../album-entity.md)); the Desk turns them into board states, which is a real SEO decision and not a layout one.
3. **Where editorial placement comes from** if the Front page model wins. This exhibit's lead is chosen by a recency rule with a data guard, which is not a judgement. A shipped version needs either an operator lever or a policy honest enough to state.
4. **Whether the release band earns its place.** Only 2 of the 60 captured fresh rows carry a listening link, because a crawled row has no Spotify anchor until it is enriched. As data stands, "what came out lately" is a real service with almost nowhere to send anybody.
5. **The bounded preview.** All three concepts would be better with 30 seconds of audio in them, and only the product's own relay can lawfully supply it. It is wired in Concept C and unexercised here; whether it becomes the default listening affordance is worth deciding at the same time as the model.
