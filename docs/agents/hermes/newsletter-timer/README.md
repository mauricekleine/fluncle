# fluncle-newsletter-timer — the weekly newsletter draft sweep on a host timer

The rave-02 host trigger for the HYBRID `--no-agent` **newsletter** sweep. `fluncle-newsletter` drafts + persists the weekly edition every Friday 15:00 Amsterdam — a self-healing discovery window off the last sent edition, one `claude -p` authoring call, then a persisted Resend Broadcast draft. The SEND is a separate operator-run command (a `clarify` Send button), never automatic. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container on the weekly slot. See [docs/agents/newsletter-agent.md](../../newsletter-agent.md) for the authoring doctrine.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/newsletter-sweep.sh`](../scripts/newsletter-sweep.sh) → [`../scripts/newsletter-sweep.ts`](../scripts/newsletter-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources `${HOME}/.fluncle-secrets.env` (the `claude -p` OAuth token) and runs the bun orchestrator.

## The timezone is in the timer, not the container clock

The systemd timer expresses the timezone DIRECTLY: `OnCalendar=Fri 15:00 Europe/Amsterdam`. So the Friday-afternoon slot is correct whatever the host or container clock reads, across the CET⇄CEST flip. The timer carries a 16:15 Friday retry slot, and the service passes `--weekday Fri` to the shared [`daily-retry-runner.sh`](../scripts/daily-retry-runner.sh). `Persistent=true` still re-arms the timer after a reboot or a unit refresh, but an activation on any day other than Friday, or before 15:00 on a Friday, is a no-op: a catch-up never authors an off-cycle edition. A Friday the box slept through across both slots waits for the next Friday.

## Why a host timer + the /status marker

Every automation cron runs from a repo-checked-in host timer so the SCHEDULE is code. Because a `docker exec` sends stdout to journald, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-newsletter`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.newsletter` row stays honest. The prober is UNCHANGED.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/newsletter-timer/fluncle-newsletter.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/newsletter-timer/fluncle-newsletter.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-newsletter.timer

# Verify (a manual tick drafts an edition now — safe: the send is operator-gated).
sudo systemctl start fluncle-newsletter.service            # one tick now
journalctl -u fluncle-newsletter.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-newsletter.timer             # confirm the next Fri 15:00 slot
```
