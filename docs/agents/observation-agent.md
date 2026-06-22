# Observation Agent (the audio observation — the third enrichment artifact)

The **audio observation** is Fluncle's spoken, recovered **field observation**: what he saw and felt arriving at a track's coordinate, in the recovered-audio register (VOICE.md §5 — the first _heard_ surface). It rides the same R2 rails the video bundle runs on, and it is a per-finding artifact whose first home is the `/log/<id>` page (an `<audio>` control under the footage); `radio.fluncle.com` later amplifies it. See [track-lifecycle.md](../track-lifecycle.md) for the lifecycle and the data model.

It is one more step the enrich agent runs, after video — not a new runtime. The Worker owns every vendor secret (firecrawl, ElevenLabs, R2); the agent holds only its `FLUNCLE_API_TOKEN` and calls one CLI command.

## The two artifacts (don't conflate them)

|            | `context_note` (the facts)                                                     | the observation script (the voice)                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**   | Firecrawl-derived FACTS: label, year, release context, artist background. Dry. | A 20–45s recovered field observation in Fluncle's voice.                                                                                                                                                                |
| **Source** | The Worker's firecrawl search (or `--context-note` from the agent).            | Written by the **agent** (it holds `copywriting-fluncle`) from the context + track metadata + vibe placement + the video's vehicle/palette. Never a paraphrase of lyrics.                                               |
| **Lives**  | `context_note` column (internal).                                              | `observation.txt` + `observation.json` (`text`) at `found.fluncle.com/<log-id>/`, **mirrored on the `observation_script` column** (internal — the transcript, for the admin dialog + the future radio subtitle render). |
| **Gate**   | none                                                                           | the **voice gate** (below).                                                                                                                                                                                             |

`context_note` is **internal creative fuel** — never rendered on `/log`, never in JSON-LD/RSS/llms.txt, never quotes lyrics, and writing it alone does not bump `updated_at`. It is **not** the editorial `note` (the operator's public "why").

## The command

The agent authors + voice-gates the script, then runs one CLI command. The Worker fetches the factual context, re-scans the script, renders it (ElevenLabs), uploads `observation.{mp3,txt,json}` to `<log-id>/<name>` on R2, and writes `context_note` + `observation_*` back.

```
fluncle admin tracks observe <track_id|log_id> --script-file observation.txt [--duration-ms <probed>] [--voice-id <id>] [--model <model>]
```

- `--script` / `--script-file`: the voice-gated spoken text (with occasional `<break time="0.8s"/>` for v2 pauses). **Required.**
- `--duration-ms`: the agent's `ffprobe` value for the rendered mp3 (ElevenLabs returns no duration; the Worker can't probe). Absent it, the Worker estimates from the target with a ±10% budget — **pass the probed value so the stored duration is true.**
- `--voice-id`: overrides the configured `ELEVENLABS_VOICE_ID` (the bespoke Fluncle voice — the live default).
- `--model`: `eleven_multilingual_v2` (default — stable, on-brand) or `eleven_v3` (more theatrical, riskier).
- `--context-note`: pass a pre-fetched context note to skip the Worker's firecrawl call.

Backed by `POST /api/admin/tracks/:id/observe` (`requireAdmin`-gated, mirrors the video-finalize structure, requires a Log ID). The `observe` command is **auto-allowed** in the command gate (it writes an internal R2 artifact + private field + enrichment fields, posts to **no** public feed) — but each call **spends an ElevenLabs render**, so de-dupe per Log ID (one render per track, not per poll).

## The voice gate (a hard ship requirement)

The script is a live Fluncle voice surface, **heard** in a synthetic voice — a wrong word can't be skimmed past, so it costs more heard than read. Three layers:

1. **Author through `copywriting-fluncle`** in the recovered-audio register. Lead with the **bodily reaction** (the Oof Test), turn to the crew (the Selector's Rule), stay dry (no exclamation marks), say "I" never "we"-as-company.
2. **The mechanical scan** (the Worker re-runs it, defence in depth): **zero** banned identity words (`signal`, `transmission`, and the rest of the VOICE.md §3 list), zero `!`, no "we"-as-company. A violation hard-fails the render before any money is spent.
3. **The North Star sign-off (human):** _"would the uncle say this out loud over a tune?"_ — judged on the **rendered audio** (delivery is half the voice on a spoken surface). The first batch is heard and signed off before the radio surface amplifies it.

## Safety rails (inline so they survive even if the skill fails to load)

- One track per run; one render per Log ID (it costs money).
- `context_note` and the script carry **facts only** — never quote or closely paraphrase lyrics. The Worker filters known lyric domains out of the firecrawl context; a leaked lyric in a _spoken_ artifact is a copyright + voice problem at once.
- Never invent a factual claim; the context note and track props are authoritative.
- The observation carries **no commercial track audio** — only Fluncle's spoken voice. The artifact is internal until the operator stands up a surface that plays it.
- The bespoke Fluncle voice is **live** — `ELEVENLABS_VOICE_ID` points at it in `wrangler.jsonc`, and `observation.ts` tunes the voice settings (stability/style/speed) by ear for it.
- Loudness normalization (ElevenLabs sits ~−24 LUFS vs the −16 web norm) can't run in the Worker. If observations drift in loudness, the agent runs one `loudnorm` ffmpeg pass before passing the mp3 — not a v1 blocker.

## Worker secrets (the operator sets these)

- `ELEVENLABS_API_KEY` — secret (`wrangler secret put ELEVENLABS_API_KEY`).
- `ELEVENLABS_VOICE_ID` — non-secret var in `wrangler.jsonc` (the bespoke Fluncle voice).
- `FIRECRAWL_API_KEY` — already a declared Worker secret.
- R2 (`R2_*`) — already present.
