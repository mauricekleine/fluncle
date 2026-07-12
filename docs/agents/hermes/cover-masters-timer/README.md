# fluncle-cover-masters-timer — the owned-cover-master resolver on a host timer

The rave-02 host trigger for the `--no-agent` **owned-cover-master resolve** sweep (RFC musickit-second-authority, U3b). `fluncle-cover-masters` gives every `pending` album and artist its OWN ≤1200²-capped cover derivative in Fluncle's own R2 (found.fluncle.com) instead of hotlinking a third party's bytes. It resolves each entity up its source ladder — album: **Apple template → Cover Art Archive → Spotify floor**; artist: **Spotify floor** — and stores the result at `albums/<slug>.<ext>` / `artists/<slug>.<ext>`. The full design is [docs/album-artwork.md](../../../album-artwork.md).

**Why it must be durable, not a one-shot.** The one-shot `fluncle admin backfills cover-masters` operator run seeds the albums/artists that exist when it runs. But the publish path and the catalogue crawl MINT new albums/artists continuously, each landing at `image_state='pending'` — and nothing owns their cover. This cron closes that: minting makes the row exist, this sweep gives it a master. The same crawler ↔ ranking loop shape.

It **certifies nothing** and **publishes nothing** — an owned cover master is internal, reversible display metadata (a downscaled derivative, the REF-05-conscious 1200 line; see [docs/album-artwork.md](../../../album-artwork.md)). **Zero LLM tokens** — a pure trigger.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/cover-masters-sweep.sh`](../scripts/cover-masters-sweep.sh) → [`../scripts/cover-masters-sweep.ts`](../scripts/cover-masters-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: Worker-paced, both kinds per tick, and the schedule is the loop

The Worker fetches each source image (a size-controlled ≤1200 rendition), byte-verifies the cap, and stores the master; this driver only paces it — ONE bounded batch of albums, then one of artists, per tick, via the `fluncle` CLI (`backfill_cover_masters`, agent tier). The Worker carries the durable per-entity reliability state (`image_state` / `image_attempted_at` / `image_failures`) and the ≤1200 cap.

That split makes the **cadence, not the batch size, the real throttle.** Every scrap of state is on the `albums`/`artists` row, so "run again" and "resume" are the same command: a `resolved`/`none` entity is terminal and skipped forever; a transient failure backs off on a cooldown; a persistent one gives up (→ `none`, the raw-URL floor) so it is never retried forever. A reboot mid-worklist costs nothing.

- `FLUNCLE_COVER_MASTERS_LIMIT` (default `24`) — entities handled per kind per tick. The CLI loops the slug cursor internally up to this cap (or until the worklist drains); each entity is a single image GET, so a tick is well under a minute.

Check on it any time:

```bash
fluncle admin backfills cover-masters --kind album  --dry-run   # the eligible ALBUM worklist; writes nothing
fluncle admin backfills cover-masters --kind artist --dry-run   # the eligible ARTIST worklist; writes nothing
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-cover-masters`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `backfill_cover_masters` is AGENT tier, so the box's existing agent-scoped token drives it. **Prerequisite (decision B):** the Cloudflare Images zone toggle must be ON (it is — the operator flipped it; see [docs/album-artwork.md](../../../album-artwork.md) for the one-line prod verification `curl`).

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/cover-masters-timer/fluncle-cover-masters.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/cover-masters-timer/fluncle-cover-masters.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-cover-masters.timer

# Verify one tick now.
sudo systemctl start fluncle-cover-masters.service            # one tick
journalctl -u fluncle-cover-masters.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-cover-masters.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.cover-masters` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `CRON_SPECS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
