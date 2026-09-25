# fluncle-enrich-timer — the on-box enrichment sweep on a host timer

The rave-02 (Hermes box) host trigger for the `--no-agent` **enrichment** sweep. `fluncle-enrich` does the BPM / musical-key / spectral analysis on the box (ffmpeg + the pure-TS DSP), zero LLM tokens, and writes the result back via the agent-tier `update_track` op. This is what SCHEDULES it: a small host systemd timer that `docker exec`s the baked sweep inside the `hermes` container every 5m.

The sweep WORK is BAKED into the image — the `.sh`/`.ts` pair at `/opt/hermes-scripts/` (source: [`../scripts/enrich-sweep.sh`](../scripts/enrich-sweep.sh) → [`../scripts/enrich-sweep.ts`](../scripts/enrich-sweep.ts)) plus the enrichment DSP skill at `/opt/hermes-skills/fluncle-track-enrichment/scripts/` (`analyze-track.ts`). Both ride the image and auto-update from `main` via the hourly pin-watch rebuild (Unit A) — no `docker cp`, no `/opt/data` copy. The host timer is only the trigger; the `.sh` sources `${HOME}/.fluncle-secrets.env` and runs the bun orchestrator.

## Why a host timer

Every automation cron runs from a repo-checked-in host systemd timer, so the SCHEDULE is code and survives a re-provision. Host timers run in parallel, so a slow sweep never starves the latency-sensitive ones; `Persistent=true` catches up a tick missed across a reboot; `journalctl -u fluncle-enrich` is the per-cron log.

## The /status marker (why the sweep self-reports)

The [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober reads `cron.enrich` from the run markers under `~/.hermes/cron/output/<job>/<ts>.md`. A host-timer `docker exec` sends stdout to journald, so the sweep writes that marker ITSELF via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper (`# Cron Job: fluncle-enrich` header + the JSON summary as the last line).

## Deploy (on rave-02, one time)

The image bake (Unit A) puts the scripts + skill in place; you only install the host units. Do all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/enrich-timer/fluncle-enrich.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/enrich-timer/fluncle-enrich.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-enrich.timer

# Verify.
sudo systemctl start fluncle-enrich.service            # one tick now
journalctl -u fluncle-enrich.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-enrich.timer
```
