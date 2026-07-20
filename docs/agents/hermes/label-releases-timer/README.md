# fluncle-label-releases-timer — the freshness tap on a host timer

The rave-02 host trigger for the `--no-agent` **freshness tap** sweep (D8). `fluncle-label-releases` searches Spotify for the **fresh releases** of the labels the operator ENABLED and mints uncertified catalogue rows into `tracks` with their **day-one release dates**.

## Why it exists: the ~2-week MusicBrainz lag

The catalogue crawler ([../crawl-timer/README.md](../crawl-timer/README.md)) WALKS the graph off MusicBrainz — the complete, recording-centric spine. But MusicBrainz's editorial database lags a release by ~2 weeks (a volunteer has to enter it), so a Friday drop is invisible on `/fresh` until then. Spotify has it on day one. So the doctrine amendment (operator-ratified 2026-07-19): **MusicBrainz walks the graph; Spotify taps freshness.** This probe closes the lag cliff.

**Why Spotify, not Apple.** The first cut used Apple Music's `record-labels` catalog. Live probes measured its seed-label coverage at **2/99** (only Hospital + one other; RAM, Shogun, Viper, Critical, UKF all absent) — a measured dead end. Spotify carries every seed label's fresh releases, and we already hold its OAuth (the publish path), so the tap reuses the existing Spotify client — **no new secret**.

It **certifies nothing** — a tapped track is a `tracks` row with no `findings` row, so it has no Log ID, no note, no video, no galaxy, and no place on `/log`, the feeds, the sitemap or the Galaxy game. It **captures no audio** (the row lands with `capture_status` at its DDL default). It **never widens the graph** — it mints tracks/albums for the PROBED seed label and nothing else (no new labels, no artist hops). **Zero LLM tokens** — a pure trigger. The full design is [label-releases.ts](../../../../apps/web/src/lib/server/label-releases.ts) + [docs/catalogue-crawler.md](../../../catalogue-crawler.md).

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/label-releases-sweep.sh`](../scripts/label-releases-sweep.sh) → [`../scripts/label-releases-sweep.ts`](../scripts/label-releases-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: Worker-paced, and the schedule is the loop

The box holds no Spotify identity; the Worker does (the publish path's OAuth). So the probe happens IN THE WORKER (`backfill_label_releases`, agent tier) and this driver only paces it — the `fluncle-cover-masters` shape, verbatim. The Worker carries the durable per-label state (`label_releases_checked_at` / `label_releases_attempted_at` / `label_releases_failures`) and rides the Spotify client's 429 Retry-After backoff.

That split is what makes the cadence, not the batch size, the real throttle. Every scrap of state is in the database, so "run again" and "resume" are the same command: a box reboot mid-probe costs one label's re-tap, not a re-mint (the dedupe skips rows already minted, from both directions — Spotify id/uri/ISRC and same-album title fold).

- `FLUNCLE_LABEL_RELEASES_LABELS` (default `5`) — enabled seed labels the CLI probes per pass. The CLI loops passes until every enabled label is fresh this window (or Spotify throttles). The dedupe contract makes a re-tap of an already-tapped release a cheap skip.

## The fuzzy search + the copyrights post-filter

`GET /search?type=album&q=label:"<name>" tag:new` finds a label's last-two-weeks releases with day-one dates — but its `label:` filter is FUZZY for generic names (`label:"RAM Records"` returned 93 junk albums live; `label:"Hospital Records"` returned exactly its 2 real ones), and our Spotify tier has NO `label` field on the album object at all. So the mandatory post-filter is the album's **`copyrights`** array: an album is kept only when the seed label's name FOLD-matches one of its ℗/© strings. No copyright match ⇒ skip (never mint on the fuzzy hit alone). Each kept album's tracks are then fetched individually for their `external_ids.isrc` + duration.

## The operator's steering wheel

The tap only ever probes labels whose `seed_state` is `enabled` — the SAME allowlist the crawl seeds from, never widened. A disabled/undecided label is never probed. Enabling a label stays OPERATOR tier (`update_label`); the tap itself is agent tier.

Check on it any time:

```bash
fluncle admin backfills label-releases --dry-run   # the labels it would probe; writes nothing
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-label-releases`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `backfill_label_releases` is AGENT tier, so the box's existing agent-scoped token drives it, and the tap reuses the publish path's Spotify OAuth (already on the Worker). The moment Spotify is connected (it already is, for publishing), the tap is live — there is no separate secret to provision.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/label-releases-timer/fluncle-label-releases.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/label-releases-timer/fluncle-label-releases.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-label-releases.timer

# Verify one tick now.
sudo systemctl start fluncle-label-releases.service            # one tick
journalctl -u fluncle-label-releases.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-label-releases.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.label-releases` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's cron array, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
