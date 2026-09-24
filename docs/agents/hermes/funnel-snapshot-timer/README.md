# fluncle-funnel-snapshot-timer — the daily catalogue-funnel snapshot on a host timer

The rave-02 host trigger for the `--no-agent` **catalogue-funnel snapshot** sweep. `fluncle-funnel-snapshot` fires one `record_catalogue_snapshot` a day: the WORKER computes every stage total (crawled → anchored → captured → analyzed → embedded → rec-eligible → certified) + queue depth (anchor with/without ISRC, anchor re-ask bench, capture, analyze, embed) + crawl-frontier count, all through the SAME predicates the sweeps run (`apps/web/src/lib/server/funnel.ts`, so the funnel can never drift from the real gates), and upserts one idempotent row per UTC day into `catalogue_snapshots` — the append-only history behind the `/admin/funnel` page. Zero LLM tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 24h.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/funnel-snapshot-sweep.sh`](../scripts/funnel-snapshot-sweep.sh) → [`../scripts/funnel-snapshot-sweep.ts`](../scripts/funnel-snapshot-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## Why a daily snapshot

Live counts are cheap; the growth-per-day charts on `/admin/funnel` need history nobody records (there is no `anchored_at`, no per-day ledger). This is the house `platform_stats` daily-snapshot pattern applied to the catalogue pipeline. **No backfill** — the series starts with the first real snapshot and grows honestly (invented history is worse than a short chart), and it is never pruned (the series IS the point).

## A missed day is permanent, so the tick is defended three ways

The same "no per-day ledger" fact that makes the snapshot necessary makes a MISSED firing unrecoverable: there is nothing to recompute the day from later, and the hole lands in every growth chart that reads the series. The three ways a firing goes missing each get their own defence, because no one of them covers the others:

1. **A transient Worker fault** (a 5xx while the snapshot's full-table scan contends with another sweep) — the sweep retries inside the tick, three attempts on a rising backoff ([`../scripts/funnel-snapshot-sweep.ts`](../scripts/funnel-snapshot-sweep.ts)). A run that exhausts the ladder still reports `ok: false`; the retry is a second chance, never a way to hide a failure.
2. **A database-admission yield** — the runner skips the payload before it starts, so no in-process retry can help and only another firing can. The timer therefore carries a **retry `OnCalendar` slot** later the same UTC day. The per-day upsert makes the extra run a no-op on a healthy night.
3. **A box asleep through the slot** — `Persistent=true` catches up after midnight, and the Worker's **catch-up grace window** then fills the missing previous day from the same computed counts (`SNAPSHOT_CATCHUP_GRACE_HOURS` in `apps/web/src/lib/server/funnel.ts`). Past that window the day stays missing on purpose: carrying a number forward would invent growth that did not happen. Every healed day is named in the response and echoed by the sweep as `backfilled` / `backfilledDays`, so a patched hole is visible in the run ledger rather than silently papered over.

## The model: box triggers, the Worker computes

The box holds no computation authority — it only fires the trigger. Per tick:

1. **POST** `/api/v1/admin/funnel/snapshot` with the box's AGENT token — a bare trigger (no body).
2. The **Worker** computes every stage total + queue depth + frontier count through the product's own predicates and **UPSERTS one row for the UTC day** (`on conflict(day) do update`), so a re-fired tick **overwrites** rather than doubles a bar.

**It calls the oRPC HTTP endpoint directly** (the `anchor-sweep.ts` / `verify-captures.ts` precedent), never a `fluncle admin …` subcommand — the box's baked CLI is a PINNED release and must not gain a new dependency. **No new secret**: every count is computed Worker-side, so the box is a bare trigger like the reach cron; `FLUNCLE_API_TOKEN` (the box's agent token) is already present.

## Why a host timer + the /status marker

Every automation cron runs from a repo-checked-in host timer so the SCHEDULE is code. Because a `docker exec` sends stdout to journald, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-funnel-snapshot`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.funnel-snapshot` row stays honest. The prober is UNCHANGED.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, this doc, and the `/status` registration (`cron.funnel-snapshot` in `@fluncle/registry` + the `fluncle-healthcheck` prober). Enabling it on the box is one manual pass, and it needs **no new secret**.

Install + enable the timer on the rave-02 HOST, from a repo checkout, as root:

```bash
sudo install -m 0644 docs/agents/hermes/funnel-snapshot-timer/fluncle-funnel-snapshot.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/funnel-snapshot-timer/fluncle-funnel-snapshot.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-funnel-snapshot.timer

# Verify one tick now (a manual tick takes a real snapshot — safe + idempotent within the day's slot).
sudo systemctl start fluncle-funnel-snapshot.service            # one tick now
journalctl -u fluncle-funnel-snapshot.service -n 40 --no-pager  # expect a { "ok": true, "day": "…", "crawled": …, … } summary line
systemctl list-timers fluncle-funnel-snapshot.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.funnel-snapshot` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `AUTOMATION_CRONS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
