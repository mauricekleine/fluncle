# fluncle-label-images-timer — the label-image resolver on a host timer

The rave-02 host trigger for the `--no-agent` **label-image resolve** sweep. `fluncle-label-images` gives every `pending` label its OWN logo instead of a borrowed album cover: it walks each label's MusicBrainz identity, reads its curated Discogs/Wikidata url-rels, and downloads the logo once into Fluncle's own R2, up the ladder **Discogs → Wikidata → none** (the freshest-cover floor). The full design is [docs/label-entity.md](../../../label-entity.md#the-labels-own-image-its-real-logo-not-a-borrowed-cover).

**Why it must be durable, not a one-shot.** The one-shot `fluncle admin backfills label-images` operator run seeded the labels that existed when it ran. But the catalogue crawl (`fluncle-crawl`) MINTS new labels every few minutes, each landing at `image_state='pending'` — and nothing resolved them. This cron closes that: the crawl makes labels exist, this sweep gives each a logo. The two are one loop, the same way the crawler and The Ear's ranking are.

It **certifies nothing** and **publishes nothing** — a label logo is internal, reversible metadata (nominative-use trademark, the same posture as album art). It resolves only the picture on the label's own surfaces. **Zero LLM tokens** — a pure trigger.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/label-images-sweep.sh`](../scripts/label-images-sweep.sh) → [`../scripts/label-images-sweep.ts`](../scripts/label-images-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: Worker-paced, and the schedule is the loop

The box holds no Discogs key and no MusicBrainz budget; the Worker does. So the resolve walk happens IN THE WORKER (`backfill_label_images`, agent tier) and this driver only paces it — the `fluncle-crawl`/`fluncle-backfill` shape, verbatim. The Worker carries the durable per-label reliability state (`image_state` / `image_attempted_at` / `image_failures`), the ~1 req/s MusicBrainz gate, the authed Discogs gate, and the rate-limit circuit breaker.

That split makes the **cadence, not the batch size, the real throttle.** Every scrap of state is on the `labels` row, so "run again" and "resume" are the same command: a `resolved`/`none` label is terminal and skipped forever; a transient failure backs off on a cooldown; a persistent one gives up (→ `none`) so it is never retried forever. A reboot mid-worklist costs nothing.

- `FLUNCLE_LABEL_IMAGES_LIMIT` (default `6`) — labels handled per tick. The CLI loops the slug cursor internally up to this cap (or until the worklist drains, or a vendor throttles); each label is a few paced ~1.1s Worker calls, so a tick is under a minute.

At 6 labels every 60 minutes — against a crawl that mints only tens of new labels a day — the worklist stays drained with wide headroom, and a tick that finds every label resolved/none is a cheap no-op.

Check on it any time:

```bash
fluncle admin backfills label-images --dry-run   # the eligible worklist; writes nothing
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-label-images`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `backfill_label_images` is AGENT tier, so the box's existing agent-scoped token drives it.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/label-images-timer/fluncle-label-images.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/label-images-timer/fluncle-label-images.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-label-images.timer

# Verify one tick now.
sudo systemctl start fluncle-label-images.service            # one tick
journalctl -u fluncle-label-images.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-label-images.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.label-images` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `CRON_SPECS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
