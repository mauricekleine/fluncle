# Note Agent (the auto-note — the written-note sibling of the observation)

The **auto-note** auto-authors a finding's **editorial note** — the public line that shows on its `/log/<id>` page (the operator's "why this is here"). The auto-note lets Fluncle author the editorial line while preserving the operator's ability to write or replace it, mirroring the [observation pipeline](./observation-agent.md) as closely as the difference between _read_ and _heard_ allows. It is one more deterministic-with-one-agentic-step sweep the box runs, not a new runtime. The Worker owns the store + the voice gate; the agent holds only its `FLUNCLE_API_TOKEN` and calls one CLI command.

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

Those neighbours come from the **MuQ audio embedding** (`list_similar_tracks` → `fluncle tracks similar` — an exact cosine scan ranked in SQL, the probe bound as a raw blob), **never from `features_json`**. A note encodes a subjective read of how a finding FEELS; two tracks can measure nearly identical and still sit nowhere near each other by feel, and a feature-twin's note would carry the wrong vibe. The embedding is the space the note's neighbours live in.

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
fluncle admin notes held [--settled]                                 # the notes the echo gate held back (and why)
fluncle admin notes gate [--min-phrase-words <n>] [--max-overlap <x>] # read or retune the gate's dials
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

**A rejected note is not stored.** The sweep re-authors ONCE, handing the model the phrase it echoed so it knows which move is spent. A second echo leaves the finding note-less and queued for a later pass; silence beats a generic line.

The echo reading rides back on every note response (`echo: { logId, overlap, phrase }`), so the sameness of the corpus is observable rather than assumed.

## Held notes

An echoing note is not published. The gate records it in `note_rejections` so the operator can inspect the candidate, neighbour, lifted phrase, overlap, and thresholds.

The gate **refuses to store** an echoing note — unchanged, same thresholds, same 422 — but the line is **held**, not binned:

- **It is kept.** The rejected note goes to the `note_rejections` ledger with the neighbour it echoed, **a snapshot of that neighbour's note**, the lifted phrase, the measured overlap, and **the thresholds that were in force at that moment** (snapshotted, so retuning the dials can never rewrite the meaning of a past rejection).
- **He is told.** Each held note raises a `note-rejected` row in the `/admin` attention queue, and the digest's dispatch names it ("a note the echo gate held back") on the CLI and the Raycast menu bar.
- **He can overrule it.** The row deep-links to the finding's note dialog (`/admin/findings?note=<trackId>`), where the held note and the neighbour it echoed sit **side by side with the lifted run marked in both** — the pair, not just a verdict, because only the pair lets him tell a good rejection from a badly-tuned one. Three rulings: **Keep it** writes the line verbatim; **Edit it** loads the candidate for revision; **Bin it** settles the rejection without publishing.

A partial unique index allows one open rejection per finding. Re-bounces update that row while retaining the first-hold timestamp for queue ordering.

**The ledger observes the pipeline; it never gates it.** A held rejection does not block a future good draft: the finding stays in the note queue (`hasNote=false`), the sweep keeps trying, and a fresh line that clears the gate simply fills the note. **Fill-empty-only stays absolute** — accepting a held note writes through the same atomic `fillEmptyNote` predicate the agent takes, so an operator note that landed in the meantime is never clobbered (it reports `skipped: true` and the standing note wins). A **catalogue** track can never appear in the ledger: every read drives through the `findings ⋈ tracks` inner join.

A **dry run** holds nothing. It is a measurement harness (the A/B re-measurement below runs it across the archive), and it must not fill the operator's queue with rows he never has to act on.

## The dials are tunable — a flip, not a deploy

