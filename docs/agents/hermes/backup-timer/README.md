# fluncle-backup-timer — the database-backup sweep on a host timer

The rave-02 host trigger for the `--no-agent` **database-backup** sweep. `fluncle-backup` dumps the prod DB → gzip → an S3-direct PUT to a PRIVATE R2 bucket (the owned off-site backup) and prunes to 30 daily / 12 monthly, zero LLM tokens. This is the backup half of the reset boundary: it is what lets the accumulated `state.db` state (sessions/memories/kanban/cron-output history) be restored after a re-provision — the restore TOOLING is the one sanctioned follow-on named in docs/hermes-durable-deploy-rfc.md § Unit E. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 24h.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/backup-sweep.sh`](../scripts/backup-sweep.sh) → [`../scripts/backup-sweep.ts`](../scripts/backup-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources `${HOME}/.fluncle-secrets.env` (the Turso dump creds + the private backup-bucket R2 creds) and runs the bun orchestrator.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code (docs/hermes-durable-deploy-rfc.md § Unit E). Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-backup`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.backup` row stays honest. The prober is UNCHANGED.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/backup-timer/fluncle-backup.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/backup-timer/fluncle-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-backup.timer

# Verify (a manual tick writes a real backup object — safe + idempotent within the day's slot).
sudo systemctl start fluncle-backup.service            # one tick now
journalctl -u fluncle-backup.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-backup.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-backup`) so it is not double-scheduled — green the timer first, never both live at once.
