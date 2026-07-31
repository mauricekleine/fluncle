---
name: fluncle-ledger
description: >-
  Read Fluncle's run ledger with `fluncle admin telemetry read` and report what is actually wrong with the automation fleet — the sweeps that lied about their own health, failed, went silent, or produced nothing against a real backlog. Use whenever asked "what is the fleet doing", "did the sweeps run", "check the automation health", "read the ledger", "anything broken overnight", "is anything stuck", or "why did nothing get enriched / crawled / embedded", and whenever a cron, a box timer, or a sweep's numbers are in question. Use it before trusting any prior audit's claim about a sweep: the ledger is the current truth and yesterday's report is not. This is judgment applied by hand, deliberately not a cron, so the reader learns which shapes are noise before any of it gets automated. NOT for service liveness (that is `fluncle status` and /status) and NOT for changing a sweep (that is the fluncle-hermes-operator skill).
---

# Reading the run ledger

Every sweep tick on the box POSTs one envelope — unit, start, end, exit code, and its summary line verbatim — to the `run_events` ledger. The Worker derives the verdict, normalizes the counters it recognises, and records the ones the summary did not carry. The ledger exists because eight of thirteen defects in a fleet audit were numbers that were emitted, printed, and read by nobody. This skill is the reading.

One op, one command:

```bash
fluncle admin telemetry read --unit fluncle-enrich --since 24h --json
```

Flags: `--unit`, `--since <iso|age>`, `--until <iso>`, `--ok true|false`, `--liar`, `--blind`, `--missing-field <name>`, `--missing`, `--limit` (1–100), `--cursor`, `--json`. Relative `--since` ages use a positive integer plus lowercase `m`, `h`, `d`, or `w`, such as `90m`, `24h`, or `2w`, up to `3650d`. Absolute bounds require an ISO-8601 instant with `T` and an explicit `Z` or offset. Operator tier. Never reach around it with raw SQL — the CLI needs no database credential and cannot drift from the schema.

In JSON, top-level `.ok` acknowledges the request. It says nothing about run health. The derived run verdict is `.rows[].ok`.

## The two rules you read under

**1. The ledger is the current truth. A prior report is not.** An audit from yesterday said the ListenBrainz anchor rung yielded zero; the live ledger showed it anchoring 10–33 per tick. If a claim about a sweep arrives from a doc, a backlog file, or an earlier session, re-measure it here before repeating it. A stale premise is the characteristic failure of a reader working from a previous harvest.

**2. Absence is the loudest signal and it is invisible in stored rows.** A unit that stopped reporting has no evidence row to find. Every silence question uses `--missing`, which diffs the selected window against the authoritative writer roster and returns the absent writers with cadence. Skipping that view is how a dead sweep reads as a clean ledger.

## The triage routine

### 0. Fix the window, then prove the filter works

```bash
fluncle admin telemetry read --since 24h --limit 1 --json | jq '.totalCount'
fluncle admin telemetry read --limit 1 --json | jq '.totalCount'
```

The narrow window should return fewer rows than the all-time read. If the counts match, prove that the fleet really has no older rows before drawing conclusions. The Worker resolves the relative age once for the request and normalizes it to the same ISO shape as the stored timestamps.

### 1. Take the whole-fleet frame from the rollups

```bash
fluncle admin telemetry read --since 24h --limit 1
```

`--limit 1` is deliberate: the rollups are computed over the entire unit/time window regardless of paging or evidence filters, so one row's worth of page gives you the whole fleet's `CADENCE / RUNS / LAST / OK=0 / LIAR / BLIND` table for the price of one call. `RUNS` always means all runs in that unit/time window. Read the shape of the fleet here and only then open individual units.

### 2. The liars — a claim that contradicts the verdict

`ok` is derived server-side (`exit_code === 0 && (errors ?? 0) === 0`) and a sweep's own `ok` never sets it; the claim is filed beside it as `selfAssertedOk`. `errors` means the run itself failed; `failed` means individual work items failed and the run continued. The founding case: the nightly Sentry sweep printed `{"errors":2,"ok":true}` for eleven nights while fetching nothing, because a rejected query parameter left `ok` a hardcoded literal.

