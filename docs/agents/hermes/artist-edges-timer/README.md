# fluncle-artist-edges-timer — the track_artists graph backfill on a host timer

The rave-02 host trigger for the `--no-agent` **track_artists graph-backfill** sweep (RFC artist-primary-capture, slice 0). `fluncle-artist-edges` folds each edge-less track's `artists_json` NAMES onto EXISTING `artists` identities — so the `track ↔ artist` graph is as full as honest matching can make it, which is what the capture-authorization slice reads.

**Why it exists.** The graph is crawl-era-only (born 2026-07-15): only ~12.3k of ~37.5k tracks carry `track_artists` edges. Older rows carry artist names in `artists_json` but no identity link, so an artist Fluncle has certified is invisible to any identity-keyed read of its own back-catalogue. Slice 1's capture authorization — a track's audio may be bought iff a CREDITED ARTIST is qualified — matches BY IDENTITY through this graph, so slice 0 is the prerequisite.

**The matcher is identity-honest.** For each track lacking edges, each credited name is matched to an EXISTING `artists` row — first by exact case-insensitive **fold** (the codebase's `fold`: lowercased, accent-folded, `&`→`and`, punctuation collapsed), then via `artist_aliases` (`kind='name'`, `status in ('auto','confirmed')` — the search resolver's alias semantics). It **mints nothing**: an `artists` row is an entity with a public page, and a bare name string is not enough identity to create one. A fold that two distinct identities share is ambiguous and matches nothing (fail-closed). A name that matches no identity is the **unmatched residual**, reported honestly — it decides whether a later paced MusicBrainz credit-sweep is worth running.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/artist-edges-sweep.sh`](../scripts/artist-edges-sweep.sh) → [`../scripts/artist-edges-sweep.ts`](../scripts/artist-edges-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: Worker-paced, and the schedule is the loop

The fill happens IN THE WORKER (`backfill_artist_edges`, agent tier) and this driver only paces it — the `fluncle-recording-mbids` shape, verbatim. It makes **no vendor call** (pure DB matching), so there is no rate limit and no circuit breaker; the only durable state is the per-row `tracks.artist_edges_backfilled_at` stamp the Worker writes on EVERY visited track (matched, partial, or zero-match), so the worklist drains to empty and a re-run is a cheap no-op. A reboot mid-worklist costs nothing.

- `FLUNCLE_ARTIST_EDGES_LIMIT` (default `200`) — tracks visited per tick. The default is pinned to the Worker's `MAX_BATCH` (200), so the CLI's internal cursor loop meets its cap on a full first page and fires **exactly one HTTP request per tick**. A larger value just loops the cursor a few more times.

Check on it any time:

```bash
fluncle admin backfills artist-edges --dry-run   # classify the worklist; writes nothing
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-artist-edges`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `backfill_artist_edges` is AGENT tier, so the box's existing agent-scoped token drives it.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/artist-edges-timer/fluncle-artist-edges.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/artist-edges-timer/fluncle-artist-edges.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-artist-edges.timer

# Verify one tick now.
sudo systemctl start fluncle-artist-edges.service            # one tick
journalctl -u fluncle-artist-edges.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-artist-edges.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.artist-edges` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `AUTOMATION_CRONS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
