# fluncle-apple-releases-timer — the MusicKit freshness tap on a host timer

The rave-02 host trigger for the `--no-agent` **MusicKit freshness tap** sweep (D8). `fluncle-apple-releases` taps Apple Music's **latest releases** for the labels the operator ENABLED and mints uncertified catalogue rows into `tracks` with their **day-one release dates**.

## Why it exists: the ~2-week MusicBrainz lag

The catalogue crawler ([../crawl-timer/README.md](../crawl-timer/README.md)) WALKS the graph off MusicBrainz — the complete, recording-centric spine. But MusicBrainz's editorial database lags a release by ~2 weeks (a volunteer has to enter it), so a Friday drop is invisible on `/fresh` until then. Apple Music has it on day one. So the doctrine amendment (operator-ratified 2026-07-19): **MusicBrainz walks the graph; Apple taps freshness.** This probe closes the lag cliff.

It **certifies nothing** — an Apple-tapped track is a `tracks` row with no `findings` row, so it has no Log ID, no note, no video, no galaxy, and no place on `/log`, the feeds, the sitemap or the Galaxy game. It **captures no audio** (the row lands with `capture_status` at its DDL default). It **never widens the graph** — it mints tracks/albums for the PROBED seed label and nothing else (no new labels, no artist hops). **Zero LLM tokens** — a pure trigger. The full design is [apple-releases.ts](../../../../apps/web/src/lib/server/apple-releases.ts) + [docs/catalogue-crawler.md](../../../catalogue-crawler.md).

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/apple-releases-sweep.sh`](../scripts/apple-releases-sweep.sh) → [`../scripts/apple-releases-sweep.ts`](../scripts/apple-releases-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: Worker-paced, and the schedule is the loop

The box holds no Apple identity; the Worker does (the three `APPLE_MUSIC_*` secrets live on the Worker only). So the probe happens IN THE WORKER (`backfill_apple_releases`, agent tier) and this driver only paces it — the `fluncle-cover-masters` shape, verbatim. The Worker carries the durable per-label state (`apple_label_state` / `apple_label_id` / `apple_label_attempted_at` / `apple_label_failures` / `apple_releases_checked_at`), the shared 18/min Apple call meter, and the cross-cutting breaker.

That split is what makes the cadence, not the batch size, the real throttle. Every scrap of state is in the database, so "run again" and "resume" are the same command: a box reboot mid-probe costs one label's re-tap, not a re-mint (the dedupe skips rows already minted, from both directions — ISRC and same-album title fold).

- `FLUNCLE_APPLE_RELEASES_LABELS` (default `5`) — enabled seed labels the CLI probes per pass. The CLI loops passes until every enabled label is fresh this window (or the shared Apple budget is spent). The dedupe contract makes a re-tap of an already-tapped release a cheap skip.

## The operator's steering wheel

The tap only ever probes labels whose `seed_state` is `enabled` — the SAME allowlist the crawl seeds from, never widened. A disabled/undecided label is never probed. Each label resolves its Apple `record-labels` id ONCE, accepting only an EXACT name-fold match against the seed label's own name — an ambiguous or no-match label is left null (never guessed) and re-tried on a backoff, then given up. Enabling a label stays OPERATOR tier (`update_label`); the tap itself is agent tier.

Check on it any time:

```bash
fluncle admin backfills apple-releases --dry-run   # the labels it would probe; writes nothing
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-apple-releases`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `backfill_apple_releases` is AGENT tier, so the box's existing agent-scoped token drives it, and the three `APPLE_MUSIC_*` secrets already live on the Worker.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/apple-releases-timer/fluncle-apple-releases.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/apple-releases-timer/fluncle-apple-releases.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-apple-releases.timer

# Verify one tick now.
sudo systemctl start fluncle-apple-releases.service            # one tick
journalctl -u fluncle-apple-releases.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-apple-releases.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.apple-releases` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's cron array, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
