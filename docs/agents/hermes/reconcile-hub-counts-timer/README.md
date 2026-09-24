# fluncle-reconcile-hub-counts-timer — the nightly hub-counts reconciliation on a host timer

The rave-02 host trigger for the `--no-agent` **hub-counts reconciliation** sweep. `fluncle-reconcile-hub-counts` walks `reconcile_hub_counts` once a night in bounded windows: the WORKER recomputes `renderable_track_count` + `certified_finding_count` (and artists' `rankable_track_count`) for every `labels` / `albums` / `artists` row from truth, page by page, and rewrites **only the rows that disagreed** — then acks the corrected count per table. Zero LLM tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 24h.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/reconcile-hub-counts.sh`](../scripts/reconcile-hub-counts.sh) → [`../scripts/reconcile-hub-counts.ts`](../scripts/reconcile-hub-counts.ts)) — riding the image and auto-updating from `main` via pin-watch.

## Why a reconciliation sweep

The counters are maintained as **deltas** by every edge-writing path ([`apps/web/src/lib/server/hub-counts.ts`](../../../../apps/web/src/lib/server/hub-counts.ts)), because recompute-from-truth measured **27,400 ms at 150k hosted** against ~200 ms for the delta form. That trade buys the speed the catalogue-scale hubs need and takes on one debt: **a maintained counter drifts, silently.** Three ways, none of them fixable from inside the write side:

- a **missed write path** — a new edge-writer that forgets its delta;
- a **non-atomic bulk op** — a half-applied pair IS drift;
- an **out-of-band write** — the operator's catalogue-prune skill deletes tracks straight out of the database, and no server-side track-delete path exists at all.

**Keystone 2's own rollout proved the need on day one (2026-07-26):** the deploy-window skew between the one-time backfill and the first delta-maintained writes left **44 artists, 3 albums and 1 label** reading wrong until a manual reconcile. This tick is that manual reconcile, nightly.

## The model: the box walks windows, the Worker corrects

The box holds no computation authority — it walks the pass and logs the numbers. Per tick:

1. **POST** `/api/v1/admin/hub-counts/reconcile` with the box's AGENT token and `{ pageLimit: 8 }`, then `{ cursor, pageLimit: 8 }` with each response's `next` until `next` is null. Each window runs inside its own admitted database phase (`database-admission-runner.sh phase fluncle-reconcile-hub-counts -- …`), so the admission lease is held only while one window runs.
2. Per window, the **Worker** walks at most eight keyset pages across `labels → albums → artists`:
   - the **page read** — one read statement takes the next 250 entity rows after the cursor (`id > ?`, the primary-key index) and LEFT JOINs each to its own tracks by the entity's index (`tracks_label_id_idx` / `tracks_album_id_idx` / `track_artists_artist_id_idx`), returning the stored counters beside the truth from one snapshot. Its cost is the page's own track mass, never the archive. An entity whose last track was deleted out of band reads zero truth, so no separate zero pass exists;
   - the **guarded write** — only disagreeing rows are written, each as `update <entity> set <truth> where id = ? and <every counter> = <the value the page read>`, beside its due-work marker, in one write batch of point writes (at most 500 statements). No write transaction ever aggregates the track graph.

**Why the guard.** Every edge writer moves the counters in the same transaction as its edge, so a correction that still matches the counters its page read is exactly correct. If a delta landed in between, the guard matches nothing and the delta survives; the page is re-read once and corrected from the fresher snapshot, and a row that loses again is reported as `deferred` for the next night.

**The artists source is pinned** to edges whose track exists (`track_artists` joined to `tracks`, counting `t.track_id`), never raw `track_artists`: production carries **orphaned edges** left by out-of-band track deletion, and the hub reads all join `tracks`. Counting raw edges would "correct" the counters into disagreeing with what actually renders.

**Backpressure.** A yielded window acquisition is retried once (the operation is replay-safe: a window re-read from its cursor rewrites only rows still disagreeing). A second yield stops the run with an exit-zero `gateState: "paused"` summary that keeps the windows already applied, and new windows start only inside a 600-second budget. The next night starts again at the first label.

**It calls the oRPC HTTP endpoint directly** (the `funnel-snapshot.ts` / `anchor-sweep.ts` precedent), never a `fluncle admin …` subcommand — the box's baked CLI is a PINNED release and must not gain a new dependency. **No new secret**: every statement runs Worker-side, so the box is a bare trigger; `FLUNCLE_API_TOKEN` (the box's agent token) is already present.