Any rollup with `LIAR` above zero, then pull the evidence:

```bash
fluncle admin telemetry read --since 24h --unit fluncle-<name> --liar --limit 100 --json
```

`--liar` returns those evidence rows directly; use `--cursor` if there are more than 100. A liar written under the current vocabulary is always a finding. It means a sweep is telling the fleet it is fine while its own run-level numbers say otherwise, and every consumer downstream of that claim is calibrated on a lie.

### 3. The failures

```bash
fluncle admin telemetry read --since 24h --ok false --limit 100 --json
```

`--ok false` filters evidence rows only. The rollups still describe all runs in the unit/time window, so `rollups[].runCount` is the denominator and `rollups[].failedCount` is the numerator in the same response. One failure in 300 ticks and 300 in 300 are different findings.

### 4. The silence — judged against cadence, never against recency

```bash
fluncle admin telemetry read --since 24h --missing
```

`--missing` returns every expected writer with no run in the selected window, including its authoritative cadence. The roster already accounts for the non-ledger healthcheck and direct host writers. Do not rebuild or amend it by hand.

Then judge. `--missing` is an absence diff, not a defect verdict. A unit is late only when the gap exceeds roughly **3× its cadence**, the same staleness budget /status already uses. Confirm a candidate over a cadence-sized window:

```bash
fluncle admin telemetry read --unit fluncle-<name> --since 72h --missing
```

Choose a lookback at least 3× that unit's cadence. A unit absent from a shorter window may still be healthy.

The false positive this rule exists to prevent, measured: `fluncle-label-releases` showed 1 run, 7 hours old, while the rest of the fleet was minutes old. Its registry cadence is `86400000` ms. It was perfectly healthy. A silence rule without cadence produces exactly that, and a reader that cries wolf gets ignored.

### 5. The blind — a worklist, not an error

```bash
fluncle admin telemetry read --since 24h --blind --limit 100 --json
fluncle admin telemetry read --since 24h --missing-field checked --limit 100 --json
```

`--blind` returns rows where `checked`, `produced`, and `queueDepth` are all null. `--missing-field` returns rows missing one canonical counter; accepted names are `checked`, `produced`, `queue_depth`, `errors`, and `expected_interval_ms`. Use it once per counter you are measuring.

`missingFields` lists the mandatory counters a summary did not carry, and that list IS the upgrade queue. Historical context, not a live claim: at the ledger's start the productivity axis was empty across its first 1,655 rows — `checked`, `produced`, `errors` and `expected_interval_ms` were zero non-null — and sweeps are being upgraded to emit them one at a time. Measure the current state here rather than repeating that. Report it as ONE line naming how many units still owe which counters. It is never N findings, and a unit appearing here is not broken.

### 6. `produced == 0 AND queue_depth > 0` — the designed alarm

Neither half means anything alone. A sweep with a genuinely empty worklist legitimately produces nothing forever.

```bash
fluncle admin telemetry read --since 24h --limit 100 --json \
  | jq -r '.rows[]
           | select(.gateState == null or .gateState == "active")
           | select(.produced == 0 and (.queueDepth // 0) > 0)
           | "\(.unit)\t\(.occurredAt)\tproduced=0 queue=\(.queueDepth)"'
```

The `gateState` filter is load-bearing. A `paused`/`disabled`/`locked` tick already has its work counters nulled server-side, but `forced` and `dry-run` ticks LOOKED and kept their real numbers — excluding them here is the reader's job, and the server deliberately leaves it that way rather than laundering a measured number at write time.

**Then check the gauge can move, before you report it.**

```bash
fluncle admin telemetry read --unit fluncle-<name> --since 24h --limit 100 --json \
  | jq -r '[.rows[].queueDepth] | unique'
```

A single value across many runs is a constant, not a backlog. This has happened repeatedly: `queueDepth: 24` was measured to be a page cap (`QUEUE_LIMIT`), and three more gauges that could not move were fixed or deleted in one pass — one was rewired to the authoritative backlog count, two were removed outright rather than given invented sources. A reading that cannot be trusted is worse than no reading, because a human calibrates on it. If the value never changes, the finding is "this gauge is a constant", not whatever the gauge appears to say.

