# fluncle-album-bio-timer — the album voiced-bio authoring sweep on a host timer

The rave-02 host trigger for the HYBRID `--no-agent` **album-bio** sweep. `fluncle-album-bio` auto-authors an album's public bio (the short Fluncle-voiced paragraph that stands on `/album/<slug>`) — deterministic everywhere (the queue read, the best-effort grounding gather, the write-back via the agent-tier `describe_album` op) except one `claude -p` authoring call per entity, and fill-empty-only (an operator bio is never clobbered). A host systemd timer `docker exec`s the baked sweep inside the `hermes` container every 30m.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the shared `entity-bio-sweep.ts` driven by [`../scripts/album-bio-sweep.sh`](../scripts/album-bio-sweep.sh) (`--kind album`) — riding the image and auto-updating from `main` via pin-watch (Unit A). The `.sh` sources `${HOME}/.fluncle-secrets.env` (the `claude -p` OAuth token) and runs the bun orchestrator. Its artist + label siblings are [`../artist-bio-timer/`](../artist-bio-timer/) and [`../label-bio-timer/`](../label-bio-timer/).

## Why a host timer + the /status marker

Every automation cron moved off the gateway's single serial runner onto repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-album-bio`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.album-bio` row stays honest. The prober is UNCHANGED.

## Box activation is OPERATOR-GATED

The repo half ships (this timer + the baked sweep + docs); nothing auto-enables and nothing spends model credits on merge, mirroring the crawler/cluster/triage pattern. Enable it only after the pre-flight (below).

## Deploy (on rave-02, one time — operator-gated)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh) (it auto-discovers this `*-timer/` dir — no installer edit needed), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/album-bio-timer/fluncle-album-bio.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/album-bio-timer/fluncle-album-bio.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# Pre-flight: a dry run against a couple of real slugs (voice gate only, nothing stored).
docker exec -u hermes -e HOME=/opt/data/home hermes \
  bash /opt/hermes-scripts/entity-bio-sweep.ts --kind album --dry-run <slug-a> <slug-b>

# One real tick, then enable.
sudo systemctl start fluncle-album-bio.service            # one tick now
journalctl -u fluncle-album-bio.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
sudo systemctl enable --now fluncle-album-bio.timer
systemctl list-timers fluncle-album-bio.timer
```

Watch the first ticks + the marker under `/opt/data/cron/output/fluncle-album-bio/` and the `cron.album-bio` row on `/status`.
