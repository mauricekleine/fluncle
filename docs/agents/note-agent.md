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

## The second fuel: the sonic neighbourhood (the vibe-neighbour layer)

The context note says what a record IS. It says nothing about where it LANDS — and a note is a placement as much as a verdict. So the authoring prompt also carries **the notes of the finding's nearest neighbours in vibe space**: the six findings that sound most like it, each with the note already standing on it.

Those neighbours come from the **MuQ audio embedding** (`get_similar_findings` → `fluncle tracks similar` — an exact cosine scan ranked in SQL, the probe bound as a raw blob), **never from `features_json`**. A note encodes a subjective read of how a finding FEELS; two tracks can measure nearly identical and still sit nowhere near each other by feel, and a feature-twin's note would carry the wrong vibe. The embedding is the space the note's neighbours live in.

They go into the prompt for two reasons, and the second one is the load-bearing half:

1. **Calibration.** They are the register of this corner of the archive, in Fluncle's own hand: how certain, how dry, how bodily he gets about music that feels like this.
2. **Exclusion.** Every image, verb, and closing turn in them is now **spent**. The cluster **informs, it never templates** — a note that reads like every other note in its galaxy is worse than none.

**`NOTE_NEIGHBORS=0`** in the box env turns the layer off (the kill switch, and the control arm of any re-measurement).

## The commands

```
fluncle admin tracks note <track_id|log_id> --script-file note.txt   # author + store the note (fills an empty note only)
fluncle admin tracks note <track_id|log_id> --script-file note.txt --dry-run   # run BOTH gates, report the verdict, store nothing
fluncle admin tracks note --queue [--json]                            # the note worklist (context'd, note-less, oldest first)
fluncle admin tracks context <track_id|log_id> --refresh             # re-run the context fetch even if a note exists (backfill/sharpen)
fluncle tracks similar <track_id|log_id> [--limit 6]                 # the sonic neighbourhood, each neighbour with its note
```

