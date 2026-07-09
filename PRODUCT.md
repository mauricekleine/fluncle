# Product

## Register

brand

## Users

Fluncle is for the crew: the ragtag, out-of-the-ordinary-in-the-best-way drum & bass lot who follow Fluncle's Findings across surfaces — listeners who want the latest finds, the operator who publishes them, and friends who jump between Spotify and Telegram. They are travelers too; they recognise a finding when they see one.

## Product Purpose

The product publishes selected drum & bass tracks to Spotify and Telegram through a server-owned admin API and a small operator CLI, then gives the public a fast archive at fluncle.com. That's the machine. The story it tells is the point: the public-facing whole is a traveler's logbook — Fluncle moves through time and space, and every track he certifies is a **finding** with a permanent identity (a Log ID) that names it the same way on every surface, so the scattered surfaces read as one journey, the **Galaxy**. Success means publishing stays operator-controlled while the public side feels immediate, focused, unmistakably Fluncle, and inside the fiction. The full narrative this rests on — the loop a finding travels (a banger is an experience, the video relives it, the crew shares it, the star is a waypoint, the mixtape is a dream) — is the story canon in [LORE.md](./LORE.md); this section is the product-strategy read of it.

## Mixtapes — Fluncle dreaming

Alongside findings, Fluncle publishes his own **mixtapes**: a selector mixing his own findings into one long recording. In the fiction it is Fluncle **dreaming** — the short-term memories that individual findings are (one short track each) settling into one long-term memory (a long set), blended the way a mix blends tracks and a dream blends the day (the full read is in [LORE.md](./LORE.md)) — and structurally a **checkpoint**, the epilogue that closes a chapter before the next begins. The double read is the Depth Gradient in object form: to outsiders it is just another mixtape; to the crew, a glimpse into Fluncle's subconscious. A mixtape is a first-class object on the Log ID spine but a different kind from a finding: it carries its own Log ID (the literal `F` marker plus a mixtape number, never a finding's digit), it is not a "find" (it never increments the found count), it carries findings rather than being one, and it is authentically Fluncle where an AI-made original would fight the persona. It slips quietly into the track surfaces, gets its own `/mixtapes` front door for anyone looking, and is announced to the crew like any finding. The full object model and the publish steps live in the [fluncle-mixtapes skill](./packages/skills/fluncle-mixtapes).

## Brand Personality

Warm, vast, direct, transcending — and crewed. The creative north star is "The Nostalgic Cosmos" (DESIGN.md): this music projects your mind out into the cosmos, another dimension, a parallel universe. Fluncle is the uncle with the good records who is also a traveler through time and space, and he doesn't travel alone — drum & bass is something the crew feels together (the crowd whose dancing looks like a fight until someone goes down and everyone stops to pick them up). The mood is awe and melancholy at once, "where did we come from" and "where do we go", floaty and atmospheric, with the occasional flicker of the new-and-scary — the nervous-confident charge of not knowing what's past the next sector, always landing on "we'll handle it, and it'll probably be a laugh." Never nihilist, never cold, never corporate. The dark is warm and inhabited, the way a city night is. The site should feel like a traveler's logbook kept as carefully as a record collection, never a marketing page or a generic music startup. And the look is authentically the operator's own — recognisable in collages he made years before Fluncle existed (the proto-eclipse gold moon, the lone figure against vastness, heavy grain over warm near-black; see the video moodboard) — which is why it reads as inevitable rather than designed. That authenticity is a brand asset, not a coincidence.

## Anti-references

Avoid SaaS dashboards, bright streaming-app clones, generic landing-page hero sections, oversized marketing copy, glassy card stacks, and decorative gradients that ignore the cover art. Avoid, equally, the cold lonely-derelict-spaceship sci-fi cliché: the Galaxy is warm and crewed, not a sterile research log.

## Design Principles

- Keep publishing authority behind the authenticated admin API.
- Put the music first, framed as a finding: artist, title, the Found date, note, Log ID, and the Spotify open action. The music leads the eye; the log frames it.
- Treat the cover art as the founding document of the visual system; every visual decision descends from it.
- Carry the narrative on every surface, not just the deep ones: each surface is a representation of one traveler's findings, unified by the Log ID. Narrative saturation is uniform; only technical density grades by surface (VOICE.md's Depth Gradient).
- Make the public app quiet, centered, and fast.
- Treat Telegram and Spotify as first-class destinations.
- DESIGN.md is the leading visual spec and VOICE.md the leading language spec: where this file overlaps with DESIGN.md on aesthetics, DESIGN.md wins; on language, VOICE.md wins.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls. Preserve keyboard access for every interactive row and link. Respect reduced-motion preferences and keep the dark-only palette legible for long scanning sessions.
