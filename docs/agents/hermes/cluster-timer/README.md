# fluncle-cluster-timer — the sonic-galaxy cluster engine on a host timer

The rave-02 (Hermes box) host trigger for the **browse-by-feel** cluster engine. `fluncle-cluster` keeps the sonic-galaxy map current: each night it assigns every embedded finding to its nearest stored galaxy centroid (cosine, over the MuQ embedding space), recomputes each centroid as its members' mean, retires an emptied galaxy, and consumes any operator-requested split. This is what SCHEDULES it: a small host systemd timer on the rave-02 host that `docker exec`s the baked sweep script inside the `hermes` container once a night (02:20 Amsterdam).

The engine's full doctrine (why the nightly run is assignment-only, why a full fit is an operator act, the write-order contract, the naming flow) is [docs/agents/cluster-engine.md](../cluster-engine.md); the design record is [docs/rfcs/browse-by-feel.md](../../rfcs/browse-by-feel.md). This file is the box wire-up only.

The sweep WORK is BAKED into the image — the `.sh`/`.ts`/`.py` trio at `/opt/hermes-scripts/` (source: [`../scripts/cluster-sweep.sh`](../scripts/cluster-sweep.sh) → [`../scripts/cluster-sweep.ts`](../scripts/cluster-sweep.ts) → [`../scripts/cluster.py`](../scripts/cluster.py)) plus **sklearn + scipy** in the baked MuQ venv (`/opt/muq-venv`, the Dockerfile MuQ layer's third pinned pip step). It rides the image and auto-updates from `main` via the hourly pin-watch rebuild — no `docker cp`. The host timer is only the trigger; the `.sh` is the same entry a manual `bash /opt/hermes-scripts/cluster-sweep.sh` runs.

## Why it's a host timer, not a Hermes cron

The cluster engine is a **stateful nightly batch job**: it reads the whole embedded corpus + the map and writes the map back. It is not latency-sensitive and it must not occupy the shared serial Hermes `--no-agent` gateway runner (its ~300s global budget) where a batch read/write could starve the 5-minute enrich/context/note sweeps. So it runs on a **host** systemd timer, exactly like [`fluncle-embed`](../embed-timer/README.md), [`fluncle-capture`](../capture-timer/README.md), and the nightly [`fluncle-logbook`](../logbook-timer/README.md) / audit crons. The host scheduler is never busy with Fluncle's app work, so the tick fires on time.

Nightly, not every-5m: the tick is assignment-only and idempotent — a **no-op on an unchanged corpus** — so once a night is plenty for a browse surface and reinforces the fixed-point discipline (structure changes only by an operator act).

## What a nightly run does

Each tick is one `docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/cluster-sweep.sh` (the in-container work runs as the unprivileged `hermes` user):

1. `cluster-sweep.sh` sources the `0600` `${HOME}/.fluncle-secrets.env` (for `FLUNCLE_API_TOKEN` / `FLUNCLE_API_BASE_URL` — the best-effort cost emit) and execs the bun orchestrator. The `fluncle` CLI's own admin auth (the map read + the corpus read + the map/assignment write-back) uses the box's baked config; the box holds only an `agent`-scoped token, so the OPERATOR-tier `update_galaxy` (naming) 403s here by design — the cron only reads/writes the map + assignments (admin tier) and consumes `split_requested_at`.
2. `cluster-sweep.ts` reads the map (`fluncle admin galaxies map`) + the whole embedded corpus (`fluncle admin galaxies embeddings`, cursor-paginated), then — **assignment-only, pure TS, no python** — assigns each finding to its nearest stored centroid, writes back ONLY the changed assignments (`fluncle admin tracks update --galaxy-id`, diffed against each finding's current `galaxyId` so an unchanged corpus never churns the `/log` cache), recomputes centroids as members' means, and retires any emptied galaxy via the transactional map write (`fluncle admin galaxies set-map`). It also consumes any operator `split_requested_at` (a k=2 fit on that galaxy's members via `cluster.py` — the one place the nightly tick spawns python). It prints one JSON summary line (including the per-galaxy silhouette evidence and size).
3. `cron.cluster`'s `/status` row is read by the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober from the cron output dir — `cron-output.sh` writes the marker so the prober tracks it by the `fluncle-cluster` name in its `AUTOMATION_CRONS` mirror even though the SCHEDULER is a host timer.

Zero LLM tokens; sub-second CPU; a few MB peak RAM (no RAM pilot needed, unlike MuQ). One `self`/`seconds` cost row per run (`subsidized`, on-box compute, step `cluster`).

## The operator acts (run by hand, NEVER scheduled)

A full k-means fit is an operator act — a warm-started full re-fit can relocate an emptied centroid across the map (sklearn `_relocate_empty_clusters`), the exact bookmark-breaking reshuffle the feature forbids. The timer NEVER fits. The operator runs these by hand on the box:

```bash
# COLD START (run 1 — the k=9 fit; the map must be empty). Mints 9 galaxies + handles,
# assigns every finding, then STOP: the operator names the map (Slice 3) before it goes public.
docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/cluster-sweep.sh --cold-start

# REMINT (a deliberate full redraw: retire every id, refit fresh k=9, re-queue naming).
# Reserved for an embed-model change or a corpus shift too large for splits.
docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/cluster-sweep.sh --remint
```

A SPLIT is operator-triggered without a manual run: the operator requests it in `/admin/galaxies` (`update_galaxy` sets `split_requested_at`); the next nightly tick consumes it (a k=2 fit on that galaxy's members, the parent keeps its id on the larger child, the Worker mints one new id + handle for the smaller child, which lands unnamed in the naming queue).

## Deploy (on rave-02, one time)

The image bake (Unit A) puts the sweep trio + sklearn/scipy in the MuQ venv; you only install the host units. Do all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh) (it auto-discovers this `*-timer/` dir), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/cluster-timer/fluncle-cluster.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/cluster-timer/fluncle-cluster.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-cluster.timer

# The cold-start pilot BEFORE arming the timer (de-risks the most, per the RFC): run the k=9
# fit by hand, eyeball the silhouette evidence with the operator, then name the map (Slice 3).
docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/cluster-sweep.sh --cold-start
journalctl -u fluncle-cluster.service -n 40 --no-pager  # expect a { "ok": true, "minted": 9, … } line
systemctl list-timers fluncle-cluster.timer
```

pin-watch's pre-smoke guards the fit engine on every rebuild — it imports `torch, muq, sklearn, scipy` in the MuQ venv, so a rebuild that ships a broken stack fails pre-smoke and rolls back instead of swapping in a dead engine.

## Box activation gate (a rebake, not just a timer)

Unlike a pure-script cron, `fluncle-cluster` needs the **image rebaked before activation**: the venv gains sklearn + scipy (a new pinned pip layer) and the sweep trio must be baked in. The verbs it drives (`admin galaxies map` / `embeddings` / `set-map`, `admin tracks update --galaxy-id`) shipped in the Slice 1 CLI release, and the additive request/response fields Slice 2 adds pass through the thin client at runtime — so no NEW CLI verb is required, only the rebake for the venv layer + scripts. The rebake path is the standard pin-watch rebuild (or an attended `--force` rebuild); the operator drives the box side.
