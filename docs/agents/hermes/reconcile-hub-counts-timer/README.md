# fluncle-reconcile-hub-counts-timer — the nightly hub-counts reconciliation on a host timer

The rave-02 host trigger for the `--no-agent` **hub-counts reconciliation** sweep. `fluncle-reconcile-hub-counts` fires one `reconcile_hub_counts` a night: the WORKER recomputes `renderable_track_count` + `certified_finding_count` for every `labels` / `albums` / `artists` row from truth, in SQL, and rewrites **only the rows that disagreed** — then acks the corrected count per table. Zero LLM tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 24h.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/reconcile-hub-counts.sh`](../scripts/reconcile-hub-counts.sh) → [`../scripts/reconcile-hub-counts.ts`](../scripts/reconcile-hub-counts.ts)) — riding the image and auto-updating from `main` via pin-watch.

## Why a reconciliation sweep

The counters are maintained as **deltas** by every edge-writing path ([`apps/web/src/lib/server/hub-counts.ts`](../../../apps/web/src/lib/server/hub-counts.ts)), because recompute-from-truth measured **27,400 ms at 150k hosted** against ~200 ms for the delta form. That trade buys the speed the catalogue-scale hubs need and takes on one debt: **a maintained counter drifts, silently.** Three ways, none of them fixable from inside the write side:

- a **missed write path** — a new edge-writer that forgets its delta;
- a **non-atomic bulk op** — a half-applied pair IS drift;
- an **out-of-band write** — the operator's catalogue-prune skill deletes tracks straight out of the database, and no server-side track-delete path exists at all.

**Keystone 2's own rollout proved the need on day one (2026-07-26):** the deploy-window skew between the one-time backfill and the first delta-maintained writes left **44 artists, 3 albums and 1 label** reading wrong until a manual reconcile. This tick is that manual reconcile, nightly.

## The model: box triggers, the Worker corrects

The box holds no computation authority — it only fires the trigger. Per tick:

1. **POST** `/api/v1/admin/hub-counts/reconcile` with the box's AGENT token — a bare trigger (no body).
2. The **Worker** runs two statements per entity table:
   - the **grouped correction** — `UPDATE <entity> … FROM (SELECT <fk>, count(*), sum(is_catalogue = 0) … GROUP BY <fk>) src WHERE <entity>.id = src.<fk> AND (the stored counts DIFFER)`. The counts-differ guard is what makes `rowsAffected` mean **rows corrected** rather than rows re-written, so the number reported is the drift exactly;
   - the **zero-truth pass** — an entity whose last track was deleted out of band keeps a stale non-zero count and appears in NO group, so the first statement can never reach it. A small `UPDATE … SET both = 0 WHERE (counts <> 0) AND id NOT IN (<the same source's keys>)` closes it, folding into the same per-table `corrected`.

**The artists source is pinned** to `track_artists ta JOIN tracks t ON t.track_id = ta.track_id`, never raw `track_artists`: production carries **orphaned edges** (62 of them, measured 2026-07-26, left by out-of-band track deletion) and the hub reads all join `tracks`. Counting raw edges would "correct" the counters into disagreeing with what actually renders. Labels and albums group over `tracks` directly, with `WHERE label_id / album_id IS NOT NULL` — also load-bearing, since a NULL inside the zero-truth `NOT IN` subselect makes the whole predicate NULL and would silently match nothing.

**It calls the oRPC HTTP endpoint directly** (the `funnel-snapshot.ts` / `anchor-sweep.ts` precedent), never a `fluncle admin …` subcommand — the box's baked CLI is a PINNED release and must not gain a new dependency. **No new secret**: every statement runs Worker-side, so the box is a bare trigger; `FLUNCLE_API_TOKEN` (the box's agent token) is already present.

## The audit log line — the point of the whole thing

A non-zero `corrected` is a **signal**, not noise: it means a write path is leaking. So the tick logs the per-table numbers on **every** run — a row of zeroes is the evidence the counters are healthy — and journald holds the history:

```
[reconcile-hub-counts] AUDIT corrected=48 labels=1 albums=3 artists=44 tookMs=1150
```

plus the machine-readable last stdout line (also the `/status` prober's run output):

```json
{
  "albums": 3,
  "artists": 44,
  "corrected": 48,
  "elapsedMs": 1204,
  "labels": 1,
  "ok": true,
  "tookMs": 1150
}
```

`tookMs` is the Worker's SQL wall clock; `elapsedMs` is the tick's own. A field the op did not send reads `?` in the audit line and `null` in the JSON, and the total is withheld rather than summed from a partial read.

Read the drift history:

```bash
journalctl -u fluncle-reconcile-hub-counts.service | grep AUDIT
journalctl -u fluncle-reconcile-hub-counts.service --since '7 days ago' | grep AUDIT   # the week
```

**What to make of it.** A steady `corrected=0` every night means the delta maintenance is holding. A recurring non-zero on one table points at that table's write paths. A one-off spike right after an out-of-band operation (a prune pass, a bulk script) is the sweep doing exactly its job.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-reconcile-hub-counts`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.reconcile-hub-counts` row stays honest. The prober's `AUTOMATION_CRONS` mirror carries the matching entry.

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

**It is already on /status.** `cron.reconcile-hub-counts` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `AUTOMATION_CRONS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
