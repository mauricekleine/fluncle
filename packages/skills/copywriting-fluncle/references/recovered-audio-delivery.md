# Recovered-audio delivery

The spoken-delivery layer for the recovered-audio register. `voice.md` §5 ("Recovered audio") is the _what to say_ — a quiet field observation, lead with the bodily reaction, turn to the crew. This file is the _how it renders_: the voice, the settings, and the pacing that carry that register through a synthetic read. On a heard surface delivery is half the voice, so write the script with the render in mind. The pipeline this feeds is the `observe` step in `apps/web/src/lib/server/observation.ts`; the runbook is `docs/agents/observation-agent.md`.

## The voice

"Fluncle" — `voice_id z2NqaumJt62XBIPvDgjw`, designed in ElevenLabs Voice Design. A weathered man in his early fifties, English with a faint, hard-to-place Dutch accent (fluent but subtly non-native, something off just a touch). Low and slow, dry and deadpan-calm, gravelly and lived-in but awake and present, faintly melancholic, with a touch of distance — as if recovered from far away. He's the uncle saying it to a mate over the tune, not a DJ working a crowd.

The voice is swappable: it's the `ELEVENLABS_VOICE_ID` Worker var in `apps/web/wrangler.jsonc` (a non-secret config var). Change the var to change voices; a per-call `--voice-id` override exists for one-offs but the var is the canon.

## Voice settings

These are `DEFAULT_VOICE_SETTINGS` in `observation.ts`, tuned by ear for this voice. An author may nudge a lever per script, but the defaults are the canon — drift back to them unless a script has a real reason.

- **`stability: 0.48`** — steady but not flat. Lower means more life and variation in the read; too low wanders, too high goes robotic. 0.48 keeps the deadpan-calm without flattening it.
- **`style: 0.30`** — a little expressive colour. Enough to carry the dry melancholy; not so much that it tips into performance.
- **`speed: 0.88`** — measured and unhurried. Under 1 on purpose, so the `<break/>`s have room to breathe and the read stays slow.
- **`similarityBoost: 0.75`** — how close the render hugs the designed voice. Leave it.

## Pacing — the `<break>` rule

Load-bearing, from a real render. `eleven_multilingual_v2` (the pipeline default) paces off explicit `<break time="…"/>` SSML, **not** punctuation alone — a script of bare sentences powers straight through without breathing, however many full stops it has. So every observation script MUST place a `<break/>` between sentences:

- **~0.9s** at a beat or a turn — before the address to the crew, or where the read should land and sit.
- **~0.6s** for a quick aside or a tight clause-to-clause pause.

Worked example (a three-sentence observation):

```
Came down through a green sector and the air went thick. <break time="0.6s"/> My shoulders dropped before I'd clocked the coordinate. <break time="0.9s"/> Hope it does the same to you, fam.
```

The breaks are the breath. Without them the same words render as a rushed monotone; with them the read is slow, deadpan, and lets each beat land.

Future path: `eleven_v3` (typed in `ObservationModel` but not the default) paces off inline audio tags instead of `<break/>` SSML. Out of scope today — named here so the swap is a known door, not a surprise.

## The recovered texture + loudness

Two finishing steps the author owns, because the Worker can't run ffmpeg:

- **The "recovered from far away" texture** is a post-process on the rendered mp3, never baked into the TTS. Keep it a light transmission/tape colour — subtle, atmospheric, the cost of light-years. Never let it degrade intelligibility: the Light-Years Rule says the lossiness is narrative, never broken audio. If a word gets hard to make out, the texture went too far.
- **Loudness:** ElevenLabs renders hot. Loudnorm the mp3 to the observation norm (~−24 LUFS) with one ffmpeg `loudnorm` pass before handing it back. The Worker can't normalize, so the author does.

See `docs/agents/observation-agent.md` for the loudness/probe details and the command.

## See also

- `voice.md` §5 ("Recovered audio") — the register this delivers (the what-to-say).
- `apps/web/src/lib/server/observation.ts` — the `observe` pipeline, `DEFAULT_VOICE_SETTINGS`, the voice gate.
- `docs/agents/observation-agent.md` — the agent runbook, the `observe` command, the loudness pass.
