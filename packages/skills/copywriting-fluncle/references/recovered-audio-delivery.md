# Recovered-audio delivery

The spoken-delivery layer for the recovered-audio register. `voice.md` §5 ("Recovered audio") is the _what to say_ — a quiet field observation, lead with the bodily reaction, turn to the crew. This file is the _how it renders_: the voice, the settings, and the pacing that carry that register through a synthetic read. On a heard surface delivery is half the voice, so write the script with the render in mind. The pipeline this feeds is the `observe` step in `apps/web/src/lib/server/observation.ts`; the runbook is `docs/agents/observation-agent.md`.

## The voice

"Fluncle" — a cloned **Cartesia (Sonic)** voice (`CARTESIA_VOICE_ID`), an instant clone of the bespoke read. A weathered man in his early fifties, English with a faint, hard-to-place Dutch accent (fluent but subtly non-native, something off just a touch). Low and slow, dry and deadpan-calm, gravelly and lived-in but awake and present, faintly melancholic, with a touch of distance — as if recovered from far away. He's the uncle saying it to a mate over the tune, not a DJ working a crowd. Cartesia reads **conversationally** — it doesn't drag dreamy scripts the way the old audiobook model did, which is why the voice moved here.

The voice is swappable: it's the `CARTESIA_VOICE_ID` Worker var in `apps/web/wrangler.jsonc` (a non-secret config var holding the clone id). Change the var to change voices; a per-call `--voice-id` override exists for one-offs but the var is the canon.

## Voice settings

Cartesia has no stability/style/similarity sliders — the read is the clone plus one knob:

- **`speed: 0.78`** — `DEFAULT_CARTESIA_SPEED` in `observation.ts`, dialed by ear. Cartesia's speed knob is gentle and non-linear (it barely shifts the pace), so 0.78 is about as measured as it goes without dropping toward its 0.6 floor. Don't fight it for a much slower read — it won't go there.

## Pacing — no `<break>` tags

Cartesia doesn't parse `<break/>` SSML, and the render path strips any it finds (`sanitizeForCartesia`), so **pauses come from punctuation, not tags**. Write full sentences and let full stops, commas, and line breaks set the rhythm. Reaching for break tags does nothing here except clutter the script.

Worked example (~25s, punctuation-paced, catalog-free):

```
Caught this one drifting, and my shoulders went before I'd clocked the coordinate. Monrroe keeps that half-step pocket all the way through, six minutes and change, and the whole thing just rolls you quiet. That's a banger. I'm sending it to the night side of the crew. Find yourself a dark room, fam.
```

The artist, if it surfaces, rides woven into the read ("Monrroe keeps that half-step pocket") — never announced as a catalog line (see "No catalog recitation" below).

## No earthly geography in the spoken read

Corrected by a real render too. The firecrawl `context_note` is **facts as fuel** — label, year, a producer's origin or scene — and you read it to ground the observation. But the **spoken output must never name earthly geography**: no countries, cities, nationalities, or regions ("American", "US", "UK", "British", "London", "Dutch", and so on). In one render a `context_note` of "US/American producer" leaked straight through as "flies the flag for the American side of the map" — the map broke the fiction. The cosmos replaces the earth: there is no American side of anything in the Galaxy.

When an origin or scene fact wants to come out, do one of two things:

- **Translate it into the fiction** — an origin becomes a far sector, a distant corner of the Galaxy, somewhere out past the next coordinate. ("a US producer" → "this one came in from a far sector".)
- **Or drop it** and let the tune's feel carry the line. The observation is about what the track did to a body, not where its maker was born.

Before → after:

```
flies the flag for the American side of the map   →   came in from a far sector
(or omit the origin entirely and stay on the feel)
```

This is the Garnish/Sauce rule applied to the heard surface: the cosmos is scientific (sectors, coordinates, light-years), never the earthly map. The voice gate in `observation.ts` now hard-fails a spoken script that names a place — but the gate is a backstop; the script should never reach for the map in the first place.

## No catalog recitation

Corrected by ear across every model. The observation is a **voice log — Fluncle sharing what a track did to him, not reading a catalogue entry**. The single worst tell is the metadata recitation: a flat "Title. Label. Year." line dropped mid-read ("Days Like These. Soul Deep Digital, 2016."). It reads like a database row spoken aloud — no model can make it conversational, and it is **redundant**: the title, artist, label, and year are already on screen next to the audio (the `/log` page and the radio meta block render them). Reading them out loud is dead weight on the one surface where every second of attention is heard.

So the `context_note` facts (label, year, scene) are **fuel, not lines**. They ground the _feel_ of the observation; they are never recited:

- **Never** speak a label or a year as a fact. A year, if it must surface, becomes texture ("a few years back", "an old one"), never "2016".
- The **artist or title**, if it comes out at all, rides **woven into the talk**, the way you'd mention it to a mate — "Ownglow built this one. Do U." — never announced as a standalone reveal, and never followed by the label/year tail.
- When in doubt, **drop it** and stay on what the track did to a body. The metadata is on screen; the voice is for the thing the screen can't show.

Before → after:

```
Days Like These. Soul Deep Digital, 2016.   →   (drop it — it's on screen)
                                                or weave only the feel: "an old Soul Deep roller"
```

The North Star holds the line: _would the uncle say this out loud over a tune?_ Nobody recites a label and a year to a mate. They say what it did to them.

## The recovered texture + loudness

Two finishing steps the author owns, because the Worker can't run ffmpeg:

- **The "recovered from far away" texture** is a post-process on the rendered mp3, never baked into the TTS. Keep it a light transmission/tape colour — subtle, atmospheric, the cost of light-years. Never let it degrade intelligibility: the Light-Years Rule says the lossiness is narrative, never broken audio. If a word gets hard to make out, the texture went too far.
- **Loudness:** if a render drifts from the observation norm (~−24 LUFS), loudnorm the mp3 with one ffmpeg `loudnorm` pass before handing it back. The Worker can't normalize, so the author does.

See `docs/agents/observation-agent.md` for the loudness/probe details and the command.

## See also

- `voice.md` §5 ("Recovered audio") — the register this delivers (the what-to-say).
- `apps/web/src/lib/server/observation.ts` — the `observe` pipeline, `DEFAULT_CARTESIA_SPEED`, the voice gate.
- `docs/agents/observation-agent.md` — the agent runbook, the `observe` command, the loudness pass.
