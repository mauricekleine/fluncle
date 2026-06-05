# Voice: Fluncle

> PRODUCT.md says why Fluncle exists. DESIGN.md says how it looks. This file says how it speaks. Where documents overlap on language, VOICE.md wins.

**Tagline: "Drum & bass bangers from another dimension"**

## 1. Who's talking

Fluncle himself. The uncle with the good records, doing this since '98. He went into space with a Discman and kept the cable plugged in; everything published on any surface is him talking. Maurice stays behind the curtain (the operator, never the narrator).

Fluncle says "I". He addresses the listener as "you", and at identity moments as kin: junglist, raver, fam, cosmonaut. He never says "we", because there is no team, there's an uncle.

And he's one of the dudes: a bruv, a lad, your mate with the aux cord. He opens an email with "Ahoy cosmonauts" and tells you a banger teleported him to a parallel universe this week, because as far as he's concerned it did. Tidy copywriter sentences are not his; if a line reads drafted rather than said, he wouldn't say it. The test from the baseline applies double here: would the uncle say this out loud, to a mate, half-shouting over a tune.

The mood is the Nostalgic Cosmos (DESIGN.md): awe and melancholy, "where did we come from" and "where do we go". Never nihilist, never cold, never corporate.

## 2. The sound

Three pillars, in priority order:

1. **Dry confidence.** The music brags; the copy doesn't. No exclamation marks. No hype adjectives. "It's a banger. That's why it's here." A claim is stated once, plainly, and left alone.
2. **Scene-native.** Full drum & bass vocabulary, used confidently and never explained: tune, roller, rinse, rewind, dubplate, selector, 174, junglist. Insiders feel home; outsiders feel they found a subculture, not a product.
3. **Wonder, sprinkled.** The cosmos shows up in the copy the way stars show up behind the glass: present everywhere, load-bearing nowhere. See The Garnish Rule.

## 3. Vocabulary

### Core terms

| Term                                   | Status      | Use                                                                                                                                                                                 |
| -------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **banger**                             | Primary     | The word for a song Fluncle certified. Lead with it.                                                                                                                                |
| **track**                              | Supporting  | Relief word when banger already appeared in the same breath; also the neutral term in technical contexts (`trackId`, API fields, form labels).                                      |
| **tune**                               | Supporting  | Scene-flavored casual synonym, prose only.                                                                                                                                          |
| **discovered**                         | The verb    | The moment Fluncle first heard it and went "fuck yeah". Dates always mark discovery, never release: "Discovered Jun 4".                                                             |
| **Fluncle's Finest**                   | Proper noun | The collection itself, on every surface. "Playlist" stays for the literal Spotify artifact (the button, the link).                                                                  |
| **the ecosystem**                      | Proper-ish  | What you `ssh` into. The whole of Fluncle across web, Telegram, CLI, and terminal.                                                                                                  |
| **selector**                           | Role        | What Fluncle is. Not curator, not admin, not editor.                                                                                                                                |
| **junglist / raver / fam / cosmonaut** | Kinship     | How Fluncle addresses the real ones. Identity moments only; heavier on SSH, Telegram, and email.                                                                                    |
| **the mothership**                     | Proper-ish  | The newsletter and its list. You board it by subscribing ("Welcome to the mothership"); it departs every Friday. Canonical descriptor: "Fresh bangers, every Friday, from Fluncle." |

### Banned

| Term                               | Why                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **transmission(s)**                | Retired. It carried the radio metaphor; the dimension metaphor replaced it.                             |
| **curated / curation**             | Gallery word. Fluncle digs and certifies; he doesn't curate.                                            |
| **content**                        | A banger is never content.                                                                              |
| **stream / streaming** as identity | Spotify streams; Fluncle discovers.                                                                     |
| Marketing buzzwords                | Inherited ban (seamless, world-class, leverage, etc.). The uncle has never said "leverage" in his life. |

## 4. Named rules

**The Garnish Rule.** The cosmos modifies; it never replaces the verb. "Banger received from another dimension" works because "received" still does the job and the dimension rides along. "Beam up a track" is banned cosplay: the action got costumed. Earth verbs, cosmic trim. Garnish goes where there's room for a trailing clause (confirmations, empty states, notifications, welcomes), never inside compact controls where every word is functional. One carve-out: in long-form first-person speech (email, Telegram prose, the About screen) the cosmos may drive the verb, because "these bangers teleported me to a parallel universe" is testimony, not a control. The rule protects functional copy; it does not muzzle the uncle's stories.

**The Banger Budget.** "Banger" lands once per breath. If a paragraph needs the word twice, the second one becomes track or tune. Scarcity keeps the certification meaningful.

**The Discovery Rule.** Every date in the system is the discovery date: the day Fluncle first heard it, not the day it released or the day a row hit the database. Copy around dates honors that ("Discovered", never "Added" or "Released").

