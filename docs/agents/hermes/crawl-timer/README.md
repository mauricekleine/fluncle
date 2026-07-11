# fluncle-crawl-timer — the catalogue crawler on a host timer

The rave-02 host trigger for the `--no-agent` **catalogue crawl** sweep. `fluncle-crawl` advances Fluncle's catalogue by ONE bounded pass per tick: it walks the MusicBrainz release graph outward from the labels the operator ENABLED and writes uncertified catalogue rows into `tracks`.

It **certifies nothing** — a crawled track is a `tracks` row with no `findings` row, so it has no Log ID, no note, no video, no galaxy, and no place on `/log`, the feeds, the sitemap or the Galaxy game. It **captures no audio** (the row lands with `capture_status` at its DDL default, and the capture queue's `findings.log_id is not null` predicate structurally cannot reach it). **Zero LLM tokens** — a pure trigger. The full design is [docs/catalogue-crawler.md](../../../catalogue-crawler.md).

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/crawl-sweep.sh`](../scripts/crawl-sweep.sh) → [`../scripts/crawl-sweep.ts`](../scripts/crawl-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: Worker-paced, and the schedule is the loop

The box holds no MusicBrainz budget and no vendor identity; the Worker does. So the walk happens IN THE WORKER (`crawl_catalogue`, agent tier) and this driver only paces it — the `fluncle-backfill` shape, verbatim. The Worker carries the durable frontier (`crawl_frontier`), the ~1 req/s MusicBrainz gate, the `Retry-After` backoff and the circuit breaker.

That split is what makes the cadence, not the batch size, the real throttle. **A catalogue crawl is a marathon the SCHEDULE finishes, not the process.** Every scrap of state is in the database, so "run again" and "resume" are the same command: a box reboot mid-label costs one node, not one crawl.

- `FLUNCLE_CRAWL_NODES` (default `10`) — frontier nodes per tick. ~1 paced MB request each, so a tick is ~12s.
- `FLUNCLE_CRAWL_MAX_HOP` (default `2`) — the ratified boundary gate: hop 0 = a release on an enabled seed label, hop 1 = an artist on it, hop 2 = a release that artist also appears on, then STOP.

At 10 nodes every 10 minutes that is ~1,400 nodes/day — the neighbourhood of a seed label in a day or two, politely, with the vendor's rate budget never strained. A tick that finds the frontier drained is a cheap no-op.

## The operator's steering wheel

The crawl only ever seeds from labels whose `seed_state` is `enabled`. A label the walk DISCOVERS that nobody has ruled on enters as `undecided` and surfaces in the `/admin` attention queue — it is **not** crawled until the operator enables it. So the crawl widens only where he lets it, and the whole controls surface is one keystroke per label at `/admin/labels`. Ruling on a label stays OPERATOR tier (`update_label`); the crawl itself is agent tier.

Check on it any time:

```bash
fluncle admin catalogue status
fluncle admin catalogue crawl --dry-run   # the seed plan; writes nothing
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-crawl`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `crawl_catalogue` is AGENT tier, so the box's existing agent-scoped token drives it.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/crawl-timer/fluncle-crawl.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/crawl-timer/fluncle-crawl.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-crawl.timer

# Verify one tick now.
sudo systemctl start fluncle-crawl.service            # one tick
journalctl -u fluncle-crawl.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-crawl.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**Before the first tick, rule on the seed set.** `fluncle admin catalogue crawl --dry-run` prints how many labels are enabled. Whatever is enabled when the timer starts is the neighbourhood it will walk.

**It is already on /status.** `cron.crawl` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `CRON_SPECS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.

**Enable `fluncle-rank` alongside it.** The Ear's ranking sweep ([../rank-timer/README.md](../rank-timer/README.md)) is what turns the rows this crawl brings back into `/admin/catalogue`. It shipped without a schedule on purpose — a timer ranking an empty table means nothing — and this crawler is what gives it something to rank. The two are one loop.
