# fluncle-newsletter-timer — the weekly newsletter draft sweep on a host timer

The rave-02 host trigger for the HYBRID `--no-agent` **newsletter** sweep. `fluncle-newsletter` drafts + persists the weekly edition every Friday 15:00 Amsterdam — a self-healing discovery window off the last sent edition, one `claude -p` authoring call, then a persisted Resend Broadcast draft. The SEND is a separate operator-run command (a `clarify` Send button), never automatic. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container on the weekly slot. See [docs/agents/newsletter-agent.md](../../newsletter-agent.md) for the authoring doctrine.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/newsletter-sweep.sh`](../scripts/newsletter-sweep.sh) → [`../scripts/newsletter-sweep.ts`](../scripts/newsletter-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources `${HOME}/.fluncle-secrets.env` (the `claude -p` OAuth token) and runs the bun orchestrator.

## The timezone is in the timer, not the container clock

The gateway ran the newsletter on the cron expression `0 15 * * 5` evaluated against the CONTAINER clock — which is the whole reason the box was pinned to `TZ=Europe/Amsterdam` (Hermes crons had no per-job TZ field). A systemd timer expresses the timezone DIRECTLY: `OnCalendar=Fri 15:00 Europe/Amsterdam`. So the Friday-afternoon slot is correct even if the host or container TZ ever drifts. `Persistent=true` catches up a Friday the box slept through — harmless, because a late run only persists a draft.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-newsletter`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.newsletter` row stays honest. The prober is UNCHANGED.

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

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-newsletter`) so it is not double-scheduled — green the timer first, never both live at once.
