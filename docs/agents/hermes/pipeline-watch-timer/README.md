# Pipeline yield watchdog

The host timer fires every 15 minutes with up to 60 seconds of jitter. Its service runs `pipeline-watch.sh` as the unprivileged `hermes` user inside the long-lived container. The sweep reads bounded cron markers and agent-allowed Worker counters without a database admission lease, writes its own marker and run-ledger summary, and keeps incident delivery state under `${HOME}/.pipeline-watch/state.json`.

The embed worklist's opt-in `age=true` read checks the same partial-indexed queue predicate for any captured source older than 24 hours. It returns a boolean without a track ID, and `null` when a queued legacy row lacks a capture timestamp and no older stamped row is found. A missing age read is treated as an unavailable measurement; queue growth over a full day is independently tracked in `${HOME}/.pipeline-watch/embed-trend.json`.

After the image containing the sweep is baked and running, install the two host units from a checkout on the box and enable the timer:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-pipeline-watch.service --refresh-unit fluncle-pipeline-watch.timer
sudo systemctl enable --now fluncle-pipeline-watch.timer
sudo systemctl start fluncle-pipeline-watch.service
sudo journalctl -u fluncle-pipeline-watch.service -n 30 -o cat
```

The installer discovers the pair automatically during a full provisioning run. The existing healthcheck reads the watchdog marker as `cron.pipeline-watch`; pin-watch quiesces and restores this timer through its dynamic `fluncle-*.timer` roster, and the host timer watchdog checks its next elapse through that same dynamic roster. Its own missing or stale tick therefore appears on `/status`.
