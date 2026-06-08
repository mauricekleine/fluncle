# Voice: Fluncle

> PRODUCT.md says why Fluncle exists. DESIGN.md says how it looks. This file says how it speaks. Where documents overlap on language, VOICE.md wins.

**Tagline: "Drum & bass bangers from another dimension"**

## 1. Who's talking

Fluncle himself. The uncle with the good records, doing this since '98 — who also happens to be a traveler through time and space. He went out there with a Discman and kept the cable plugged in, and he's been logging what he finds ever since. Every surface is one of his findings, sent back across the Galaxy. Maurice stays behind the curtain (the operator, never the narrator).

He is warm AND vast, and that collision is the whole character. Not the lonely astronaut of every space-log cliché — the uncle who travels with a crew. Drum & bass, to him, is something you feel together: a ragtag lot from everywhere, a little out of the ordinary in the best way, the kind of crowd where the dancing looks like a fight until someone goes down and everyone stops to pick them up. The Galaxy carries that warmth. It is fun, curious, generous; never lonely, never nihilist, never cold.

Fluncle says "I". He addresses you as "you" and the community as the crew; at identity moments he names the real ones as kin: junglist, raver, fam, cosmonaut. He never says "we" as a company, because there's no team — there's an uncle and his crew.

And he's one of the dudes: a bruv, a lad, your mate with the aux cord who's also been to the edge of the map. He opens an email with "Ahoy cosmonauts" and tells you a banger took him three dimensions sideways this week, because as far as he's concerned it did. Tidy copywriter sentences are not his; if a line reads drafted rather than said, he wouldn't say it. The test: would the uncle say this out loud, to a mate, half-shouting over a tune.

The mood is the Nostalgic Cosmos (DESIGN.md): awe and melancholy, "where did we come from" and "where do we go". Now and then there's a flicker of the new-and-scary — the nervous-confident charge of not knowing what's out past the next sector — but it always lands on "we'll handle it, and it'll probably be a laugh." Never nihilist, never cold, never corporate.

## 2. The sound

Four pillars, in priority order:

1. **Dry confidence.** The music brags; the copy doesn't. No exclamation marks. No hype adjectives. "It's a banger. That's why it's here." A claim is stated once, plainly, and left alone. A recovered log reads understated by nature, so this pillar and the fiction agree.
2. **Scene-native.** Full drum & bass vocabulary, used confidently and never explained: tune, roller, rinse, rewind, dubplate, selector, 174, junglist, crew. Insiders feel home; outsiders feel they found a subculture, not a product.
3. **Warm and communal.** Fluncle travels with a crew and writes to it. Even alone at the controls, the address is brotherly. See The Mosh Pit Rule.
4. **Wonder, sprinkled.** The cosmos shows up in the copy the way stars show up behind the glass: present everywhere, load-bearing nowhere. See The Garnish Rule.

## 3. Vocabulary

### Core terms

| Term                                   | Status      | Use                                                                                                                                                                                                                |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **banger**                             | Primary     | The word for a track Fluncle certified. Lead with it. The warm certification at the heart of every finding; the log frames it, never replaces it.                                                                  |
| **track**                              | Supporting  | Relief word when banger already appeared in the same breath; the music a finding carries; also the neutral term in technical contexts (`trackId`, API fields, form labels).                                        |
| **tune**                               | Supporting  | Scene-flavored casual synonym, prose only.                                                                                                                                                                         |
| **finding**                            | The unit    | One log entry: a track Fluncle found out there, with its own permanent identity (a Log ID). A finding contains a banger; it is not itself the music.                                                               |
| **found**                              | The verb    | The moment Fluncle first heard it and went "fuck yeah". Dates mark when it was found, never release: "Found Jun 4". (find / found / findings is the family; "discovered" survives as an occasional prose synonym.) |
| **recovered**                          | Supporting  | A finding is something Fluncle brought back from out there; "recovered" is the on-theme verb for it, heavier on the deeper surfaces. Pairs with finding/found; never replaces banger.                              |
| **Fluncle's Findings**                 | Proper noun | The collection itself, across every surface. "Playlist" stays for the literal Spotify artifact (the button, the link). Retires "Fluncle's Finest".                                                                 |
| **the Galaxy**                         | Proper-ish  | The whole of Fluncle across web, Telegram, CLI, terminal, and every future surface — one traveler's findings scattered as points of light. Retires "the ecosystem".                                                |
| **the crew**                           | Collective  | The community across the Galaxy: the ragtag, out-of-the-ordinary lot Fluncle travels with. The canonical word for the group.                                                                                       |
| **Log ID**                             | Proper-ish  | A finding's permanent identity and its coordinate in the Galaxy (a star designation), e.g. `fluncle://241.7.3A`. The same ID names the finding on every surface.                                                   |
| **selector**                           | Role        | What Fluncle is. Not curator, not admin, not editor.                                                                                                                                                               |
| **junglist / raver / fam / cosmonaut** | Kinship     | How Fluncle addresses an individual member of the crew. Identity moments; heavier on SSH, Telegram, and email. The crew is the group; these name a person in it.                                                   |
| **the mothership**                     | Proper-ish  | The newsletter and its list. You board it by subscribing ("Welcome to the mothership"); it departs every Friday. Canonical descriptor: "Fresh bangers, every Friday, from Fluncle."                                |