**The Depth Gradient.** One uncle, graded by altitude. On the web and Telegram he's floating in space: warm, quiet, accessible. The deeper into the terminal you follow him, the more technical the jokes and the references get; at the SSH prompt it's borderline Ready Player One. He knows that if you're here, you're one of the real ones.

**The Dry Rule.** No exclamation marks anywhere. The cover already shouts (100% BANGERS, in caps, forever); the copy never needs to. Enthusiasm is expressed by specificity and by the fact that the banger is here at all.

## 5. Surface registers

| Surface      | Altitude                | Register                                                                                                                                                        | Sounds like                                                                       |
| ------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Web**      | Floating in space       | Quiet, warm, minimal. Garnish at identity moments only.                                                                                                         | "No bangers discovered yet. Quiet night in this dimension."                       |
| **Telegram** | The feed                | Same voice plus emoji; announcement cadence, one banger per post.                                                                                               | "🛸 Fluncle's Finest" header, then the banger.                                    |
| **CLI**      | Terminal                | Drier, more technical. Help text may joke; command output stays clean and parseable (it's a tool first).                                                        | "No bangers discovered yet."                                                      |
| **SSH**      | Deepest in              | Ready Player One. Most technical, most referential, fully deadpan.                                                                                              | "No shell here. Connect without a command: ssh rave.fluncle.com" (already canon). |
| **Email**    | A letter from the uncle | The warmest and most bruv surface: greeting, first-person stories, cosmos verbs allowed as testimony, sign-off. Still no exclamation marks; the lad is deadpan. | Opens "Ahoy cosmonauts," closes "Happy raving, Fluncle".                          |

## 6. Mechanics

- **Sentence case** for all UI copy, headings, buttons, and labels: "Submit a track", "Latest bangers". ALL CAPS is reserved for the cover-art brand marks and never appears in running copy. (Deliberate divergence from Maurice's personal lowercase X habit: capitalization respects song titles and artist names.)
- **Brand-mark plates** count as cover-art territory, not running copy: a short ALL-CAPS nameplate attached to a logo lockup (the "RAVE TERMINAL" plate under the SSH figlet logo) is sanctioned. The test: it names a place or thing and sits with the mark; if it forms a sentence or repeats per section, it's running copy and the caps ban applies. Settled; do not re-litigate per surface.
- **Artist and title formatting**: `Artist — Title` with an em dash separator is tracklist convention and stays. It is the _only_ sanctioned em dash; prose never uses one (commas, colons, periods, parentheses instead).
- **Emoji: Telegram only.** Web, CLI, and SSH stay typographically clean. The set aligns with the vocabulary: 🛸 (the dimension, the header mark), 🎧 (the listen link). 📻 is retired with "transmission". Anything outside the set needs a reason.
- **Profanity**: "fuck yeah, banger" is the founding feeling and the voice carries that energy, but it almost never prints. Never in functional UI; at most one well-hidden easter egg. The feeling is expressed by the certification itself.
- **Numbers and metadata** stay tabular and exact (DESIGN.md's Tabular Rule has a copy half): dates as "Jun 4", indices as #01. Precision is part of the dryness.

## 7. Rewrites (current strings → Fluncle's voice)

| Where                             | Today                                                    | Becomes                                                                         |
| --------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Meta description                  | "Fresh drum & bass transmissions from Fluncle's Finest." | "Drum & bass bangers from another dimension."                                   |
| Empty state (web)                 | "No transmissions found yet."                            | "No bangers discovered yet. Quiet night in this dimension."                     |
| Date column header                | "Added"                                                  | "Discovered"                                                                    |
| Console easter egg                | "Fresh drum & bass, most nights. Tune in →"              | "Fresh bangers, most nights. Tune in, junglist →"                               |
| Telegram header                   | "📻 Fluncle's Finest"                                    | "🛸 Fluncle's Finest"                                                           |
| CLI empty state                   | "No recent tracks found."                                | "No bangers discovered yet."                                                    |
| Submit confirmation               | "Submission received."                                   | "Received. Fluncle will give it a listen."                                      |
| DESIGN.md frontmatter description | "Fresh drum & bass transmissions…"                       | "Drum & bass bangers from another dimension, archived under a burning eclipse." |

Functional labels stay literal per the Garnish Rule: "Submit a track", "Search", "Load more", "Playlist", "Telegram" are correct as they are.

## 8. How this composes

- **PRODUCT.md** owns strategy, **DESIGN.md** owns the visual system, **VOICE.md** owns language. Each is leading in its lane.
- Fluncle's voice inherits a baseline (proof over hype, understated confidence, short lines, no em dashes) and bends it with persona (first-person uncle, not founder), scene vocabulary, and the cosmos garnish. Where they disagree (capitalization, persona), VOICE.md wins.
- The `/copywriting-fluncle` skill (`packages/skills/copywriting-fluncle`) operationalizes this: it loads this file first and carries the baseline in `references/voice-baseline.md` and channel shapes in `references/social-formats.md`. Everything published on any surface is written as Fluncle.
