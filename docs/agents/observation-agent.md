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

Backed by `POST /api/v1/admin/tracks/:id/observe` (`requireAdmin`-gated, mirrors the video-finalize structure, requires a Log ID). The `observe` command is **agent-tier** — the boundary is the server-side role, not any local command gate (it writes an internal R2 artifact + private field + enrichment fields and posts to **no** public feed, so the box's agent-scoped token drives it) — but each call **spends a Cartesia render**, so de-dupe per Log ID (one render per track, not per poll).

## The anti-sameness rail (the vibe-neighbour layer + the echo gate)

The observation pipeline uses a vibe-neighbour authoring layer and deterministic echo gate that read the same neighbourhood:

1. **The vibe-neighbour layer (authoring).** The box sweep fetches the finding's sonic neighbours' stored observation scripts over the AGENT-tier `list_observation_neighbours` read (`GET /api/v1/admin/tracks/:id/observation-neighbours` — the MuQ embedding's nearest findings, the same six the note layer uses) and hands them to the model as what this region of the archive ALREADY SOUNDS LIKE — every opener, closer, body reaction, and sign-off in them is SPENT. The prompt (registry slug `observation_script`) also breaks the closer formula explicitly: the crew address is one move with many shapes (rotate the kin name — junglist, raver, fam, cosmonaut — vary the phrasing, sometimes no sign-off at all), never the "hope it… enjoy, cosmonauts" default. `OBSERVE_NEIGHBORS=0` is the kill switch / A-B control.
2. **The echo gate (mechanical, on the Worker, BEFORE the render).** `observe_track` re-reads the same neighbours and scores the draft with the note gate's exact primitives (`scoreObservationEcho` — a shared `scoreEcho` in note.ts, so "same" has one definition across both written families). A lifted phrase (≥4 consecutive shared words carrying a content word) or wholesale content-word overlap (≥0.3 Jaccard) is an `observation_echoes_neighbours` 422 — thrown before Cartesia is called, so a bounced draft costs nothing. The sweep re-authors ONCE with the spent move named back to it; a second echo leaves the finding unvoiced and queued (silence beats a generic read). The thresholds are operator-tunable at runtime (`fluncle admin observations gate`, or `PATCH /admin/observation-gate`) — their own `settings` keys, independent of the note gate's.

**A rejected script is HELD, never binned** — the `observation_rejections` ledger (one OPEN row per finding, bounded by a partial unique index) keeps the script, the neighbour it echoed, that neighbour's script as it read at the time, the lifted phrase, the score, and the thresholds in force, and raises a row in the `/admin` attention queue (`observation-rejected`). The operator reads it in the finding's observation dialog (the held-observation panel, the held-note panel's spoken sibling) and rules: **Render it** (operator-tier — it spends a Cartesia render, going through the same shared render path the observe endpoint uses, and a finding that got voiced in the meantime is skipped rather than re-rendered) or **Bin it** settles the rejection; the finding remains eligible on the next sweep. A held row goes moot on its own the moment the finding gets an observation by any path. `force` on `observe_track` (a deliberate operator re-render) skips the gate — it is the same overrule, inline.

The `context_distil` prompt requires track-specific sensory pointers and excludes the listed house words (`rolling`/`liquid`/`introspective`/`atmospheric`/`breakbeats`) while keeping the `Texture:` shape stable.

Use `measure-artifact-diversity.ts` to inspect openers, closers, opening-word distribution, crutch words, overlap, and lifted phrases.

## The voice gate (a hard ship requirement)

The script is a live Fluncle voice surface, **heard** in a synthetic voice — a wrong word can't be skimmed past, so it costs more heard than read. Four layers:

1. **Author through `copywriting-fluncle`** in the recovered-audio register. Lead with the **bodily reaction** (the Oof Test), turn to the crew (the Selector's Rule), stay dry (no exclamation marks), say "I" never "we"-as-company.
2. **The mechanical scan** (the Worker re-runs it, defence in depth): **zero** banned identity words (`signal`, `transmission`, and the rest of the VOICE.md §3 list), zero `!`, no "we"-as-company. A violation hard-fails the render before any money is spent.
3. **The name exemption** — the gate polices what Fluncle WROTE, not the names he was given. Before the scan runs, every name the artifact is about is masked out of the text (`maskSubjectNames` in `observation.ts`); everything around it is scanned exactly as before. Without it the gate is UNSATISFIABLE rather than strict: the read is ABOUT a record and the scan read that record's own artist and title, so a finding by "Future Signal" could never be voiced, however many times it was rewritten — at the head of a cap-1 oldest-first queue. The masking is the full name, word-bounded, so a partial reference ("Signal" for "Future Signal") still trips the ban and a short name ("Sign") can never amnesty a longer word it sits inside. A name that is EXACTLY one banned token is REFUSED from the exempt set (`UNSAYABLE_NAMES`): masking it would delete every occurrence and stop the gate policing that word for the whole piece — a total amnesty rather than an exemption, and here it would also lift the earthly-geography ban, which the bio's version of this masking never touched (`gateBioText` scans with `allowGeography: true`, so a bio was never policing "london"; this gate is). That stays satisfiable because naming is OPTIONAL on this surface: the prompt says name the artist "only if it sharpens the read", so a read about the artist Signal simply does not say "Signal". A bio cannot make the same trade — its whole job is to introduce its subject — which is why `maskEntityName` keeps the accepted cost and `maskSubjectNames` does not.
4. **The North Star sign-off (human):** _"would the uncle say this out loud over a tune?"_ — judged on the **rendered audio** (delivery is half the voice on a spoken surface). The first batch is heard and signed off before the radio surface amplifies it.

## The attempt budget (the end of the retry-forever loop)

A gate rejection used to be a plain skip that left the item queued with **nothing counting the tries**, so "retry" meant "forever". The queue is `BATCH_CAP=1` over an oldest-first worklist, so an unvoiceable finding did not merely waste its own tokens, it blocked every finding behind it. The sibling of this bug, in the entity-bio crons, re-authored three slugs ~90 times each over two days.

So the sweep now keeps a per-item **attempt ledger** (`docs/agents/hermes/scripts/attempt-ledger.ts`, a flat TSV under `$HOME/.observe-sweep/attempts` that survives a tick, a container swap, and a rebake). A finding gets **three refused passes, ever**, and then this sweep never authors for it again.

- **Only a Worker VERDICT spends it, keyed on an exact rejection code.** A `claude -p` that exits non-zero, returns `is_error`, or returns nothing is no evidence about the item at all — there is no draft — so it costs nothing, and the `/status` sweep-strain detector watches it instead. The same rule covers the HTTP leg: the sweep's skip classifier still matches a bare `403`/`422`/`forbidden` (an infra refusal must leave the item queued rather than read as a hard error), but the BUDGET keys only on the codes the Worker emits after reading the draft (`WORKER_REJECTION_CODES` in the sweep). Otherwise an expired agent token — which 4xxs every call — would march down the cap-1 queue writing off one healthy item per few ticks.
- **The echo gate is charged as a deliberate trade, not as proof.** A voice or length rejection is a property of the draft alone. An echo rejection is scored against the item's NEIGHBOURHOOD, so it is a property of the draft _and_ the corpus around it, and it gets harder as the archive fills — three echo refusals are not proof the draft was bad. It is charged anyway, because the alternative is an item that always echoes sitting at the head of a cap-1 queue burning two authorings a tick forever, blocking everything behind it. The cost is visible and reversible: a rejected script is HELD in the `observation_rejections` ledger and raised in the `/admin` attention queue, and deleting the item's line from the ledger re-arms it once the neighbourhood has moved on.
- **NO final-attempt bypass** (the operator's ruling, 2026-07-30). The bio sweep stores its third draft even when the gate refused it, because an empty bio slot leaves an entity page half-built. An observation is optional editorial and an unvoiced finding is a perfectly good state — and rendering a refused draft would spend Cartesia credits to publish it — so gate-failed copy is **never** published to close a queue. An exhausted item is simply skipped, counted in the tick's `exhausted` summary field, and reported once in the sweep's stderr.
- **An exhausted item never blocks the queue.** Exhausted rows are filtered out **before** the `BATCH_CAP` is applied, so a spent budget only ever costs the item that spent it — otherwise the fix would trade an unbounded retry loop for a permanent stall, which is worse.
- **A landed artifact clears the budget**, so a re-queued item starts fresh; deleting an item's line from the ledger is how the operator re-arms it after the gate or the prompt changes.

## Synced captions (the `observation_alignment_json` column)

The observation carries **word-level caption timings** so the spoken read can be subtitled in sync — the current word lights as it's heard. They live on the `observation_alignment_json` column (a JSON `{ source, words: [{ text, startMs, endMs }] }`) and ride the public `TrackListItem` as `observationAlignment`. The radio player renders captions from the shared schedule clock so they remain aligned through resyncs and while muted.

**Fresh renders** capture alignment at generation time, Worker-side: the observe render streams Cartesia's `/tts/sse` endpoint with `add_timestamps` on (one call → raw PCM + word timestamps), and the Worker normalises the parallel timestamp arrays into words. A missing/malformed alignment is stored as absent — captions degrade to none, never a failed render. Caption readers support generation-time alignment and rows whose source is `forced-alignment`.

Writing alignment does **not** bump `updated_at` (it describes an existing artifact, so it moves no public lastmod).

## Safety rails (inline so they survive even if the skill fails to load)

- One track per run; one render per Log ID (it costs money).
- Ground every factual claim in the context note or track properties, and do not quote or closely paraphrase lyrics.
- The observation carries **no commercial track audio** — only Fluncle's spoken voice. The artifact is internal until the operator stands up a surface that plays it.
- `CARTESIA_VOICE_ID` points at the cloned Fluncle voice in `wrangler.jsonc`. `observation.ts` sets `DEFAULT_CARTESIA_SPEED = 0.85` and `DEFAULT_CARTESIA_EMOTION = "excited"`.
- Loudness normalization (the render can sit hot vs the ~−24 LUFS observation norm) cannot run in the Worker. If observations drift in loudness, run one `loudnorm` pass before supplying the MP3.

## Worker secrets (the operator sets these)

- `CARTESIA_API_KEY` — secret (`wrangler secret put CARTESIA_API_KEY`).
- `CARTESIA_VOICE_ID` — non-secret var in `wrangler.jsonc` (the cloned Fluncle voice).
- `FIRECRAWL_API_KEY` — already a declared Worker secret.
- `OPENROUTER_API_KEY` — secret, drives the context-note distil pass. Read via `readOptionalEnv`: unset ⇒ the distil degrades gracefully to the cleaned raw snippets (never blocks a render).
- `OPENROUTER_CONTEXT_MODEL` — OPTIONAL non-secret var overriding the distil model; absent, defaults to `anthropic/claude-haiku-4.5`.
- R2 (`R2_*`) — already present.

## The prompt lives in the DATABASE, not in the image

The authoring prompt is the `observation_script` entry in the **prompt registry** ([docs/agents/prompt-registry.md](./prompt-registry.md)). The sweep fetches it over the AGENT-tier `get_prompt` each tick, so the operator retunes it from `/admin/prompts` or the `fluncle admin prompts` CLI with **no deploy and no box rebake**.

The repo provides the baked default; a failed registry fetch falls back to it and logs the failure. Every observation records the version that drafted it in `findings.observation_prompt_version` (`0` = the repo's default, `N` = override N, `NULL` = the baked fallback wrote it).
