# Recovered-audio delivery

The spoken-delivery layer for the recovered-audio register. `voice.md` §5 ("Recovered audio") is the _what to say_ — a quiet field observation, lead with the bodily reaction, turn to the crew. This file is the _how it renders_: the voice, the settings, and the pacing that carry that register through a synthetic read. On a heard surface delivery is half the voice, so write the script with the render in mind. The pipeline this feeds is the `observe` step in `apps/web/src/lib/server/observation.ts`; the runbook is `docs/agents/observation-agent.md`.

## The voice

"Fluncle" — `voice_id z2NqaumJt62XBIPvDgjw`, designed in ElevenLabs Voice Design. A weathered man in his early fifties, English with a faint, hard-to-place Dutch accent (fluent but subtly non-native, something off just a touch). Low and slow, dry and deadpan-calm, gravelly and lived-in but awake and present, faintly melancholic, with a touch of distance — as if recovered from far away. He's the uncle saying it to a mate over the tune, not a DJ working a crowd.

The voice is swappable: it's the `ELEVENLABS_VOICE_ID` Worker var in `apps/web/wrangler.jsonc` (a non-secret config var). Change the var to change voices; a per-call `--voice-id` override exists for one-offs but the var is the canon.

## Voice settings

These are `DEFAULT_VOICE_SETTINGS` in `observation.ts`, tuned by ear for this voice. An author may nudge a lever per script, but the defaults are the canon — drift back to them unless a script has a real reason.

- **`stability: 0.48`** — steady but not flat. Lower means more life and variation in the read; too low wanders, too high goes robotic. 0.48 keeps the deadpan-calm without flattening it.
- **`style: 0.30`** — a little expressive colour. Enough to carry the dry melancholy; not so much that it tips into performance.
- **`speed: 0.88`** — measured and unhurried. Under 1 on purpose, so the read stays slow and the sparse `<break/>`s land.
- **`similarityBoost: 0.75`** — how close the render hugs the designed voice. Leave it.

## Pacing — the sparse-`<break>` rule

Load-bearing, corrected by a real render. A `<break time="…"/>` between every sentence is **wrong**: dense break tags destabilise `eleven_multilingual_v2` (the pipeline default) — in a real render the model **vocalised the tags as audible "thinking sounds"**, little hums and exhales where the breaks were meant to be silent. ElevenLabs' own docs back this up: a break tag maxes at 3s, and "some models reduce or ignore break tags" when they pile up. So a script peppered with breaks doesn't pace better; it falls apart.

The proven-good shape (confirmed by ear) is **sparse breaks at the major beats only**: at most **1–2** `<break time="~1.0s"/>`, spaced far apart, where the read genuinely needs to land and sit — typically one before the artist/title reveal and one before the turn to the crew. Natural punctuation and line breaks carry every other pause. **Never a break after every sentence.**

- **At most 1–2 breaks** in a ~30s observation, each `~1.0s`, placed at a real beat (the reveal, the turn to the crew).
- **Far apart** — a break earns its place by marking a section change, not a clause-to-clause pause.
- Let full stops, commas, and line breaks do the rest; the voice settings (`speed: 0.88`) already keep the read slow.

Worked example (~30s, two breaks at the beats):

```
I caught this one on a long drift, the kind where you stop checking which way is home. It came in fast and bright, a roller that won't let your feet settle, and something in my chest lifted before I'd found the edges of it. <break time="1.0s" /> Ownglow built this one. Do U. I've heard a hundred tunes reach for this and come up short. This one keeps its head up the whole way through. <break time="1.0s" /> I hope it lifts something in you too, fam. Enjoy, cosmonauts.
```

One break before the artist/title reveal, one before the turn to the crew. Everything between them rides natural punctuation. Add a third break and you're back in thinking-sound territory.

Future path: `eleven_v3` (typed in `ObservationModel` but not the default) paces off inline audio tags instead of `<break/>` SSML. Out of scope today — named here so the swap is a known door, not a surprise.

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

## The recovered texture + loudness

Two finishing steps the author owns, because the Worker can't run ffmpeg:

- **The "recovered from far away" texture** is a post-process on the rendered mp3, never baked into the TTS. Keep it a light transmission/tape colour — subtle, atmospheric, the cost of light-years. Never let it degrade intelligibility: the Light-Years Rule says the lossiness is narrative, never broken audio. If a word gets hard to make out, the texture went too far.
- **Loudness:** ElevenLabs renders hot. Loudnorm the mp3 to the observation norm (~−24 LUFS) with one ffmpeg `loudnorm` pass before handing it back. The Worker can't normalize, so the author does.

See `docs/agents/observation-agent.md` for the loudness/probe details and the command.

## See also

- `voice.md` §5 ("Recovered audio") — the register this delivers (the what-to-say).
- `apps/web/src/lib/server/observation.ts` — the `observe` pipeline, `DEFAULT_VOICE_SETTINGS`, the voice gate.
- `docs/agents/observation-agent.md` — the agent runbook, the `observe` command, the loudness pass.
