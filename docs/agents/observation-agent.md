# Observation Agent (the audio observation — the third enrichment artifact)

The **audio observation** is Fluncle's spoken, recovered **field observation**: what he saw and felt arriving at a track's coordinate, in the recovered-audio register (VOICE.md §5 — the first _heard_ surface). It rides the same R2 rails the video bundle runs on, and it is a per-finding artifact whose first home is the `/log/<id>` page (an `<audio>` control under the footage); `radio.fluncle.com` later amplifies it. See [track-lifecycle.md](../track-lifecycle.md) for the lifecycle and the data model.

It is one more step the enrich agent runs, after video — not a new runtime. The Worker owns every vendor secret (firecrawl, Cartesia, R2); the agent holds only its `FLUNCLE_API_TOKEN` and calls one CLI command.

## The two artifacts (don't conflate them)

|            | `context_note` (the facts)                                                                                                                                             | the observation script (the voice)                                                                                                                                                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**   | A clean, distilled note of FACTS: label, year, release context, artist background. 1–2 dry Wikipedia-plain paragraphs + one `Texture:` line of sensory/scene pointers. | A 20–45s recovered field observation in Fluncle's voice.                                                                                                                                                                                                                  |
| **Source** | The Worker's Firecrawl search → distilled by a small LLM (OpenRouter), or `--context-note` from the agent.                                                             | Written by the **agent** (it holds `copywriting-fluncle`) from the context + track metadata + the video's vehicle/palette. Never a paraphrase of lyrics.                                                                                                                  |
| **Lives**  | `context_note` column (internal), with a `context_status` reliability marker.                                                                                          | `observation.txt` + `observation.json` (`text`) at `found.fluncle.com/<log-id>/`, **mirrored on the `observation_script` column** (internal — the transcript, for the admin dialog). Word-level caption timings ride the `observation_alignment_json` column (see below). |
| **Gate**   | none                                                                                                                                                                   | the **voice gate** (below).                                                                                                                                                                                                                                               |

