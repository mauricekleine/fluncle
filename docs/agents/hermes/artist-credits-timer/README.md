# fluncle-artist-credits-timer — the MB credit sweep on a host timer

The rave-02 host trigger for the `--no-agent` **MB credit sweep** (RFC artist-primary-capture, slice 1b). `fluncle-artist-credits` completes the artist graph for slice 0's zero-matched residual — the tracks the name-fold backfill (`fluncle-artist-edges`) could not identify — by minting **identity-true** artists from MusicBrainz credits.

**Why it exists.** Slice 0 folded each edge-less track's `artists_json` NAMES onto EXISTING `artists` rows, but it **mints nothing** (a bare name is not enough identity to create an entity), so a track whose credited names matched no existing identity got the reliability stamp but no edge — the ~14.3k **zero-matched residual**. Those are exactly the tracks capture-authorization (slice 1) cannot reason about, because it matches BY IDENTITY through the `track_artists` graph. This sweep closes that gap.

**How it identifies where slice 0 couldn't.** For each zero-matched track carrying a **MusicBrainz recording identity** — `tracks.mb_recording_id`, or the `mb_<recording-mbid>` PK a crawler-born row carries (both checked) — one paced `/recording/<mbid>?inc=artist-credits` lookup through the shared MusicBrainz client names its credited artists WITH their real **MB artist ids**. Each resolves down a three-rung ladder: (1) an **exact `mbid`** match on an existing row; (2) an **ADOPT** — the credit name folds unambiguously onto an existing artist that has no mbid yet, so the mbid is `coalesce`d onto that row rather than minting a duplicate (the common case, because the residual is dominated by compound credit strings like "Sub Focus & Dimension" whose members already exist as Spotify-keyed rows — this rung is what stops the sweep spawning split-identity duplicates); (3) a **MINT** of a fresh identity-true row via `mintArtistByMbid` — the licence slice 0 lacked, because an MB artist id IS identity (a curated, dereferenceable MBID), where a bare name is not. It fails closed at every ambiguity (a fold two rows share, or a fold whose row carries a _different_ mbid) → mint, never a wrong merge. Then the `track_artists` edges are written (position from credit order, `role` null). A zero-matched track with **no** MB identity is **terminally skipped** — stamped so it drains, never retried (there is no key to resolve it by).

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/artist-credits-sweep.sh`](../scripts/artist-credits-sweep.sh) → [`../scripts/artist-credits-sweep.ts`](../scripts/artist-credits-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: Worker-paced, and the schedule is the loop

The fill happens IN THE WORKER (`backfill_artist_credits`, agent tier) and this driver only paces it — the `fluncle-recording-mbids` shape, verbatim. Unlike slice 0 (pure DB matching), it **makes vendor calls**, so it carries the vendor protections the Worker owns: **1 req/s** pacing, a **circuit breaker** that stops the pass on a MusicBrainz throttle without stamping the throttled row, and a **60s response budget** that pauses mid-page under cross-sweep contention (the CLI then issues one more request with a fresh budget). The only durable state is the per-row `tracks.artist_credits_backfilled_at` stamp — its OWN stamp, **distinct** from slice 0's `artist_edges_backfilled_at`, which this sweep never writes or re-nulls. A reboot mid-worklist costs nothing.

- `FLUNCLE_ARTIST_CREDITS_LIMIT` (default `40`) — worklist rows visited per tick. The default is pinned to the Worker's `MAX_BATCH` (40 — each row is one paced MB call), so the CLI's internal cursor loop meets its cap on a full first page and fires **one HTTP request per tick**.

Check on it any time:

```bash
fluncle admin backfills artist-credits --dry-run   # report the eligible worklist; writes nothing
```

## Why every 5m (not 60m like slice 0)

Slice 0 makes no vendor call and drains its history in a handful of generous (200-row) ticks, so an hourly cadence suffices. This sweep is throttled to one MusicBrainz call per row, so a batch is small (40) — a 5-minute cadence drains the ~14.3k residual at ~40/tick over ~a day and a half without ever storming MusicBrainz (the 1-req/s pacing and the circuit breaker are the real backstops; the cadence only sets the drain rate). The `OnBootSec=4min` stagger sits on mod-5 residue 4, clear of the other 5-minute sweeps (enrich=1, context-note=2, capture/embed=3).

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-artist-credits`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `backfill_artist_credits` is AGENT tier, so the box's existing agent-scoped token drives it. Slice 0 (`fluncle-artist-edges`) should have drained first — this sweep reads its zero-matched residual, so run it only once slice 0 has caught history up.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/artist-credits-timer/fluncle-artist-credits.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/artist-credits-timer/fluncle-artist-credits.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-artist-credits.timer

# Verify one tick now.
sudo systemctl start fluncle-artist-credits.service            # one tick
journalctl -u fluncle-artist-credits.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-artist-credits.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.artist-credits` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `AUTOMATION_CRONS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
