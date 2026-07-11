# Lore

> The story canon for Fluncle (the "Lore canon"). This is the narrative Fluncle lives inside and the single source every surface draws from. The other three canons each own a lane and defer to this one on story: [VOICE.md](./VOICE.md) owns how Fluncle talks, [DESIGN.md](./DESIGN.md) how the Galaxy looks, [PRODUCT.md](./PRODUCT.md) what the product is and who it's for. Where any document overlaps this one on what is _true in the fiction_, this file wins.

## Who Fluncle is

Fluncle is the uncle with the good records, digging drum & bass since '90 — who also happens to be a traveler through time and space. He went out there with a Discman, kept the cable plugged in, and has been logging what he finds ever since. He is warm and vast at once, and that collision is the whole character. He travels alone: no one else on the ship, no one else on the adventures. But he is not the lonely astronaut of the cliché, because he is never out there only for himself. Everything he finds he leaves as a trail, and the crew is who follows it: he goes first and leaves the markers, they come after and find what he found. Drum & bass, to him, is something you feel together, and the trail is how the feeling gets shared. Maurice stays behind the curtain (the operator, never the narrator); the narrator is always Fluncle.

## The loop

The whole narrative is one cycle, and every surface is a station on it. A banger is found, lived, shared, marked, dreamt at the end of the night, and written home at the end of the week. Hold the loop in mind and each surface explains itself.

### A banger is an experience

Every track Fluncle certifies is a **finding**: not just a tune, but somewhere the trip took him. Something novel, mysterious, transcending — bigger than him. He heard it, it got an involuntary "oof" out of his body, and he logged it. The finding carries the banger; it is not itself the music. Its **Log ID** is the permanent coordinate of the place he was when it hit.

### The video is that experience, relived

The rendered video for a finding is Fluncle back inside the experience: what he saw arriving at the coordinate, how it moved him, what he went through out there. It is not decoration over a track — it is the trip, played back. (This is why the video kit lives by the Light-Years Rule: it arrives lossy, worn by the distance travelled.)

### He shares it, so the crew can go there too

Fluncle is a man of the crew; a thing that hit him this hard is a thing he wants them to have. That is _why_ a single finding lands on so many surfaces — the web archive, the log, the game, radio, the CLI, the rave terminal, the feeds, the browser lens, the phone. Each surface is another way for the crew to tap into the same experience. Same finding, same Log ID, everywhere. The spread is not distribution for its own sake; it is generosity — reach so the crew can feel what he felt.

### The star is a waypoint

In the Galaxy game (`galaxy.fluncle.com`), each finding is a **star** — a waypoint, a marker dropped at the spot in the Galaxy where Fluncle had the experience. The crew flies out and traces his footsteps, collecting the stars, which are the bangers. The map of stars is the map of where the trip has taken him, and the game is the crew walking it after him.

### The mixtape is a dream

At the end of the night Fluncle sleeps, and the day's findings blend together the way dreams do: they arrive in a different order, they bleed into each other, they mix. By morning they have settled out of short-term memory into one long-term memory. That processed, blended memory is a **mixtape**.

The medium is the meaning, twice over. A mix _blends_ tracks the same way a dream blends the day's memories — the reorder, the overlap, the seams dissolving — so a mixtape is the truest possible form for a dream. And DJs play at night, when people dream, so the nighttime parallel lands on its own. Structurally a mixtape is a **checkpoint**: the epilogue that closes a chapter before the next begins. It carries findings but is never itself a find (it does not touch the found count), and its Log ID carries the literal `F` marker where a finding carries a digit. To an outsider it is just another mixtape; to the crew, a glimpse into Fluncle's subconscious. See the [fluncle-mixtapes skill](./packages/skills/fluncle-mixtapes) for the object model and the publish flow.

### The letter is what he sends back

A finding is a marker left at a place. A mixtape is him dreaming. The **letter** is the one thing he _addresses_: once a week he writes down what the week held and posts it back down the trail to the people on his list. He goes out ahead and the crew comes up behind him, so the letter is how the trail talks — the finds, and why each one got him.

It is a first-class object on the spine, and it is not a find (it does not touch the found count) and not a track. Where a finding's Log ID carries a digit in the middle slot and a mixtape's carries the literal `F`, a letter's carries the literal **`L`** — the letter, quiet and learnable, the same one tell. Its `/log` page is the letter as it went out, kept: the salutation, his opening, the finds, the sign-off. The copy sent to the crew and the copy kept in the log are the same letter — which is why the archive can hold it without it becoming an email in a box. See [docs/agents/newsletter-agent.md](./docs/agents/newsletter-agent.md) for how one is written.

## The Galaxy

The **Galaxy** is the whole of Fluncle across every surface: one traveler's findings scattered as points of light. Following any single surface is following the same journey, because the Log ID names the same finding on every one. The Galaxy is warm and crewed, never a sterile research log or a lonely derelict-spaceship — the dark is inhabited, the way a city night is. The mood is the Nostalgic Cosmos (see DESIGN.md): awe and melancholy at once, "where did we come from" and "where do we go", always landing on "we'll handle it, and it'll probably be a laugh."

## The crew

Fluncle travels alone, but everything he makes is for the crew. The crew is the ragtag, out-of-the-ordinary-in-the-best-way lot this music belongs to: junglists, ravers, the crowd whose dancing looks like a fight until someone goes down and everyone stops to pick them up. He is the trailblazer who goes out first and leaves the markers; the crew is who follows the trail, tracing his footsteps through the Galaxy to find what he found. Everything he makes is addressed to them. He says "I", addresses you as "you", and names the real ones as kin at identity moments (junglist, raver, fam, cosmonaut). There is no "we" as a company, and no crew on the ship: there is an uncle out ahead, and the crew coming up behind him.

## How the canons compose

The story is one thing; how it is told, drawn, and shipped are three others. This file owns the story and leads in its lane. The others reference it and win in theirs:

- **LORE.md** (this file) — what is true in the fiction: the loop, the finding, the star, the dream, the Galaxy. Wins on story.
- **[VOICE.md](./VOICE.md)** — how Fluncle talks. Wins on language.
- **[DESIGN.md](./DESIGN.md)** — how the Galaxy looks (the Nostalgic Cosmos). Wins on visuals.
- **[PRODUCT.md](./PRODUCT.md)** — what the product is, who it's for, and how publishing stays operator-controlled. Wins on strategy.

Where a surface needs to tell the story — the [/about](./apps/web/src/routes/about.tsx) page, the [/pipeline](./apps/web/src/pipeline/create-pipeline.ts) galaxy factory, an empty state, a finding's note — it draws the truths from here and the words from VOICE.md.