- `--script` / `--script-file`: the voice-gated editorial note. **Required** for a write.
- `--dry-run`: run the voice gate AND the echo gate, report the verdict + the measured echo, write **nothing**. It is the sweep's pre-check and the harness the neighbour layer is measured with; it works on an already-noted finding precisely because it cannot touch it.
- The `note` write is backed by `POST /admin/tracks/{trackId}/note` (`note_track`, **AGENT tier** — `observe` is the precedent for the tier, so the box's agent-scoped token drives it).
- The `--queue` view is `hasContext=true AND hasNote=false` (a finding with the context fuel but no editorial note yet) — the exact pairing `observe` uses, swapping `hasObservation` for `hasNote`.

## The cardinal safety guarantee: fill an EMPTY note only

`note_track` fills a finding's note **only when it is empty**. A finding that already carries a note — operator-written **or** previously auto-authored — is a no-op (`skipped: true`); the agent **never** clobbers an existing note. **The operator override always wins**, and this is enforced **server-side** (the Worker reads the live note and short-circuits before any write) and **covered by a test** (`orpc-admin-tracks.test.ts`: "NEVER overwrites an existing operator note"). The client cron also pre-checks the note to avoid spending an authoring call on an already-noted finding, but the server guard is authoritative.

## The echo gate (the anti-sameness rail — the thing that makes the neighbour layer safe)

Showing an author its neighbours' notes is exactly how you get a region of the archive that all reads the same. So the guardrail is **mechanical, not hoped for**: `gateNoteEcho` (`note.ts`) re-reads the same six neighbour notes the agent was shown and hard-fails a note that echoes them (`note_echoes_neighbours`, 422). Two signals, both pure and deterministic:

- **A lifted phrase** — a run of four or more consecutive words shared with a neighbour, carrying at least one content word ("my shoulders dropped before", "I've been rewinding it since"). This is the failure mode that actually shows up: the voice has a small stock of bodily images, and an author reading its neighbours reuses the phrasing verbatim.
- **Wholesale overlap** — content-word Jaccard ≥ 0.30 with a neighbour. It catches the rewrite that dodges the phrase check by reordering but says the same thing with the same words.

Both thresholds were calibrated against the live archive: its mean max-neighbour overlap is 0.10, nothing in it reaches 0.30, and the gate rejects exactly the two notes that genuinely lift from a neighbour. It bites without paralysing.

**A rejected note is not stored.** The sweep re-authors ONCE (handing the model the phrase it echoed, so it knows which move is spent); a second echo leaves the finding note-less and queued. That is the intended outcome, not a failure — the note is optional, and **silence beats a generic line**.

The echo reading rides back on every note response (`echo: { logId, overlap, phrase }`), so the sameness of the corpus is observable rather than assumed.

## The voice gate (a hard ship requirement)

The note is a live, **public**, **written** Fluncle voice surface — it lands straight on `/log`. Its gate is the same defence-in-depth shape as the spoken observation's, sharing one banned-word source of truth (`scanObservationScript` in `observation.ts`):

1. **Author through `copywriting-fluncle`** in the finding-note register (VOICE.md): dry confidence (the music brags, the copy doesn't), lead with the body, the Garnish Rule allows cosmos trim, say "I" never "we"-as-company.
2. **The mechanical scan** (the Worker re-runs it, defence in depth — `gateNoteText` in `note.ts`): **zero** banned identity words (`signal`, `transmission`, …), zero `!` (the Dry Rule), no earthly geography (the cosmos replaces the map), no "we"-as-company. A violation hard-fails the store before the note is shown. The length is bounded to the public `NOTE_MAX_LENGTH` (280) budget — the same cap an operator-typed note is held to — with a short floor so a one-word stub doesn't land.
3. **The operator override** is the final content control: the operator can always hand-write or replace the note, and an operator note is never overwritten.

## The board

The pipeline board's **Note** cell is an `auto` step that stays **actionable** (the operator can still hand-write). It reads `done` when a note exists (auto-authored OR operator-typed); `noteRan` (the `backfill_note_attempted_at` stamp) refines the grey state so a finding the cron visited but couldn't fill reads "Checked — no note" rather than a bare "Note" — exactly the done-when-ran pattern Discogs/Last.fm use, keyed off the same `listBackfillRanForTracks` machinery.

## The box cron (LIVE)

`fluncle-note` is the on-box `--no-agent` hybrid sweep — deterministic queue + ONE `claude -p` authoring + deterministic delivery — mirroring `fluncle-observation`, and it runs **live on the box every 10 min** (confirmed in the cron roster + the `fluncle-healthcheck` `CRON_SPECS`). Source: [`hermes/scripts/note-sweep.{sh,ts}`](./hermes/scripts/). The full runbook (the token file-source, the auth-fail ping, `BATCH_CAP=1`, the host-timer install (`install-host-timers.sh`)) is in [`hermes/cron/README.md`](./hermes/cron/README.md) § The HYBRID `--no-agent` auto-note cron.

## Re-measuring the layer (when the corpus grows, do this again)

The neighbour layer earns its place only if the prose is BETTER. That is not a claim to take on trust, so it is measurable on demand — the same harness that proved it, re-runnable:

```bash
# the treatment arm: author with the neighbourhood, gate, print, store nothing
bun docs/agents/hermes/scripts/note-sweep.ts --dry-run 011.5.9D 007.0.0Z 012.1.0A

# the control arm: the same findings, the same fuel, no neighbourhood
NOTE_NEIGHBORS=0 bun docs/agents/hermes/scripts/note-sweep.ts --dry-run 011.5.9D 007.0.0Z 012.1.0A
```

Read the two sets side by side, and score them with `scoreNoteEcho` (the same function the gate uses). What matters: the notes in one region must not read like each other. If a future model, prompt, or corpus makes them converge, **turn the layer off** (`NOTE_NEIGHBORS=0`) — it is a net negative the moment it flattens the voice.

## Safety rails (inline so they survive even if the skill fails to load)

- One finding per run (one `claude -p` authoring per tick, plus at most ONE re-author when the echo gate rejects); the queue is the durable worklist.
- Fill an EMPTY note ONLY — never overwrite an operator-written or already-set note (enforced server-side, atomically, by a DB predicate).
- A CATALOGUE track can never be given a note: every finding read drives through the `findings ⋈ tracks` join, so an uncertified track 404s before a word is gated. Fluncle does not speak about a track he has not certified.
- The note carries **facts grounded in the `context_note`** — never quote or closely paraphrase lyrics, never invent a claim, never fabricate scene history.
- The neighbourhood **informs, it never templates**. A note that reads like its neighbours is rejected, and the finding stays note-less.
- The note is **public** the moment it lands on `/log` — the voice gate is a hard ship requirement, not a nicety.
