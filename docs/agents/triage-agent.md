# Triage Agent (the submission pre-chew — the queue-legwork sibling of the auto-note)

The **submission-triage sweep** pre-chews a pending crew submission before the operator gets to it, so a submitted banger arrives in the `/admin` attention queue already assessed. Today a submission lands in the review tray with only its raw metadata; this is the path that lets Fluncle write a first read on it — a one-line **triage verdict** ("looks like a find / already logged / not our lane"). It is one more deterministic-with-one-agentic-step box sweep, mirroring the [auto-note](./note-agent.md), not a new runtime. The Worker owns the store + the length gate; the agent holds only its `FLUNCLE_API_TOKEN` and calls one CLI command.

It is the **queue-legwork** sibling of the auto-note: where `note_track` voice-gates a public editorial note and stores it onto a finding, `triage_submission` length-gates an operator-internal advisory verdict and stores it onto a pending submission. Both are AGENT tier so the on-box cron drives them. The crucial line: **the verdict is advisory only — approve/reject stays operator tier and untouched. The sweep does legwork; publishing authority never moves.**

## The verdict vs the decision (don't conflate them)

|           | the triage `verdict` (the pre-chew read)                                                             | the approve/reject **decision**                                                     |
| --------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **What**  | One short internal line: "looks like a find / already logged / not our lane".                        | The operator's act: publish the banger (approve) or discard the candidate (reject). |
| **Who**   | The **agent** (`fluncle-triage` box sweep), from a deterministic dedupe + plausibility read.         | The **operator**, in the review tray (a publish + a Telegram post, or a discard).   |
| **Tier**  | AGENT (`triage_submission`, `adminAuth` only) — the box's agent token drives it.                     | OPERATOR (`approve_submission` / `reject_submission`, `operatorGuard`).             |
| **Lives** | `triage_verdict` column — operator-internal, never public. Shows on the queue row + the review tray. | The submission `status` (`approved` / `rejected`) + the archive publish.            |

## The commands

```
fluncle admin submissions                                            # the pending review queue (now carries triageVerdict)
fluncle admin submissions triage <submissionId> --verdict-file v.txt  # write the advisory verdict (pending only)
fluncle admin submissions triage <submissionId> --verdict "<text>"    # inline form
```

- The write is backed by `POST /admin/submissions/{submissionId}/triage` (`triage_submission`, **AGENT tier** — `note_track` is the precedent for the tier).
- It writes onto a **pending** submission only; a reviewed one is a 409 (a late tick can never re-annotate a decided candidate).
- The queue worklist is just the pending list filtered to rows with no verdict yet (no dedicated endpoint).

## The decision logic (per pending, un-triaged submission)

1. **Dedupe** — a submission's `spotifyTrackId` IS the archive's `track_id`, so `fluncle admin tracks get <spotifyTrackId>` resolving a finding means the banger is **already logged**; a miss means new.
2. **Assess** — `assessSubmission(...)` (pure, unit-tested) scores a cheap DnB plausibility from the title/album keywords + the dedupe result: `likely` / `unlikely` / `unclear`.
3. **Author** — ONE `claude -p` call (subscription auth, read-only tools, the `copywriting-fluncle` skill) phrases the deterministic lean as one voiced line.
4. **Deliver** — the CLI posts it; the Worker length-gates + stores it onto the pending submission.

## The gate (advisory, so lighter than the note's)

The verdict is operator-**internal** — it never reaches a public surface — so unlike the auto-note it carries no voice gate (no banned-word / earthly-geography scan). Its gate is a plain length bound (`gateTriageVerdict` in `submissions.ts`): non-empty, floored above a bare word, capped at a one-line budget. The claude authoring still writes it in Fluncle's voice via the skill; the server just makes sure a delivered line is a sane one-liner.

## The queue surface

A pending submission is one row in the `/admin` attention queue (source `submission`, the tray glyph), oldest-first, deep-linking to the exact candidate in the review tray (`/admin/findings?submission=<id>`). When the sweep has visited, the row renders the verdict one-liner beneath its meta; the primary action is **Review** (never an inline approve/reject — the decision lives in the tray). See [admin-shell.md](../admin-shell.md).

## The box cron (repo half shipped; box enable OPERATOR-GATED)

`fluncle-triage` is the on-box `--no-agent` hybrid sweep — deterministic queue + dedupe + ONE `claude -p` verdict + deterministic delivery — mirroring `fluncle-note`. Source: [`hermes/scripts/triage-sweep.{sh,ts}`](./hermes/scripts/). The timer units + the activation runbook (it reuses the shared secret file + agent token — no new secret) live in [`hermes/triage-timer/`](./hermes/triage-timer/README.md).

## Safety rails (inline so they survive even if the skill fails to load)

- The verdict is **advisory only** — the sweep NEVER approves or rejects; the operator decides.
- Write onto a **pending** submission only (a reviewed one is a 409, enforced server-side).
- The verdict is grounded in the deterministic dedupe + plausibility read — never invent a fact about the track.
- One submission per `claude -p` call (BATCH_CAP=3 per tick); the pending queue is the durable worklist.

## The prompt lives in the DATABASE, not in the image

The authoring prompt is the `triage_verdict` entry in the **prompt registry** ([docs/agents/prompt-registry.md](./prompt-registry.md)). The sweep fetches it over the AGENT-tier `get_prompt` each tick, so the operator retunes it from `/admin/prompts` or the `fluncle admin prompts` CLI with **no deploy and no box rebake**.

The repo still keeps the baked default (`buildTriagePrompt` in `triage-sweep.ts`), and a failed fetch falls back to it and logs — a prompt store that blinks can never stop the sweep. Every verdict records the version that drafted it in `submissions.triage_prompt_version` (`0` = the repo's default, `N` = override N, `NULL` = the baked fallback wrote it).