## Calibration — what is NOT a finding

Do not report any of these. Each one is a shape a naive reader escalates.

Rows earlier than this vocabulary change's deployment use the old meaning, so capture's historical liars are an artefact rather than evidence that those runs lied.

| Shape                                                        | Why it is normal                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exitCode: 0`, `failed > 0`, `ok: true`                      | An ordinary partial batch: individual work items failed, but the run continued successfully.                                                      |
| A historical `fluncle-capture` liar                          | Old-vocabulary artefact: item-level `failed` was folded into run-level `errors` before this change deployed.                                      |
| A 24h cron quiet for 7h                                      | Cadence, not recency. Quote `expectedIntervalMs` before calling anything late.                                                                    |
| `checked: 0, produced: 0, queueDepth: 0`                     | Empty worklist. `artist-credits` reads exactly this today and is healthy.                                                                         |
| A non-empty `missingFields`                                  | The upgrade queue. Most of the fleet is here while sweeps are upgraded one at a time.                                                             |
| `selfAssertedOk: true` beside `ok: true`                     | Twenty-five sweeps print `ok` in their summary. It is a finding only when it CONTRADICTS the derived verdict.                                     |
| One missing row                                              | Delivery is best-effort by design: the emitter swallows every POST failure silently. Escalate a sustained gap over several cadences, never one.   |
| Many units missing the same one tick                         | A container rebuild holds a lock and every sweep skips that tick cleanly, posting nothing. A fleet-wide one-tick hole is a deploy, not an outage. |
| `occurredAt` earlier than `createdAt`                        | Box clock versus Worker write time. Both are kept on purpose.                                                                                     |
| `summaryStatus: "absent"` on a crashed tick                  | A sweep that died before printing is exactly what the ledger is for. The finding is the exit code, not the missing summary.                       |
| `available: false` / "Telemetry database is not configured." | You are pointed at a deployment with no telemetry database. Not a silent fleet — say so and stop.                                                 |

## Traps

- **The `T` separator.** `occurred_at` and `created_at` are ISO with a `T`; SQLite's `datetime('now', …)` emits a space, so a raw `>` comparison puts `'T'` against `' '` and **every row passes** — a window filter that silently matches everything, returning an all-time count from a fifteen-minute window. The reader normalizes `--since`/`--until` before comparing, so the CLI path is safe; this is the reason not to go around it. Step 0's narrow-versus-wide check is what catches it if you ever do.
- **Absolute bounds need a zone.** `--since` accepts a relative age or a full ISO-8601 instant with `T` and explicit `Z` or offset; `--until` accepts only the full instant. Zone-free strings and bare dates are rejected.
- **Top-level `.ok` is never run health.** In `--json`, `.ok` is the request acknowledgement and remains `true` for a successful read. Only `.rows[].ok` is the Worker's derived verdict for a run.
- **Evidence filters do not filter rollups.** `--ok`, `--liar`, `--blind`, and `--missing-field` narrow `.rows` and `totalCount`; rollups still cover every run selected by `--unit`, `--since`, and `--until`. `RUNS` therefore always means all unit/time-window runs.
- **`--missing` is a separate roster view.** It accepts the unit/time window, not stored-row evidence filters or a cursor.
- **Rollups are whole-window; `rows` is one page.** `totalCount` counts evidence rows across all pages after evidence filters; it is not the page length and, when evidence is filtered, not the sum of rollup `runCount`.
- **Cadence lives on the rollup.** Use `rollups[].expectedIntervalMs` beside `lastOccurredAt`; a null cadence means the unit is outside the expected-writer roster.
- **`--limit` caps at 100.** A 24h window across the fleet is thousands of rows. Work from rollups and open rows only for the unit under investigation.

## Reporting

A finding without the command that produced it is not a finding. Use this shape:

```
fluncle-<unit> — <the shape, one line>
  window:    --since 24h
  command:   fluncle admin telemetry read --unit fluncle-<unit> --ok false --limit 100 --json
  evidence:  <rows or counts, verbatim from the output>
  ruled out: <the calibration row you checked, e.g. "cadence 86400000ms, gap 7h — not late">