The thresholds are runtime settings and should be re-measured as the corpus grows. They live in the `settings` KV (the house's one flag store) and are retunable at runtime, read fresh on every gating run:

```
fluncle admin notes held [--settled] [--json]     # the held notes + the gate's current dials
fluncle admin notes gate                          # read the dials
fluncle admin notes gate --min-phrase-words 5     # retune (operator tier; next sweep tick reads it)
fluncle admin notes gate --max-overlap 0.35
```

Both dials are **bounded on read as well as on write** (`minPhraseWords` 2–20, `maxOverlap` 0.05–1), and a corrupted KV value degrades to the calibrated default. The gate must be able to be _wrong_; it must never be _disabled_ by a typo. Ruling on a held note (keep / bin) and retuning are **operator tier** — an agent token 403s. The current values render in the note dialog beside the score, so he is always judging against the number that actually did the rejecting.

**The evidence is the point.** `--settled` reads the rejections he has already ruled on: a run of "Keep it" rulings is the archive telling him the gate is too tight, and that argument can only be made because the notes were kept.

## The voice gate (a hard ship requirement)

The note is a live, **public**, **written** Fluncle voice surface — it lands straight on `/log`. Its gate is the same defence-in-depth shape as the spoken observation's, sharing one banned-word source of truth (`scanObservationScript` in `observation.ts`):

1. **Author through `copywriting-fluncle`** in the finding-note register (VOICE.md): dry confidence (the music brags, the copy doesn't), lead with the body, the Garnish Rule allows cosmos trim, say "I" never "we"-as-company.
2. **The mechanical scan** (the Worker re-runs it, defence in depth — `gateNoteText` in `note.ts`): **zero** banned identity words (`signal`, `transmission`, …), zero `!` (the Dry Rule), no earthly geography (the cosmos replaces the map), no "we"-as-company. A violation hard-fails the store before the note is shown. The length is bounded to the public `NOTE_MAX_LENGTH` (280) budget — the same cap an operator-typed note is held to — with a short floor so a one-word stub doesn't land.
3. **The name exemption** — the gate polices what Fluncle WROTE, not the names he was given. Before the scan runs, every name the artifact is about is masked out of the text (`maskSubjectNames` in `observation.ts`); everything around it is scanned exactly as before. Without it the gate is UNSATISFIABLE rather than strict: the authoring prompt says naming the artist or the title is fine, and the scan then read those very names, so a finding by an artist called "Future Signal" could not be noted AT ALL, however many times it was rewritten — at the head of a cap-1 oldest-first queue. The masking is the full name, word-bounded, so a partial reference ("Signal" for "Future Signal") still trips the ban and a short name ("Sign") can never amnesty a longer word it sits inside. A name that is EXACTLY one banned token is REFUSED from the exempt set (`UNSAYABLE_NAMES`): masking it would delete every occurrence and stop the gate policing that word for the whole piece — a total amnesty rather than an exemption, and here it would also lift the earthly-geography ban, which the bio's version of this masking never touched (`gateBioText` scans with `allowGeography: true`, so a bio was never policing "london"; this gate is). That stays satisfiable because naming is OPTIONAL on this surface: the prompt says naming the artist or the title is fine "if it helps", so a note about the artist Signal simply does not say "Signal". A bio cannot make the same trade — its whole job is to introduce its subject — which is why `maskEntityName` keeps the accepted cost and `maskSubjectNames` does not.
4. **The operator override** is the final content control: the operator can always hand-write or replace the note, and an operator note is never overwritten.

## The attempt budget (the end of the retry-forever loop)

A gate rejection used to be a plain skip that left the item queued with **nothing counting the tries**, so "retry" meant "forever". The queue is `BATCH_CAP=1` over an oldest-first worklist, so an un-noteable finding did not merely waste its own tokens, it blocked every finding behind it. The sibling of this bug, in the entity-bio crons, re-authored three slugs ~90 times each over two days.

So the sweep now keeps a per-item **attempt ledger** (`docs/agents/hermes/scripts/attempt-ledger.ts`, a flat TSV under `$HOME/.note-sweep/attempts` that survives a tick, a container swap, and a rebake). A finding gets **three refused passes, ever**, and then this sweep never authors for it again.

- **Only a Worker VERDICT spends it, keyed on an exact rejection code.** A `claude -p` that exits non-zero, returns `is_error`, or returns nothing is no evidence about the item at all — there is no draft — so it costs nothing, and the `/status` sweep-strain detector watches it instead. The same rule covers the HTTP leg: the sweep's skip classifier still matches a bare `403`/`422`/`forbidden` (an infra refusal must leave the item queued rather than read as a hard error), but the BUDGET keys only on the codes the Worker emits after reading the draft (`WORKER_REJECTION_CODES` in the sweep). Otherwise an expired agent token — which 4xxs every call — would march down the cap-1 queue writing off one healthy item per few ticks.
- **The echo gate is charged as a deliberate trade, not as proof.** A voice or length rejection is a property of the draft alone. An echo rejection is scored against the item's NEIGHBOURHOOD, so it is a property of the draft _and_ the corpus around it, and it gets harder as the archive fills — three echo refusals are not proof the draft was bad. It is charged anyway, because the alternative is an item that always echoes sitting at the head of a cap-1 queue burning two authorings a tick forever, blocking everything behind it. The cost is visible and reversible: a rejected note is HELD in the `note_rejections` ledger and raised in the `/admin` attention queue, and deleting the item's line from the ledger re-arms it once the neighbourhood has moved on.
- **NO final-attempt bypass** (the operator's ruling, 2026-07-30). The bio sweep stores its third draft even when the gate refused it, because an empty bio slot leaves an entity page half-built. A note is optional editorial and a note-less finding is a perfectly good state the unlit register already handles, so gate-failed copy is **never** published to close a queue. An exhausted item is simply skipped, counted in the tick's `exhausted` summary field, and reported once in the sweep's stderr.
- **An exhausted item never blocks the queue.** Exhausted rows are filtered out **before** the `BATCH_CAP` is applied, so a spent budget only ever costs the item that spent it — otherwise the fix would trade an unbounded retry loop for a permanent stall, which is worse.
- **A landed artifact clears the budget**, so a re-queued item starts fresh; deleting an item's line from the ledger is how the operator re-arms it after the gate or the prompt changes.

## The board

The pipeline board's **Note** cell is an `auto` step that stays **actionable** (the operator can still hand-write). It reads `done` when a note exists (auto-authored OR operator-typed); `noteRan` (the `backfill_note_attempted_at` stamp) refines the grey state so a finding the cron visited but couldn't fill reads "Checked — no note" rather than a bare "Note" — exactly the done-when-ran pattern Discogs/Last.fm use, keyed off the same `listBackfillRanForTracks` machinery.

## The prompt lives in the DATABASE, not in the image

The authoring prompt above is the `note_author` entry in the **prompt registry** ([docs/agents/prompt-registry.md](./prompt-registry.md)). The sweep fetches it over the AGENT-tier `get_prompt` each tick, so the operator can retune it from `/admin/prompts` or the CLI with **no deploy and no box rebake** — which matters most for THIS prompt, because the neighbour block is the front line against every note in a galaxy reading the same, and it is going to get tuned a lot.

The repo provides the baked default, and every note records its drafting source in `note_prompt_version` (`0` = the repo's default, `N` = override N, `NULL` = the baked fallback wrote it, or an operator typed it).

## The box cron (LIVE)

`fluncle-note` is the on-box `--no-agent` hybrid sweep — deterministic queue + ONE `claude -p` authoring + deterministic delivery — mirroring `fluncle-observation`, and it runs **live on the box every 10 min** (confirmed in the cron roster + the `fluncle-healthcheck` `AUTOMATION_CRONS`). Source: [`hermes/scripts/note-sweep.{sh,ts}`](./hermes/scripts/). The full runbook (the token file-source, the auth-fail ping, `BATCH_CAP=1`, the host-timer install (`install-host-timers.sh`)) is in [`hermes/cron/README.md`](./hermes/cron/README.md) § The HYBRID `--no-agent` auto-note cron.

## Re-measuring the layer (when the corpus grows, do this again)

Re-measure the neighbour layer as the corpus grows with the dry-run treatment/control harness below:

```bash
# the treatment arm: author with the neighbourhood, gate, print, store nothing
bun docs/agents/hermes/scripts/note-sweep.ts --dry-run 011.5.9D 007.0.0Z 012.1.0A

# the control arm: the same findings, the same fuel, no neighbourhood
NOTE_NEIGHBORS=0 bun docs/agents/hermes/scripts/note-sweep.ts --dry-run 011.5.9D 007.0.0Z 012.1.0A
```

Read the two sets side by side, and score them with `scoreNoteEcho` (the same function the gate uses). What matters: the notes in one region must not read like each other. If a future model, prompt, or corpus makes them converge, **turn the layer off** (`NOTE_NEIGHBORS=0`) — it is a net negative the moment it flattens the voice.

## Run bound

Process one finding per run: one `claude -p` authoring call per tick, plus at most one re-author when the echo gate rejects. The queue is the durable worklist.
