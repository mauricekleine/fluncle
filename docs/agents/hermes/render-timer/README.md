# fluncle-render-timer — the video render conductor on a host timer

The rave-02 host trigger for the `--no-agent` **render conductor**. `fluncle-render` drives the per-finding video render on a SCALE-TO-ZERO box.ascii render box (rave-03): it wakes the box, freshens its checkout to `main`, triggers the `@fluncle-video` render of exactly one queued finding via `claude -p` (DETACHED, ~85m), and parks the box when the render finishes. The conductor is a two-state single-flight machine (`idle` → maybe start; `rendering` → poll + park), so the tick itself returns in seconds. A host systemd timer `docker exec`s the baked conductor inside the `hermes` container every 60m.

The conductor is BAKED at `/opt/hermes-scripts/render-conductor.sh` (source: [`../scripts/render-conductor.sh`](../scripts/render-conductor.sh)) riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why the ExecStart is different from the other timers

Every other sweep is a thin wrapper that sources [`cron-output.sh`](../scripts/cron-output.sh) and wraps its single payload internally. The render conductor is a full STATE MACHINE with many inline `exit`s (skip-lock, single-flight hold, queue-empty, provision-fail, started), so it can't wrap itself with one `emit_cron_output` call. Instead the marker wrap happens at the UNIT: `bash -c '. cron-output.sh && emit_cron_output render -- bash render-conductor.sh'` runs the conductor as a child, captures its one-line summary, and writes the `# Cron Job: fluncle-render` marker the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober reads for `cron.render`. The prober is UNCHANGED.

## Dependency: provision-rave-03.sh must be baked too

`render-conductor.sh` execs `provision-rave-03.sh` from its own dir (`PROVISION="${PROVISION:-$SCRIPT_DIR/provision-rave-03.sh}"`) whenever box.ascii has reclaimed the render box and it must reprovision. For the conductor to run from `/opt/hermes-scripts/`, the image bake (Unit A) MUST also bake `provision-rave-03.sh` alongside it. If the bake's include list omits it, either add it, or set `-e PROVISION=<baked-path>` on the ExecStart pointing at wherever it is baked. (`render-detached.sh` runs ON rave-03, not here, so it does not need to be at `/opt/hermes-scripts/`.)

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/render-timer/fluncle-render.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/render-timer/fluncle-render.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-render.timer

# Verify.
sudo systemctl start fluncle-render.service            # one tick now
journalctl -u fluncle-render.service -n 40 --no-pager  # expect a render-conductor: … summary line
systemctl list-timers fluncle-render.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-render`) so it is not double-scheduled — green the timer first, never both live at once.