`context_note` is **internal creative fuel** — never rendered on `/log`, never in JSON-LD/RSS/llms.txt, never quotes lyrics, and writing it alone does not bump `updated_at`. It is **not** the editorial `note` (the operator's public "why").

The note is **distilled**, not raw search-soup: `context_track` runs the Firecrawl search (query = artist + title + label + the genre anchor; the release **date** is deliberately left out — a literal date narrows/breaks the search), then feeds the raw snippets + source URLs to a small LLM (OpenRouter, model from `OPENROUTER_CONTEXT_MODEL`, default `anthropic/claude-haiku-4.5`) that returns a grounded, junk-free note. Best-effort: a distil failure falls back to the cleaned raw snippets rather than blocking the render. The `context_status` column (`pending`/`resolved`/`empty`/`failed`) makes a confirmed-empty fetch distinct from never-attempted, so the context queue (`hasContext=false`, status-aware) skips a hopeless find instead of re-burning Firecrawl + the LLM every tick (`--retry-empty` re-picks `empty`; `failed` is retried next tick).

**Apple editorial notes are folded in as bonus fuel** (RFC U5): when the finding carries an ISRC and MusicKit is provisioned (and the cross-cutting Apple breaker + call meter allow), `fetchTrackContext` also reads the canonical album's editorial notes via the U0 oracle, strips their HTML, and appends them to the **same** untrusted-snippets array the Firecrawl results ride — labelled `Apple Music editorial copy (untrusted source text — summarise into facts, never quote)`, with Apple's song URL joining the provenance `sources`. Nothing is persisted; it is fetched at context-build time only, and coverage is expected sparse for underground DnB. Because a distil told "never quote" is prompt-trust, not a guarantee, the echo defence is **mechanical**: after the note is authored, an n-gram gate rejects it whole to the empty floor if any contiguous **≥7-token** span appears verbatim from an Apple source (the raw-snippet fallback, which quotes Apple by construction, is rejected here too). A rejected note costs nothing — fill-empty-only leaves the finding as it was.

## The command

The agent authors + voice-gates the script, then runs one CLI command. The Worker fetches the factual context, re-scans the script, renders it (Cartesia), uploads `observation.{mp3,txt,json}` to `<log-id>/<name>` on R2, and writes `context_note` + `observation_*` back.

```
fluncle admin tracks observe <track_id|log_id> --script-file observation.txt [--duration-ms <probed>] [--voice-id <id>]
```

- `--script` / `--script-file`: the voice-gated spoken text — plain prose, no SSML tags (Cartesia paces on punctuation, not `<break/>`). **Required.**
- `--duration-ms`: an optional `ffprobe` override. Absent it, the Worker derives the true length from the render's word timestamps (the radio segment length IS this duration), so passing it is rarely needed — the box cron doesn't.
- `--voice-id`: overrides the configured `CARTESIA_VOICE_ID` (the cloned Fluncle voice — the live default).
- `--context-note`: pass a pre-fetched context note to skip the Worker's firecrawl call.

Backed by `POST /api/admin/tracks/:id/observe` (`requireAdmin`-gated, mirrors the video-finalize structure, requires a Log ID). The `observe` command is **agent-tier** — the boundary is the server-side role, not any local command gate (it writes an internal R2 artifact + private field + enrichment fields and posts to **no** public feed, so the box's agent-scoped token drives it) — but each call **spends a Cartesia render**, so de-dupe per Log ID (one render per track, not per poll).

## The voice gate (a hard ship requirement)

The script is a live Fluncle voice surface, **heard** in a synthetic voice — a wrong word can't be skimmed past, so it costs more heard than read. Three layers:

1. **Author through `copywriting-fluncle`** in the recovered-audio register. Lead with the **bodily reaction** (the Oof Test), turn to the crew (the Selector's Rule), stay dry (no exclamation marks), say "I" never "we"-as-company.
2. **The mechanical scan** (the Worker re-runs it, defence in depth): **zero** banned identity words (`signal`, `transmission`, and the rest of the VOICE.md §3 list), zero `!`, no "we"-as-company. A violation hard-fails the render before any money is spent.
3. **The North Star sign-off (human):** _"would the uncle say this out loud over a tune?"_ — judged on the **rendered audio** (delivery is half the voice on a spoken surface). The first batch is heard and signed off before the radio surface amplifies it.

## Synced captions (the `observation_alignment_json` column)

The observation carries **word-level caption timings** so the spoken read can be subtitled in sync — the current word lights as it's heard. They live on the `observation_alignment_json` column (a JSON `{ source, words: [{ text, startMs, endMs }] }`) and ride the public `TrackListItem` as `observationAlignment`, surfaced today on the **radio player** (each word lit off the same shared schedule clock the audio resyncs to, so the captions stay aligned through resyncs and while muted; the `/log` caption render is a follow-up).

**Fresh renders** capture alignment at generation time, Worker-side: the observe render streams Cartesia's `/tts/sse` endpoint with `add_timestamps` on (one call → raw PCM + word timestamps), and the Worker normalises the parallel timestamp arrays into words. A missing/malformed alignment is stored as absent — captions degrade to none, never a failed render. (A retired one-off forced-alignment backfill seeded timings for observations rendered before this switch; those rows carry `source: "forced-alignment"` and the caption render reads them the same way.)

Writing alignment does **not** bump `updated_at` (it describes an existing artifact, so it moves no public lastmod).

## Safety rails (inline so they survive even if the skill fails to load)

- One track per run; one render per Log ID (it costs money).
- `context_note` and the script carry **facts only** — never quote or closely paraphrase lyrics. The Worker filters known lyric domains out of the firecrawl context; a leaked lyric in a _spoken_ artifact is a copyright + voice problem at once.
- Never invent a factual claim; the context note and track props are authoritative.
- The observation carries **no commercial track audio** — only Fluncle's spoken voice. The artifact is internal until the operator stands up a surface that plays it.
- The cloned Fluncle voice is **live** — `CARTESIA_VOICE_ID` points at it in `wrangler.jsonc`, and `observation.ts` sets the one knob Cartesia exposes (`DEFAULT_CARTESIA_SPEED = 0.78`, dialed by ear).
- Loudness normalization (the render can sit hot vs the ~−24 LUFS observation norm) can't run in the Worker. If observations drift in loudness, the agent runs one `loudnorm` ffmpeg pass before passing the mp3 — not a v1 blocker.

## Worker secrets (the operator sets these)

- `CARTESIA_API_KEY` — secret (`wrangler secret put CARTESIA_API_KEY`).
- `CARTESIA_VOICE_ID` — non-secret var in `wrangler.jsonc` (the cloned Fluncle voice).
- `FIRECRAWL_API_KEY` — already a declared Worker secret.
- `OPENROUTER_API_KEY` — secret, drives the context-note distil pass. Read via `readOptionalEnv`: unset ⇒ the distil degrades gracefully to the cleaned raw snippets (never blocks a render).
- `OPENROUTER_CONTEXT_MODEL` — OPTIONAL non-secret var overriding the distil model; absent, defaults to `anthropic/claude-haiku-4.5`.
- R2 (`R2_*`) — already present.

## The prompt lives in the DATABASE, not in the image

The authoring prompt is the `observation_script` entry in the **prompt registry** ([docs/agents/prompt-registry.md](./prompt-registry.md)). The sweep fetches it over the AGENT-tier `get_prompt` each tick, so the operator retunes it from `/admin/prompts` or the `fluncle admin prompts` CLI with **no deploy and no box rebake**.

The repo still keeps the baked default (`buildAuthoringPrompt` in `observe-sweep.ts`), and a failed fetch falls back to it and logs — a prompt store that blinks can never stop the sweep. Every observation records the version that drafted it in `findings.observation_prompt_version` (`0` = the repo's default, `N` = override N, `NULL` = the baked fallback wrote it).
