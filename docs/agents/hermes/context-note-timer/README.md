# fluncle-context-note-timer — the context-note sweep on a host timer

The rave-02 host trigger for the `--no-agent` **context-note** sweep. `fluncle-context-note` fills the factual `context_note` for findings that lack one — the box holds no Firecrawl key and no LLM, so it just TRIGGERS the Worker per queued finding (Firecrawl search + Haiku distill + the quiet `context_note` write happen Worker-side). Zero box tokens. A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 5m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/context-sweep.sh`](../scripts/context-sweep.sh) → [`../scripts/context-sweep.ts`](../scripts/context-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-context-note`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.context-note` row stays honest. The prober is UNCHANGED.

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/context-note-timer/fluncle-context-note.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/context-note-timer/fluncle-context-note.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-context-note.timer

# Verify.
sudo systemctl start fluncle-context-note.service            # one tick now
journalctl -u fluncle-context-note.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-context-note.timer
```

Then RETIRE the gateway copy (`hermes cron list` → `hermes cron delete <id>` for `fluncle-context-note`) so it is not double-scheduled — green the timer first, never both live at once.
