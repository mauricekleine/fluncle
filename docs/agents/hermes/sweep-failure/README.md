# fluncle-sweep-failure — the OnFailure catch-all for the host sweeps

Every rave-02 host-timer sweep self-reports its health by writing a `/status` marker (`scripts/cron-output.sh`) whose last stdout line the healthcheck prober parses (`.ok !== false`). That signal only exists if the run gets far enough to print a summary. A run that dies before that — an OOM kill, a missing binary, a crash before the sweep's top-level catch — writes no marker, so the prober reads the job as "fresh, no news" and nobody is told. That is the hole this dir closes.

Every sweep `.service` under `../*-timer/` carries `OnFailure=fluncle-sweep-failure@%n.service`. On a hard failure systemd instantiates the template unit here with the failed unit's name, and it posts one minimal Discord line.

## What's here

- `fluncle-sweep-failure@.service` — a systemd **template** unit (note the `@`). `%i` is the failed unit's name (from `@%n.service` on the sweep). It runs the host script below. It carries no `OnFailure=` of its own — a failing notifier must never loop.
- `fluncle-sweep-failure-notify.sh` — the host script. Reads `DISCORD_ALERT_WEBHOOK` from the **live container's env** via `docker inspect` (the exact credential-free read pin-watch's `rebuild-hermes.sh` uses — no config file, no `op`, no secret on host disk), queries host systemd for the failed unit's `Result` + exit status, and POSTs one line.

## Why a host script (not a `docker exec` into the container, like the sweeps)

The exit status is host-only information — the container can't see host systemd. So the notifier runs on the host, exactly like pin-watch. The webhook still comes from the container's env, so the secret handling is unchanged. If the container is down (so the webhook can't be read) it exits cleanly: a whole-box outage is the healthcheck's external beacon's job, not this per-unit hook's.

## What the alert contains — and deliberately doesn't

Minimal: the failed unit name, systemd's `Result` verdict (`exit-code` / `timeout` / `oom-kill` / …), and the process exit code, plus a pointer to `journalctl -u <unit>`. **Never a journal excerpt** — journald lines can carry sensitive material; the operator reads the journal themselves.

## Deploy (operator-gated — not part of the PR that added this)

`install-host-timers.sh` installs the template unit and lays the host script down at `/opt/fluncle-sweep-failure/`:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh
```

There is no timer to enable — the template only ever runs when a sweep fires its `OnFailure=`. To smoke it by hand once deployed:

```bash
sudo systemctl start 'fluncle-sweep-failure@fluncle-enrich.service'   # posts a test line for a (not-really-failed) unit
```
