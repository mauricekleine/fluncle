# Pipeline yield watchdog

The host timer fires every 15 minutes with up to 60 seconds of jitter. Its service runs `pipeline-watch.sh` as the unprivileged `hermes` user inside the long-lived container. The sweep reads bounded cron markers and agent-allowed Worker counters without a database admission lease, writes its own marker and run-ledger summary, and keeps incident delivery state under `${HOME}/.pipeline-watch/state.json`.

The watchdog reads agent-allowed `GET /api/v1/admin/catalogue/pipeline` for frontier, anchor, storable, unstorable, and capture backlogs. Each count is `{count, atLeast}`; `atLeast: true` makes `count` a lower bound. The caps are 1,000 frontier and anchors, 1 storable, 5,000 unstorable, and 2,000 capture. A null capture count means repair debt prevented a reliable measurement; if the due-work cutover is disabled, the read falls back to the exact legacy count. Alerts and marker summaries retain the lower-bound flag, and the ordinary `get_crawl_status` and CLI reads remain exact.

The embed worklist's opt-in `age=true` read checks the same partial-indexed queue predicate for any captured source older than 24 hours. It returns a boolean without a track ID; a queued row with no capture stamp carries no age and cannot make it true. A failed age read is treated as an unavailable measurement; queue growth over a full day is independently tracked in `${HOME}/.pipeline-watch/embed-trend.json`.

After the image containing the sweep is baked and running, install the two host units from a checkout on the box and enable the timer:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-pipeline-watch.service --refresh-unit fluncle-pipeline-watch.timer
sudo systemctl enable --now fluncle-pipeline-watch.timer
sudo systemctl start fluncle-pipeline-watch.service
sudo journalctl -u fluncle-pipeline-watch.service -n 30 -o cat
```

The installer discovers the pair automatically during a full provisioning run. The existing healthcheck reads the watchdog marker as `cron.pipeline-watch`; pin-watch quiesces and restores this timer through its dynamic `fluncle-*.timer` roster, and the host timer watchdog checks its next elapse through that same dynamic roster. Its own missing or stale tick therefore appears on `/status`.

Paging policy: a `stalled` verdict pages on open and re-pages at 1h, 4h, then every 24h while it lasts; recovery posts after two healthy checks. `measurement_unavailable` pages only once it has persisted for an hour, so a fresh window after an image swap stays quiet. `degraded` (embed capacity below intake) never pages: the embed backlog is drained by off-box batches, so it is reported in the summary only. `budget_closed` and `scheduled_pause` never page.

Cause attribution checks a label gate before any other blocker: a sweep that refuses every found track cannot store output even if its admission lane opens. It then prefers the sweep's named blocker, repair debt, and admission pauses before vendor throttling; repair and paused ticks can also report `throttled`, so that flag alone is not enough. A scheduled pause freezes an open incident until the stage is measured again. The capture budget is considered exhausted below 16 MiB remaining, which is too small to reliably land another captured file even when the budget reports open. Agent-allowed Worker reads use a 60-second timeout inside the timer unit's 180-second limit.
