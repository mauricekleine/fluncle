# Note Agent (the auto-note — the written-note sibling of the observation)

The **auto-note** auto-authors a finding's **editorial note** — the public line that shows on its `/log/<id>` page (the operator's "why this is here"). Today the operator writes it by hand; this is the path that lets Fluncle write it, mirroring the [observation pipeline](./observation-agent.md) as closely as the difference between _read_ and _heard_ allows. It is one more deterministic-with-one-agentic-step sweep the box runs, not a new runtime. The Worker owns the store + the voice gate; the agent holds only its `FLUNCLE_API_TOKEN` and calls one CLI command.

It is the **written** sibling of the spoken observation: where `observe_track` voice-gates a spoken script and renders it to audio, `note_track` voice-gates a written note and stores it into the finding's `note` field. Both read the same fuel — the firecrawl-derived `context_note` — and both are AGENT tier so the on-box cron drives them.

## The note vs the context note (don't conflate them)

|            | `context_note` (the facts)                                                                                                       | the `note` (the editorial line)                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **What**   | A clean, distilled note of FACTS: label, year, release context, artist background, plus one `Texture:` line of sensory pointers. | One short editorial line in Fluncle's voice: the bodily reaction + the turn to the crew, the "why this is here".                       |
| **Source** | The Worker's Firecrawl search → distilled by a small LLM (OpenRouter), written by `context_track`.                               | Written by the **agent** (it holds `copywriting-fluncle`) from the `context_note` fuel + track metadata. Never a paraphrase of lyrics. |
| **Lives**  | `context_note` column (internal), with a `context_status` reliability marker. Never on `/log`, never in JSON-LD/RSS/llms.txt.    | `note` column — **PUBLIC**: it renders on `/log/<id>`, in the finding's structured data, and on the feed.                              |
| **Gate**   | none                                                                                                                             | the **written-note voice gate** (below).                                                                                               |

The `context_note` is the auto-note's **primary fuel**: it carries the release context, scene, and label history the bare metadata can't. The `--refresh` flag on `context` re-runs the fetch+distil even on an already-noted finding, so an old/thin context note can be sharpened before the note is authored from it.

## The commands

```
fluncle admin tracks note <track_id|log_id> --script-file note.txt   # author + store the note (fills an empty note only)
fluncle admin tracks note --queue [--json]                            # the note worklist (context'd, note-less, oldest first)
fluncle admin tracks context <track_id|log_id> --refresh             # re-run the context fetch even if a note exists (backfill/sharpen)
```

- `--script` / `--script-file`: the voice-gated editorial note. **Required** for a write.
- The `note` write is backed by `POST /admin/tracks/{trackId}/note` (`note_track`, **AGENT tier** — `observe` is the precedent for the tier, so the box's agent-scoped token drives it).
- The `--queue` view is `hasContext=true AND hasNote=false` (a finding with the context fuel but no editorial note yet) — the exact pairing `observe` uses, swapping `hasObservation` for `hasNote`.

## The cardinal safety guarantee: fill an EMPTY note only

`note_track` fills a finding's note **only when it is empty**. A finding that already carries a note — operator-written **or** previously auto-authored — is a no-op (`skipped: true`); the agent **never** clobbers an existing note. **The operator override always wins**, and this is enforced **server-side** (the Worker reads the live note and short-circuits before any write) and **covered by a test** (`orpc-admin-tracks.test.ts`: "NEVER overwrites an existing operator note"). The client cron also pre-checks the note to avoid spending an authoring call on an already-noted finding, but the server guard is authoritative.

## The voice gate (a hard ship requirement)

The note is a live, **public**, **written** Fluncle voice surface — it lands straight on `/log`. Its gate is the same defence-in-depth shape as the spoken observation's, sharing one banned-word source of truth (`scanObservationScript` in `observation.ts`):

1. **Author through `copywriting-fluncle`** in the finding-note register (VOICE.md): dry confidence (the music brags, the copy doesn't), lead with the body, the Garnish Rule allows cosmos trim, say "I" never "we"-as-company.
2. **The mechanical scan** (the Worker re-runs it, defence in depth — `gateNoteText` in `note.ts`): **zero** banned identity words (`signal`, `transmission`, …), zero `!` (the Dry Rule), no earthly geography (the cosmos replaces the map), no "we"-as-company. A violation hard-fails the store before the note is shown. The length is bounded to the public `NOTE_MAX_LENGTH` (280) budget — the same cap an operator-typed note is held to — with a short floor so a one-word stub doesn't land.
3. **The operator override** is the final content control: the operator can always hand-write or replace the note, and an operator note is never overwritten.

## The board

The pipeline board's **Note** cell is an `auto` step that stays **actionable** (the operator can still hand-write). It reads `done` when a note exists (auto-authored OR operator-typed); `noteRan` (the `backfill_note_attempted_at` stamp) refines the grey state so a finding the cron visited but couldn't fill reads "Checked — no note" rather than a bare "Note" — exactly the done-when-ran pattern Discogs/Last.fm use, keyed off the same `listBackfillRanForTracks` machinery.

## The box cron (PREPARED, NOT YET WIRED)

`fluncle-note` is the on-box `--no-agent` hybrid sweep — deterministic queue + ONE `claude -p` authoring + deterministic delivery — mirroring `fluncle-observation`. Source: [`hermes/scripts/note-sweep.{sh,ts}`](./hermes/scripts/). The operator wires it on the devbox; the full runbook (the token file-source, the auth-fail ping, `BATCH_CAP=1`, the `hermes cron create` command) is in [`hermes/cron/README.md`](./hermes/cron/README.md) § The HYBRID `--no-agent` auto-note cron.

## Safety rails (inline so they survive even if the skill fails to load)

- One finding per run (one `claude -p` authoring per tick); the queue is the durable worklist.
- Fill an EMPTY note ONLY — never overwrite an operator-written or already-set note (enforced server-side).
- The note carries **facts grounded in the `context_note`** — never quote or closely paraphrase lyrics, never invent a claim.
- The note is **public** the moment it lands on `/log` — the voice gate is a hard ship requirement, not a nicety.