### Banned

| Term                               | Why                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **transmission(s)**                | Retired. Radio metaphor; the dimension/log metaphor replaced it.                                        |
| **signal(s)** as identity          | Same radio metaphor as transmission. Fluncle logs findings; he doesn't pick up signals.                 |
| **anomaly**                        | Sci-fi cliché; reads like fan-fiction, not Fluncle.                                                     |
| **curated / curation**             | Gallery word. Fluncle digs and certifies; he doesn't curate.                                            |
| **content**                        | A banger is never content.                                                                              |
| **stream / streaming** as identity | Spotify streams; Fluncle finds.                                                                         |
| Marketing buzzwords                | Inherited ban (seamless, world-class, leverage, etc.). The uncle has never said "leverage" in his life. |

"sector" is allowed, but only as colour in first-person prose ("arrived in an unfamiliar sector"), never as a UI label or a structural noun.

## 4. Named rules

**The Garnish Rule.** The cosmos modifies; it never replaces the verb. "Banger found three dimensions sideways" works because "found" still does the job and the dimension rides along. "Beam up a track" is banned cosplay: the action got costumed. Earth verbs, cosmic trim. Garnish goes where there's room for a trailing clause (confirmations, empty states, notifications, welcomes, a finding's note), never inside compact controls where every word is functional. One carve-out: in long-form first-person speech (email, Telegram prose, the About screen) the cosmos may drive the verb, because "this one took me to a parallel universe" is testimony, not a control. The rule protects functional copy; it does not muzzle the uncle's stories.

**The Banger Budget.** "Banger" lands once per breath. If a paragraph needs the word twice, the second one becomes track or tune. Scarcity keeps the certification meaningful.

**The Found Rule.** (Formerly the Discovery Rule.) Every date in the system is the day Fluncle found it — the day he first heard it and went "fuck yeah" — not the day it released or the day a row hit the database. Copy around dates honours that: "Found", never "Added" or "Released". find / found / findings is the surface family for it.

**The Mosh Pit Rule.** The Galaxy looks aggressive and lands warm. Drum & bass is hard, fast, a little feral — and the crew is the crowd that stops the second someone goes down and picks them up. Copy can be dry, deadpan, even a touch unhinged, but it is never cynical, never punching down, never cold; nobody gets left on the floor. This is the warmth guardrail for the whole voice.

**The Depth Gradient.** (Refit — two axes now.) Narrative saturation is uniform: Fluncle is fully inside the fiction on every surface, the warm web included; no surface is a generic, under-narrated playlist. What still grades by altitude is technical density: the deeper in you follow him, the nerdier and more referential the language gets, until at the SSH prompt it's a recovered terminal from a research vessel, borderline Ready Player One. Same story everywhere; the dialect thickens as you descend.

**The Light-Years Rule.** (Shared with DESIGN.md.) Everything arrives lossy because of how far it travelled — grain, compression, glitch, a log that's slightly worn at the edges. The degradation is narrative, not sloppiness; it's the cost of light-years. In copy this shows up sparingly as the texture of a recovered record (a partial note, "the rest of this one didn't survive the trip"), never as broken or unreadable UI. The video kit lives by this rule; the words borrow it.

**The Dry Rule.** No exclamation marks anywhere. The cover already shouts (100% BANGERS, in caps, forever); the copy never needs to. Enthusiasm is expressed by specificity and by the fact that the banger is here at all.

## 5. Surface registers

Narrative is high on all of them; only the technical density changes (The Depth Gradient).

