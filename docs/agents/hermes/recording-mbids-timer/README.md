# fluncle-recording-mbids-timer — the recording-MBID filler on a host timer

The rave-02 host trigger for the `--no-agent` **recording-MBID fill** sweep — the MusicBrainz identity layer. `fluncle-recording-mbids` gives every track its canonical **MusicBrainz recording MBID**, the one identifier that reconciles a track to the wider open music graph (MusicBrainz, Wikidata) and the anchor the `/log` MusicRecording emits as a `sameAs` + a KG `identifier`. The full design is [docs/catalogue-crawler.md](../../../catalogue-crawler.md#the-musicbrainz-identity-layer-recording-mbids).

**The two fill paths.** A crawler-born row already carries the MBID in its PK (`track_id` is `mb_<recording-mbid>`), so the sweep's first act each tick is a FREE SQL strip of that prefix into `mb_recording_id` — no vendor call. Then the findings/Spotify-born tail (a `track_id` that is a Spotify id) is resolved by ISRC through the shared MusicBrainz client (`/isrc/<isrc>` → its recording). New crawler rows already stamp the column at mint time, so this cron catches history up and drains the ISRC tail.

**Why it must be durable, not a one-shot.** The catalogue crawl (`fluncle-crawl`) mints rows continuously, and a finding published via a Spotify add lands with an ISRC but no MBID. This cron closes the loop: it fills the identity so a certified finding is graph-joinable the moment it exists. It **certifies nothing** and **publishes nothing** — an MBID is internal, reversible metadata identity (agent tier, the `backfill_label_images` precedent). **Zero LLM tokens** — a pure trigger.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/recording-mbids-sweep.sh`](../scripts/recording-mbids-sweep.sh) → [`../scripts/recording-mbids-sweep.ts`](../scripts/recording-mbids-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: Worker-paced, and the schedule is the loop

The box holds no MusicBrainz budget; the Worker does. So the fill happens IN THE WORKER (`backfill_recording_mbids`, agent tier) and this driver only paces it — the `fluncle-crawl`/`fluncle-backfill` shape, verbatim. The Worker carries the durable per-row reliability state (`mb_recording_id` + the `mb_recording_id_attempted_at` stamp), the ~1 req/s MusicBrainz gate, and the rate-limit circuit breaker.

That split makes the **cadence, not the batch size, the real throttle.** Every scrap of state is on the `tracks` row, so "run again" and "resume" are the same command: a filled row is terminal and skipped forever; a clean MusicBrainz no-match is attempt-stamped so it drains and is not re-queried forever; a throttle just circuit-breaks and the next tick resumes fresh. A reboot mid-worklist costs nothing.

- `FLUNCLE_RECORDING_MBIDS_LIMIT` (default `25`) — ISRC lookups handled per tick. The CLI loops the track-id cursor internally up to this cap (or until the worklist drains, or MusicBrainz throttles); each lookup is a paced ~1.1s Worker call, so a tick is under a minute. The free PK strip is bounded separately (500 rows/pass) and drains crawler history in a few ticks.

At 25 ISRCs every 60 minutes — against a small findings/Spotify-born tail — the worklist stays drained with wide headroom, and a tick that finds every track filled/attempted is a cheap no-op.

Check on it any time:

```bash
fluncle admin backfills recording-mbids --dry-run   # both worklists; writes nothing
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-recording-mbids`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `backfill_recording_mbids` is AGENT tier, so the box's existing agent-scoped token drives it.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/recording-mbids-timer/fluncle-recording-mbids.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/recording-mbids-timer/fluncle-recording-mbids.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-recording-mbids.timer

# Verify one tick now.
sudo systemctl start fluncle-recording-mbids.service            # one tick
journalctl -u fluncle-recording-mbids.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-recording-mbids.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.recording-mbids` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `CRON_SPECS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
