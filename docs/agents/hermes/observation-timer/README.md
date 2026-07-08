# fluncle-observation-timer — the recovered-audio observation sweep on a host timer

The rave-02 host trigger for the HYBRID `--no-agent` **observation** sweep. `fluncle-observation` authors a finding's spoken recovered-audio observation — deterministic everywhere (the queue read, the metadata gather, the render delivery via the `fluncle` CLI) except one `claude -p` call that turns the finding's facts into a script in Fluncle's voice, then a Worker-side Cartesia render. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 60m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/observe-sweep.sh`](../scripts/observe-sweep.sh) → [`../scripts/observe-sweep.ts`](../scripts/observe-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources `${HOME}/.fluncle-secrets.env` (the `claude -p` OAuth token) and runs the bun orchestrator.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code (docs/hermes-durable-deploy-rfc.md § Unit E). Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-observation`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.observation` row stays honest. The prober is UNCHANGED.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/observation-timer/fluncle-observation.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/observation-timer/fluncle-observation.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-observation.timer

# Verify.
sudo systemctl start fluncle-observation.service            # one tick now
journalctl -u fluncle-observation.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-observation.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-observation`) so it is not double-scheduled — green the timer first, never both live at once. (The observation sweep costs Cartesia credits + subscription quota per render — watch the first tick before walking away.)
