# fluncle-live-timer — the Twitch live-set poller on a host timer

The rave-02 host trigger for the `--no-agent` **live-set poller**. `fluncle-live` is the poller behind Fluncle's cross-surface live-set callout: every ~1m it mints/reuses a Twitch client-credentials app token, asks Helix whether `flunclelive` is streaming, and POSTs the raw live state to the agent-tier `record_live_state`. The Worker owns the smarts (transition detection + the Telegram callout); the poller is dumb + idempotent, burns zero LLM tokens, and read-side auto-clear (a flag older than ~5m reads offline) means a dead poller can never strand a permanent "LIVE" banner. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 1m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/fluncle-live.sh`](../scripts/fluncle-live.sh) → [`../scripts/fluncle-live.ts`](../scripts/fluncle-live.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources `${HOME}/.fluncle-secrets.env` (the Twitch client id/secret) and runs the bun orchestrator.

## Not yet on /status (a flagged follow-up)

`fluncle-live` is **not** in the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `AUTOMATION_CRONS`, so there is no `cron.live` row on `/status` today. The sweep self-writes a `# Cron Job: fluncle-live` marker (via [`cron-output.sh`](../scripts/cron-output.sh)) so a future prober entry would light up with zero sweep changes — but adding that entry (and its `@fluncle/registry` surface) is a follow-up, out of this migration's scope (the prober was kept UNCHANGED here).

## Why a host timer

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code and survives a re-provision (docs/hermes-durable-deploy-rfc.md § Unit E). A 1m poll on the serial gateway runner was especially fragile to a long sweep stealing its slot; a host timer fires on time regardless.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/live-timer/fluncle-live.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/live-timer/fluncle-live.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-live.timer

# Verify.
sudo systemctl start fluncle-live.service            # one tick now
journalctl -u fluncle-live.service -n 40 --no-pager  # expect a { "ok": true, "live": … } summary line
systemctl list-timers fluncle-live.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-live`) so it is not double-scheduled — green the timer first, never both live at once.
