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

### Two filters, because a notification must mean real trouble

The catch-all's first night was noisy — one alert per failed unit per run — and an operator who learns to ignore the notifier has lost the notifier. So the script suppresses two classes of not-really-trouble failure. Both are safe because the healthcheck prober's freshness lag is the backstop: a sweep that is _genuinely_ stuck stops writing its `/status` marker, and the prober's staleness alert surfaces it regardless of what this hook does or doesn't post.

- **SIGTERM kills are skipped entirely.** When `pin-watch` swaps the hermes container mid-sweep, systemd reports the sweep as killed — but the next timer tick self-heals, so there is nothing to tell anyone. The script reads `ExecMainCode` alongside `ExecMainStatus` and handles both encodings systemd uses for a SIGTERM death: a **signaled** exit (`ExecMainCode=2` / `CLD_KILLED`, `ExecMainStatus=15`, the raw signal number) and a **shell-wrapped** exit (`ExecMainCode=1` / `CLD_EXITED`, `ExecMainStatus=143`, i.e. `128+15`). Either encoding logs the skip to journald (stderr) and exits `0` without posting.
- **A per-unit cooldown throttles repeats.** Before posting, the script checks a per-unit stamp file (`<state-dir>/<unit>.last`, holding the epoch of that unit's last _posted_ alert). If the last alert is younger than the cooldown (default 6h, override with `SWEEP_FAILURE_COOLDOWN_SECS`) it mutes this repeat — logging why to journald — and deliberately leaves the stamp untouched, so a mute never pushes the next real alert further out. On an actual post it writes the stamp. Net effect: a chronically-failing sweep says so once per ~6h instead of hourly, and an incident window that fails many sweeps at once (a db outage taking down six sweeps) posts at most one line **per unit**. Each posted line carries a `(muted for 6h)` suffix so the operator knows repeats are being suppressed. The cooldown is best-effort: if the state dir is missing or unwritable the script degrades to posting every time rather than swallowing an alert.

The **render condemnation** case is the cooldown's headline customer: a `render exit=1 box-condemned` failure is a self-healing state (the render box condemns itself and recovers on the next wake), so it is deliberately **not** a special case in code — the 6h cooldown is its chosen treatment, capping it at one line per window like any other repeating failure.

## Deploy (operator-gated — not part of the PR that added this)

`install-host-timers.sh` installs the template unit and lays the host script down at `/opt/fluncle-sweep-failure/`:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh
```

There is no timer to enable — the template only ever runs when a sweep fires its `OnFailure=`. To smoke it by hand once deployed:

```bash
sudo systemctl start 'fluncle-sweep-failure@fluncle-enrich.service'   # posts a test line for a (not-really-failed) unit
```
