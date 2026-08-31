# Product

## Register

brand

## Users

Fluncle is for the crew: the ragtag, out-of-the-ordinary-in-the-best-way drum & bass lot who follow Fluncle's Findings across surfaces — listeners who want the latest finds, the operator who publishes them, and friends who jump between Spotify and Telegram. They are travelers too; they recognise a finding when they see one.

## Product Purpose

The product publishes selected drum & bass tracks to Spotify and Telegram through a server-owned admin API and a small operator CLI, then gives the public a fast archive at fluncle.com. That's the machine. The story it tells is the point: the public-facing whole is a traveler's logbook — Fluncle moves through time and space, and every track he certifies is a **finding** with a permanent identity (a Log ID) that names it the same way on every surface, so the scattered surfaces read as one journey, the **Galaxy**. Success means publishing stays operator-controlled while the public side feels immediate, focused, unmistakably Fluncle, and inside the fiction. The full narrative this rests on — the loop a finding travels (a banger is an experience, the video relives it, the crew shares it, the star is a waypoint, the mixtape is a dream) — is the story canon in [LORE.md](./LORE.md); this section is the product-strategy read of it.

## Mixtapes — Fluncle dreaming

Alongside findings, Fluncle publishes his own **mixtapes**: a selector mixing his own findings into one long recording. In the fiction it is Fluncle **dreaming** — the short-term memories that individual findings are (one short track each) settling into one long-term memory (a long set), blended the way a mix blends tracks and a dream blends the day (the full read is in [LORE.md](./LORE.md)) — and structurally a **checkpoint**, the epilogue that closes a chapter before the next begins. The double read is the Depth Gradient in object form: to outsiders it is just another mixtape; to the crew, a glimpse into Fluncle's subconscious. A mixtape is a first-class object on the Log ID spine but a different kind from a finding: it carries its own Log ID (the literal `F` marker plus a mixtape number, never a finding's digit), it is not a "find" (it never increments the found count), it carries findings rather than being one, and it is authentically Fluncle where an AI-made original would fight the persona. It slips quietly into the track surfaces, gets its own `/mixtapes` front door for anyone looking, and is announced to the crew like any finding. The full object model and the publish steps live in the [fluncle-mixtapes skill](./packages/skills/fluncle-mixtapes).

## The front door

`/` is a **discovery front door**, not a lore page and not a marketing hero. It exists for one reader: a stranger who arrives knowing nothing about Fluncle and types nothing. Everything the page does is answerable from that person's position — a prominent search entry with clickable, real example queries; one finding placed and written about; a few more findings; what just came out; and four direct, familiar routes into the wider archive (Tracks, Artists, Albums, Labels) each carrying its real size. It works fully anonymously: no section requires an account, and joining, saved music, recommendations, the playlist, and radio all stay reachable and functional without ever being sold as the outcome of arriving. The cover-led archive page `/` used to be is whole at `/findings`, in the nav, in the sitemap, and reachable from the front door by name.

**The refinement: one long deliberate scroll, not a stack of panels.** The page is long on purpose, and its length is rhythm rather than volume — one plate, bands separated by a documented spacing scale, each band the same shape (a heading, at most one line of intro, at most one link out, then the content). Every section renders from a live production primitive, so what a reader sees is the archive itself and never a mock of it. Motion supports the scroll and never gates it; under `prefers-reduced-motion: reduce` the page is genuinely still. The visual half of this direction is DESIGN.md §5, "The Long Scroll".

**Archive and Findings are related and never conflated.** The broad archive is everything Fluncle holds and is charting; the Findings are the selective set he certified. The front door carries both, and the distinction is carried by **placement and light alone** — findings sit high and lit with their coordinates, the wider archive sits below in the unlit register and under superset nouns ("tracks", "artists"). No surface names a certification tier, attaches a badge, or hangs a noun on a row that would imply Fluncle stands behind every indexed track (DESIGN.md's Unlit Rule; VOICE.md's unnamed tier).

**The transport model is rejected.** An earlier direction framed the front door as a vehicle you pilot: a console that carries the reader through the archive one record at a time, advancing on an interaction before the next thing is reachable. It is rejected, and it stays rejected. Three reasons, in order of weight. It makes a stranger _earn_ the archive one step at a time when the whole job of a front door is to make the shape of the thing legible at a glance. It hides breadth behind sequence, so the reader can never see how much is here or leave in the direction they actually want. And it puts the interface between the reader and the music, which is the one thing every other rule in this document is trying to prevent — the tracklist is the page, and a transport is a page about itself. A stepper is still allowed where it is genuinely the content and never the only way through (the Stories viewer on `/findings`); it is never the front door's spine.

## Brand Personality

Warm, vast, direct, transcending — and crewed. The creative north star is "The Nostalgic Cosmos" (DESIGN.md): this music projects your mind out into the cosmos, another dimension, a parallel universe. Fluncle is the uncle with the good records who is also a traveler through time and space, and he travels alone, blazing a trail for the crew who follow — drum & bass is something they feel together (the crowd whose dancing looks like a fight until someone goes down and everyone stops to pick them up). The mood is awe and melancholy at once, "where did we come from" and "where do we go", floaty and atmospheric, with the occasional flicker of the new-and-scary — the nervous-confident charge of not knowing what's past the next sector, always landing on "we'll handle it, and it'll probably be a laugh." Never nihilist, never cold, never corporate. The dark is warm and inhabited, the way a city night is. The site should feel like a traveler's logbook kept as carefully as a record collection, never a marketing page or a generic music startup. The visual identity is grounded in the recurring motifs defined by DESIGN.md and its moodboard: the eclipse-gold orb, lone figure against vastness, and heavy grain over warm near-black.

## Anti-references

Avoid SaaS dashboards, bright streaming-app clones, generic landing-page hero sections, oversized marketing copy, glassy card stacks, and decorative gradients that ignore the cover art. Avoid, equally, the cold lonely-derelict-spaceship sci-fi cliché: the Galaxy is warm and crewed, not a sterile research log.

## Design Principles

- Keep publishing authority behind the authenticated admin API.
- Put the music first, framed as a finding: artist, title, the Found date, note, Log ID, and the Spotify open action. The music leads the eye; the log frames it.
- Treat the cover art as the founding document of the visual system; every visual decision descends from it.
- Use the Three Areas Rule: lore pages carry the fiction as content, catalogue pages are factual reference surfaces, and workstations let the interface carry the meaning.
- Make the public app quiet, centered, and fast.
- Keep `/` a discovery front door: zero-input, anonymous, one long deliberate scroll over real data, never a transport the reader has to step through (The front door, above).
- Treat Telegram and Spotify as first-class destinations.
- DESIGN.md is the leading visual spec and VOICE.md the leading language spec: where this file overlaps with DESIGN.md on aesthetics, DESIGN.md wins; on language, VOICE.md wins.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls. Preserve keyboard access for every interactive row and link. Respect reduced-motion preferences and keep the dark-only palette legible for long scanning sessions.
