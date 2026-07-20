# fluncle-social-metrics-timer — the daily per-post social-metrics snapshot on a host timer

The rave-02 host trigger for the `--no-agent` **social-metrics snapshot** sweep. `fluncle-social-metrics` fires one `record_social_metrics` a day: the WORKER selects the published `social_posts` rows worth measuring (a deterministic ≤25-post budget — see below), reads each one's Postiz per-post analytics (`GET /public/v1/analytics/post/:postId`), and APPENDS one row per (post, source, UTC day) into `social_metrics` — the append-only per-video performance ledger. It also reads the Simple-Analytics social→site referrer arrivals (the site-side half of reach) for observability. Zero LLM tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 24h.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/social-metrics-sweep.sh`](../scripts/social-metrics-sweep.sh) → [`../scripts/social-metrics-sweep.ts`](../scripts/social-metrics-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## Why a per-post snapshot

`platform_stats` (the `/reach` page) counts the whole CHANNEL — followers, total likes. It says nothing about how any INDIVIDUAL posted video did. This ledger is the `platform_stats` daily-snapshot pattern applied to each finding's own posts, so per-video reach — and its velocity (day-over-day deltas across the snapshots) — becomes measurable. **Append-only, never upsert-latest**: velocity is the point, so every day's row is kept. **No backfill** — the series starts with the first snapshot and grows honestly.

## The throttle budget (≤25 posts/run)

Postiz caps the public API at **30 requests/hour**. Each snapshotted post costs exactly ONE request; nothing else in the op calls Postiz. So a run is capped at **`SNAPSHOT_BUDGET` = 25** Postiz requests, leaving ~5/hour of headroom for the reach cron + a manual call. The 25 are spent deterministically (`selectSnapshotTargets`, `lib/server/social-metrics.ts`):

1. **Every post published within the last `RECENT_WINDOW_DAYS` (= 14) days**, newest first — the hot window where day-over-day velocity is worth capturing.
2. **The leftover budget on a rolling tail** of older posts, chosen **least-recently-snapshotted first** (a post never snapshotted, then the oldest snapshot; ties broken by newest published). The tail therefore cycles through the whole archive over successive runs without ever exceeding the budget.

The selection is a pure function of DB state + the clock, so it is deterministic and re-runnable. A post Postiz reports as `{ missing: true }` (a TikTok inbox draft whose release-id it hasn't resolved) is skipped cleanly; a post whose read errors is skipped as `failed` — neither aborts the batch.

## The model: box triggers, the Worker computes

The box holds no computation authority — it only fires the trigger. Per tick:

1. **POST** `/api/admin/social/metrics/record` with the box's AGENT token — a bare trigger (no body).
2. The **Worker** selects the budget, reads Postiz per-post analytics, and **appends** one snapshot per (post, source, UTC day) — `INSERT … ON CONFLICT(external_id, source, captured_day) DO NOTHING`, so a re-fired tick the same day appends nothing.

**It calls the oRPC HTTP endpoint directly** (the `funnel-snapshot` / `reach` precedent), never a `fluncle admin …` subcommand — the box's baked CLI is a PINNED release and must not gain a new dependency. **No new secret**: the Postiz key (and the Simple-Analytics key) live Worker-side, so the box is a bare trigger; `FLUNCLE_API_TOKEN` (the box's agent token) is already present.

## Why a host timer + the /status marker

Every automation cron is a repo-checked-in host timer so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-social-metrics`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.social-metrics` row stays honest.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, this doc, and the `/status` registration (`cron.social-metrics` in `@fluncle/registry` + the `fluncle-healthcheck` prober). Enabling it on the box is one manual pass, and it needs **no new secret**.

Install + enable the timer on the rave-02 HOST, from a repo checkout, as root:

```bash
sudo install -m 0644 docs/agents/hermes/social-metrics-timer/fluncle-social-metrics.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/social-metrics-timer/fluncle-social-metrics.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-social-metrics.timer

# Verify one tick now (a manual tick appends today's snapshots — safe + idempotent within the day's slot).
sudo systemctl start fluncle-social-metrics.service            # one tick now
journalctl -u fluncle-social-metrics.service -n 40 --no-pager  # expect a { "ok": true, "day": "…", "inserted": …, "polled": …, … } summary line
systemctl list-timers fluncle-social-metrics.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.social-metrics` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `AUTOMATION_CRONS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
