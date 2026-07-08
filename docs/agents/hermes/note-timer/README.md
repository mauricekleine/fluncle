# fluncle-note-timer — the auto-note authoring sweep on a host timer

The rave-02 host trigger for the HYBRID `--no-agent` **auto-note** sweep. `fluncle-note` auto-authors a finding's public editorial `/log` note from its `context_note` fuel — deterministic everywhere (the queue read, the metadata gather, the write-back via the agent-tier `note_track` op) except one `claude -p` authoring call per finding, and fill-empty-only (an operator note is never clobbered). A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 10m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/note-sweep.sh`](../scripts/note-sweep.sh) → [`../scripts/note-sweep.ts`](../scripts/note-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources `${HOME}/.fluncle-secrets.env` (the `claude -p` OAuth token) and runs the bun orchestrator.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code (docs/hermes-durable-deploy-rfc.md § Unit E). Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-note`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.note` row stays honest. The prober is UNCHANGED.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/note-timer/fluncle-note.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/note-timer/fluncle-note.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-note.timer

# Verify.
sudo systemctl start fluncle-note.service            # one tick now
journalctl -u fluncle-note.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-note.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-note`) so it is not double-scheduled — green the timer first, never both live at once.