## The audit log line — the point of the whole thing

A non-zero `corrected` is a **signal**, not noise: it means a write path is leaking. So the tick logs the per-table numbers on **every** run — a row of zeroes is the evidence the counters are healthy — and journald holds the history:

```
[reconcile-hub-counts] AUDIT corrected=48 labels=1 albums=3 artists=44 tookMs=1150 deferred=0
```

plus the machine-readable last stdout line (also the `/status` prober's run output):

```json
{
  "albums": 3,
  "artists": 44,
  "checked": 3,
  "corrected": 48,
  "deferred": 0,
  "elapsedMs": 1204,
  "labels": 1,
  "ok": true,
  "partial": false,
  "produced": 48,
  "tookMs": 1150,
  "windows": 14
}
```

`tookMs` is the Worker's SQL wall clock summed over every window; `elapsedMs` is the tick's own, admission waits included. A stopped pass (`partial: true`, with `reason` and ` partial=<reason>` on the audit line) keeps `produced` as the rows its applied windows corrected but withholds the `corrected` total, and a table it never reached reads `?` in the audit line and `null` in the JSON. A non-zero `deferred` names rows a concurrent counter move kept away from the pass; the next night owns them.

Read the drift history:

```bash
journalctl -u fluncle-reconcile-hub-counts.service | grep AUDIT
journalctl -u fluncle-reconcile-hub-counts.service --since '7 days ago' | grep AUDIT   # the week
```

**What to make of it.** A steady `corrected=0` every night means the delta maintenance is holding. A recurring non-zero on one table points at that table's write paths. A one-off spike right after an out-of-band operation (a prune pass, a bulk script) is the sweep doing exactly its job.

## Why a host timer + the /status marker

Every automation cron runs from a repo-checked-in host timer so the SCHEDULE is code. Because a `docker exec` sends stdout to journald, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-reconcile-hub-counts`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.reconcile-hub-counts` row stays honest. The prober's `AUTOMATION_CRONS` mirror carries the matching entry.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, this doc, and the `/status` registration (`cron.reconcile-hub-counts` in `@fluncle/registry` + the `fluncle-healthcheck` prober). Enabling it on the box is one manual pass, and it needs **no new secret**.

Install + enable the timer on the rave-02 HOST, from a repo checkout, as root:

```bash
sudo install -m 0644 docs/agents/hermes/reconcile-hub-counts-timer/fluncle-reconcile-hub-counts.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/reconcile-hub-counts-timer/fluncle-reconcile-hub-counts.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-reconcile-hub-counts.timer

# Verify one tick now (safe + idempotent — a healthy archive corrects nothing).
sudo systemctl start fluncle-reconcile-hub-counts.service            # one tick now
journalctl -u fluncle-reconcile-hub-counts.service -n 40 --no-pager  # expect an AUDIT line + an { "ok": true, … } summary
systemctl list-timers fluncle-reconcile-hub-counts.timer
```

The first tick on the box may report a non-zero `corrected` — that is the accumulated drift being paid off, not a fault. Expect zeroes from the second night onward.

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

## Rolling out a change to the admission shape

The unit runs `reconcile-hub-counts.sh` directly, and the orchestrator takes a phase per window. Roll a change out in this order:

1. **Deploy the Worker.** An empty body still runs every page in one request, so the image already on the box keeps working.
2. **Let pin-watch rebake the image.** Under the previously installed unit, the runner exports `FLUNCLE_ADMISSION_RUNNER_PID`, and the new script then runs its windows in-process under that inherited whole-lifetime lease rather than nesting phase admission beneath it.
3. **Then refresh the unit** from a repo checkout: `sudo install -m 0644 docs/agents/hermes/reconcile-hub-counts-timer/fluncle-reconcile-hub-counts.service /etc/systemd/system/ && sudo systemctl daemon-reload`.

Installing the unit before the image carries the windowed script would run the old bare trigger with no admission at all.

**It is already on /status.** `cron.reconcile-hub-counts` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `AUTOMATION_CRONS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