```

Rules for the write-up:

- Name the calibration item you ruled out. "Silent for 7 hours" becomes a finding only once the cadence is quoted beside it.
- Report the blind set as one worklist line: how many units still owe which counters. Never as separate findings.
- Every number comes from output you read this session. Never carry a figure from an audit doc or a previous run.
- The server returns facts, not a defect verdict. Apply the calibration table before naming any row or roster absence as a finding.
- Nothing wrong is a result. Say so with the window and the row count you actually read, so the next reader knows what was covered.

## Why this is a skill and not a cron

Standing ruling: the command selects evidence and computes factual rollups and roster absences; it does not decide what is broken. Use the reader by hand until it is clear what is noise, and only then consider automating a verdict. Every calibration row above was earned by a real false positive or a real defect. Automating before that table is stable would ship a detector that cries wolf, and a detector nobody trusts is worse than none.

## Field reference

**Top level:** `ok` is the request acknowledgement, never run health; `available` says whether the telemetry database is configured; `rows` is the evidence page; `totalCount` is the number of evidence rows across pages; `nextCursor` resumes that evidence page; `rollups` covers all runs in a standard read's selected unit/time window; `missingRoster` carries expected-writer absences. A `--missing` read returns empty `rows` and `rollups`, `totalCount: 0`, and the absence set in `missingRoster`.

**Rollup (per unit, whole unit/time window):** `unit`, `expectedIntervalMs`, `runCount`, `lastOccurredAt`, `failedCount` (derived run `ok = false`), `liarCount` (claimed ok while derived ok is false), `blindCount` (`checked`, `produced` and `queueDepth` all null). Evidence filters do not change these values.

**Missing-roster entry:** `unit`, `expectedIntervalMs`.

**Row (20 columns, lossless under `--json`):** `unit`, `id`, `occurredAt` (box start time), `endedAt`, `createdAt` (Worker write time), `runDurationMs`, `exitCode`, `ok` (the derived run verdict), `selfAssertedOk` (claimed, never obeyed), `checked`, `produced`, `queueDepth`, `errors`, `vendorCalls`, `expectedIntervalMs`, `gateState`, `missingFields`, `unrecognisedFields`, `summaryStatus`, `summaryRaw`.

**Counter vocabulary:** `errors` says the run itself failed; domain counters such as `failed` remain readable in `summaryRaw` and say individual work items failed while the run continued. The run verdict remains `exitCode === 0 && (errors ?? 0) === 0`. Historical rows written before the vocabulary change keep their earlier interpretation; do not read them as current-vocabulary evidence.

**`summaryStatus`** — `parsed` (a JSON object the Worker read), `absent` (the tick printed nothing: a crash before output), `malformed` (present but not JSON), `not_object` (JSON, but an array or a scalar).

**`gateState`** — `active` and `null` mean the tick looked. `paused`, `disabled` and `locked` mean it never looked, and the Worker has already nulled its work counters. `forced` and `dry-run` LOOKED, so their counters are real readings and it is the reader's job to exclude them from the `produced == 0` conjunction.

**Null is not zero.** `0` is a measured answer; `null` says the emitter cannot know; absence means it never reported the counter at all, and only absence lands on `missingFields`.

## Where the shapes are defined

- Contract and field docs — `packages/contracts/src/orpc/admin-telemetry.ts`
- Normalization rules 1–5 (derived `ok`, counter validation, the upgrade queue, the page-cap ban, gated nulls) — `apps/web/src/lib/server/run-events.ts`
- CLI rendering and flags — `apps/cli/src/commands/admin-telemetry.ts`
- The emitter, mirrored byte-identically across four scripts — `docs/agents/hermes/scripts/cron-output.sh`
- The expected-writer roster — `packages/registry/src/index.ts` (`runLedgerWriters()`), with ordinary cron membership guarded against timer units by `docs/agents/hermes/scripts/cron-roster.ts`

## Not this skill

- Service liveness (is the Worker, R2, DNS, SSH up?) — `fluncle status` and /status.
- Changing a sweep, its schedule, or its secrets — the `fluncle-hermes-operator` skill.
- The nightly codebase audit and its findings ledger — the `fluncle-audit-operator` skill.