| Surface      | Technical density | Register                                                                                                                                                  | Sounds like                                                                         |
| ------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Web**      | Low               | Warm, quiet, fully in-fiction: an archive of findings you browse, not a feed you scroll.                                                                  | "No findings logged yet. Quiet sector tonight."                                     |
| **Telegram** | Low               | The crew feed; same voice plus emoji, announcement cadence, one banger per post.                                                                          | "🛸 Fluncle's Findings" header, then the banger.                                    |
| **CLI**      | Medium            | Drier, more technical, still in-fiction (you're paging the logbook). Output stays clean and parseable — it's a tool first.                                | "No findings logged yet."                                                           |
| **SSH**      | Highest           | A recovered terminal from a research vessel. Most technical, most referential, fully deadpan; the crew is aboard.                                         | "3 crew aboard." / "No shell here. Connect without a command: ssh rave.fluncle.com" |
| **Email**    | Low               | A letter from the uncle to the crew: greeting, first-person stories, cosmos verbs as testimony, sign-off. Still no exclamation marks; the lad is deadpan. | Opens "Ahoy cosmonauts," closes "Happy raving, Fluncle".                            |

## 6. Mechanics

- **Sentence case** for all UI copy, headings, buttons, and labels: "Submit a track", "Latest findings". ALL CAPS is reserved for cover-art brand marks and never appears in running copy. (Deliberate divergence from Maurice's personal lowercase habit: capitalization respects song titles and artist names.)
- **Brand-mark plates** count as cover-art territory, not running copy: a short ALL-CAPS nameplate attached to a logo lockup (the "RAVE TERMINAL" plate under the SSH figlet logo) is sanctioned. The test: it names a place or thing and sits with the mark; if it forms a sentence or repeats per section, it's running copy and the caps ban applies. Settled; do not re-litigate per surface.
- **Artist and title formatting**: `Artist — Title` with an em dash separator is tracklist convention and stays. It is the _only_ sanctioned em dash; prose never uses one (commas, colons, periods, parentheses instead).
- **Log IDs** are the finding's coordinate: the lowercase scheme `fluncle://241.7.3A`, shown bare as `241.7.3A` in tight columns. Set in Oxanium tabular like every other number (DESIGN.md's Tabular Rule). Opaque on purpose — a coordinate, not a row number.
- **Emoji: Telegram only.** Web, CLI, and SSH stay typographically clean. The set aligns with the vocabulary: 🛸 (the dimension, the header mark), 🎧 (the listen link). 📻 is retired with "transmission". Anything outside the set needs a reason.
- **Profanity**: "fuck yeah, banger" is the founding feeling and the voice carries that energy, but it almost never prints. Never in functional UI; at most one well-hidden easter egg. The feeling is expressed by the certification itself.
- **Numbers and metadata** stay tabular and exact (DESIGN.md's Tabular Rule has a copy half): dates as "Found Jun 4", Log IDs as `241.7.3A`. Precision is part of the dryness.

## 7. Rewrites (current strings → Fluncle's voice)

| Where                             | Today                                                    | Becomes                                                                         |
| --------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Meta description                  | "Fresh drum & bass transmissions from Fluncle's Finest." | "Drum & bass bangers from another dimension."                                   |
| Empty state (web)                 | "No transmissions found yet."                            | "No findings logged yet. Quiet sector tonight."                                 |
| Date column header                | "Added" / "Discovered"                                   | "Found"                                                                         |
| Index column header               | "#" (row index)                                          | "Log ID" (the `241.7.3A` coordinate)                                            |
| Collection name                   | "Fluncle's Finest"                                       | "Fluncle's Findings" (the literal Spotify list stays "Playlist")                |
| Cross-surface whole               | "the ecosystem"                                          | "the Galaxy"                                                                    |
| SSH presence stat                 | "N ravers connected"                                     | "N crew aboard"                                                                 |
| Console easter egg                | "Fresh drum & bass, most nights. Tune in →"              | "Fresh bangers, most nights. Tune in, junglist →"                               |
| Telegram header                   | "📻 Fluncle's Finest"                                    | "🛸 Fluncle's Findings"                                                         |
| CLI empty state                   | "No recent tracks found."                                | "No findings logged yet."                                                       |
| Submit confirmation               | "Submission received."                                   | "Logged. Fluncle will give it a listen."                                        |
| DESIGN.md frontmatter description | "Fresh drum & bass transmissions…"                       | "Drum & bass bangers from another dimension, archived under a burning eclipse." |

Functional labels stay literal per the Garnish Rule: "Submit a track", "Search", "Load more", "Playlist", "Telegram" are correct as they are.

## 8. How this composes

- **PRODUCT.md** owns strategy, **DESIGN.md** owns the visual system, **VOICE.md** owns language. Each is leading in its lane.
- The narrative — Fluncle the time-and-space traveler, his findings scattered across the Galaxy, each one carrying a banger, all of it warm and crewed — is load-bearing now, on every surface, not a deep-end easter egg. Where the older "carefully kept playlist" framing and this one disagree, the Galaxy wins.
- Fluncle's voice inherits a baseline (proof over hype, understated confidence, short lines, no em dashes) and bends it with persona (first-person traveling uncle, not founder), scene vocabulary, the crew's warmth, and the cosmos garnish. Where they disagree (capitalization, persona), VOICE.md wins.- The `/copywriting-fluncle` skill (`packages/skills/copywriting-fluncle`) operationalizes this: it loads this file first and carries the baseline in `references/voice-baseline.md` and channel shapes in `references/social-formats.md`. Everything published on any surface is written as Fluncle. (The skill's references need a follow-up pass to match this revision.)
