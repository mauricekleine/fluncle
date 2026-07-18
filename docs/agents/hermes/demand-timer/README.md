# fluncle-demand-timer — the nightly demand reorder on a host timer

The rave-02 host trigger for the `--no-agent` **demand** sweep. `fluncle-demand` fires one `fluncle admin catalogue demand` a night: the WORKER reads Simple Analytics for the `/artist/<slug>` + `/label/<slug>` pageviews over the trailing 30 days, resolves the looked-at slugs to entities, and REWRITES two derived reorder columns — `tracks.demand_score` (the capture queue's within-tier secondary sort) and `crawl_frontier.demand_rank` (the frontier pick's within-hop tiebreak) — so both lean toward the artists and labels real visitors came looking for. **Rank-order only**: demand reorders WITHIN a tier and never overrides the `capture_priority` veto (a ruled-out label is never resurrected), and the seed-allowlist crawl gate is untouched. The rewrite is a full clear-then-set, so a same-window re-run lands the same columns (idempotent). Zero LLM tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every night at 04:40 Amsterdam (just after the 04:00 reach snapshot — both daily analytics reads in one window). See [docs/catalogue-crawler.md § Demand](../../../catalogue-crawler.md).

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/demand-sweep.sh`](../scripts/demand-sweep.sh) → [`../scripts/demand-sweep.ts`](../scripts/demand-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). It calls the baked `fluncle` CLI's `admin catalogue demand`; the box's agent-scoped token (which rides the container env like the other CLI sweeps) drives the AGENT-tier `record_demand` op. **No new box secret** — the Simple Analytics key lives Worker-side, which is the whole reason the box cron is a bare trigger. Unlike the other daily sweeps this driver retries ONCE on a thrown fault (a cold Worker / an SA blip), so a nightly signal never skips a whole day on one transient.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-demand`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.demand` row stays honest. The prober is UNCHANGED.

## Production pre-reqs (operator, one time)

1. **Set the Worker secret.** The demand op needs the Simple Analytics read key Worker-side:

   ```bash
   # a CF Worker secret on apps/web (the value lives in 1Password, never the repo)
   bunx wrangler secret put SIMPLE_ANALYTICS_API_KEY   # from the apps/web dir
   ```

   Until it is set the op returns `configured: false` and is a clean no-op — the tick still reads green on /status (an honest empty tick, not a failure), it just changes no columns.

2. **The baked CLI must carry `admin catalogue demand`.** It ships via the automatic release → pin-bump → rebake chain; once pin-watch has rebaked the image past the CLI release that adds the verb, the sweep resolves it. Before then a tick exits nonzero (`did not return JSON` / unknown command) and reads as a failing row on /status — expected until the rebake lands (the reach-cron precedent).

## Activation (on rave-02, one time — operator-gated)

This is a NEW cron; nothing to retire. It goes live with a single `install-host-timers.sh` run on the box (which discovers every `*-timer/` dir), or install just this one:

```bash
sudo install -m 0644 docs/agents/hermes/demand-timer/fluncle-demand.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/demand-timer/fluncle-demand.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-demand.timer

# Verify (a manual tick is safe + idempotent — a full clear-then-set of the reorder columns).
sudo systemctl start fluncle-demand.service            # one tick now
journalctl -u fluncle-demand.service -n 40 --no-pager  # expect a { "ok": true, "configured": …, "tracksScored": N, … } summary line
systemctl list-timers fluncle-demand.timer
```
