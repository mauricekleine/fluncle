# fluncle-isrc-recovery — the free ISRC-recovery sweep on a host timer

This host timer runs a tokenless Deezer pass over un-anchored catalogue tracks that have no stored ISRC. Recovering an ISRC moves a row into the billed anchor queue's high-precision exact-ISRC head, where the existing anchor sweep can resolve its Spotify track without asking the fuzzy tail to compete for the same batch.

The sweep work is baked at `/opt/hermes-scripts/`: [`../scripts/isrc-recovery-sweep.sh`](../scripts/isrc-recovery-sweep.sh) invokes [`../scripts/isrc-recovery-sweep.ts`](../scripts/isrc-recovery-sweep.ts), and the wrapper records the final JSON summary as the cron's `/status` marker.

## The zero-Apify boundary

The box fetches candidates; the Worker keeps verification authority:

1. Fetch up to `FLUNCLE_ISRC_RECOVERY_BATCH` rows from `GET /api/v1/admin/tracks/work?kind=isrc-recovery`, each with its server-built `deezerQuery`.
2. Search Deezer once per row, sequentially and paced at roughly 1.1 seconds between requests.
3. POST at most five candidates to the existing `resolve_anchor` operation with `spotifySearch: false`. The Worker applies the shared identity and duration gate and writes a recovered ISRC only when the candidate clears it.

This sweep never calls `anchor_track` and never invokes Apify. Deezer search is tokenless, so the only credential is the existing agent-scoped `FLUNCLE_API_TOKEN`; no new secret or operator token is required.

## Where the write lease is held

Step 2 above is minutes of paced third-party waiting, so it runs under **no database lease at all**. The sweep uses phased admission ([docs/database-performance.md](../../database-performance.md)): the unit invokes the wrapper directly rather than through `database-admission-runner.sh`, and the orchestrator opens its own bounded phases — one **claim window** for the worklist read (step 1), then **settle windows** for the resolver verdicts (step 3), each bounded to ten rows and twenty seconds. Every Deezer search falls between those phase processes.

Nothing is claimed or fenced, which is what makes that safe: a row leaves the worklist only when `resolve_anchor` stamps its recovery ledger. A yielded window, a window that defers its tail, and a tick stopped by its wall budget therefore all leave the affected rows eligible on the very next tick, with nothing to reconcile. A yielded tick reports `gateState: "paused"`, `reason: "database_admission"`, and `throttled: true` at exit 0 — designed backpressure, never a failure — and `unsettled` counts the rows it handed forward.

Deezer can report quota exhaustion as an HTTP 200 error body. The client classifies that outcome separately from an empty result, retries it, and aborts the remaining work after a short consecutive quota streak. The final summary keeps quota-blocked rows distinct from genuine Deezer-empty rows and transport failures, so a quota-blind tick cannot look like a clean miss.

## The blind-sweep tripwire

An empty Deezer result is the one negative this pass writes down, and it is also what a broken ASK looks like: a query spelling the vendor stops honouring answers `{"data":[],"total":0}` for every row, which is well-formed JSON carrying a real empty array and no error code. So the RATE is the alarm. Over a floor of searched rows, an empty share at or above the sweep's `DEEZER_BLIND_EMPTY_SHARE` fails the tick with `ok: false` and `reason: "deezer_blind"` — the ledger reads it and the unit's failure alert fires. Counts stay honest either way; the verdict is added, never substituted. Quota and transport rows are excluded from the denominator, because they never reached Deezer's index.

A blind window still wrote durable clean misses to `isrc_recovery_attempted_at`. Once the ask is fixed, the operator hands those rows back with the operator-tier `requeue_isrc_recovery` op, which is dry-run by default:

```bash
fluncle admin catalogue requeue-isrc-recovery --since <YYYY-MM-DD>          # count only
fluncle admin catalogue requeue-isrc-recovery --since <YYYY-MM-DD> --apply  # clear the stamps
```

It clears only rows whose stamp came from the Deezer-EMPTY arm (the gate-refused arm is a verdict about the row and stands), that are still ISRC-less, and that are still un-anchored. It never touches the anchor re-ask stamp.

## Pace and controls

The checked-in service sets `FLUNCLE_ISRC_RECOVERY_BATCH=100`, which is also the code default. Override that environment variable for a deliberately smaller bounded tick. The timer spaces requests by roughly 1.1 seconds, applies `RandomizedDelaySec=90`, and persists missed firings. An empty or backoff-covered worklist is a no-op. The tick also stops itself at `ISRC_RECOVERY_WALL_BUDGET_MS` rather than being killed by `TimeoutStartSec`, so a tick that spends its time queueing for a congested write lane still writes a summary and reports `reason: "wall_budget"`.

## Install and verify

The repository carries the scripts, units, `/status` registration, and healthcheck mapping. A host-timer installer discovers every unit-bearing `*-timer/` directory, so a full provision includes this timer automatically. To add it to an already-running host from a repository checkout:

```bash
sudo install -m 0644 docs/agents/hermes/isrc-recovery-timer/fluncle-isrc-recovery.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/isrc-recovery-timer/fluncle-isrc-recovery.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-isrc-recovery.timer
```

Verify one bounded tick and its schedule:

```bash
sudo systemctl start fluncle-isrc-recovery.service
journalctl -u fluncle-isrc-recovery.service -n 40 --no-pager
systemctl list-timers fluncle-isrc-recovery.timer
```

The journal's final stdout line is one JSON summary. `/status` reads the same run through `cron.isrc-recovery`; no extra probe wiring is needed.
