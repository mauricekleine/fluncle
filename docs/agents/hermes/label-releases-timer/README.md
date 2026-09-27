# fluncle-label-releases-timer — the freshness tap on a host timer

The rave-02 host trigger for the `--no-agent` **freshness tap** sweep (D8). `fluncle-label-releases` finds the **fresh releases** of the labels the operator ENABLED — on the official Spotify API, in the Worker — and mints uncertified catalogue rows into `tracks` with their **day-one release dates**.

## Why it exists: the ~2-week MusicBrainz lag

The catalogue crawler ([../crawl-timer/README.md](../crawl-timer/README.md)) WALKS the graph off MusicBrainz — the complete, recording-centric spine. But MusicBrainz's editorial database lags a release by ~2 weeks (a volunteer has to enter it), so a Friday drop is invisible on `/fresh` until then. Spotify has it on day one. So the doctrine amendment (operator-ratified 2026-07-19): **MusicBrainz walks the graph; Spotify taps freshness.** This probe closes the lag cliff.

It **certifies nothing** — a tapped track is a `tracks` row with no `findings` row, so it has no Log ID, no note, no video, no galaxy, and no place on `/log`, the feeds, the sitemap or the Galaxy game. It **captures no audio** (the row lands with `capture_status` at its DDL default). It **never widens the graph** — it mints tracks/albums for the PROBED seed label and nothing else (no new labels, no artist hops). **Zero LLM tokens** — a pure trigger. The full design is [label-releases.ts](../../../../apps/web/src/lib/server/label-releases.ts) + [docs/catalogue-crawler.md](../../../catalogue-crawler.md).

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/label-releases-sweep.sh`](../scripts/label-releases-sweep.sh) → [`../scripts/label-releases-sweep.ts`](../scripts/label-releases-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

The timer fires every 15 minutes from 03:00 through 08:45 UTC, with per-firing jitter. Each firing makes bounded passes through database admission; a Spotify daily quota response closes the tap until the next 03:00 UTC window, while a transient 429 honors `Retry-After` and moves to another due label. Before every pass, the tap reads the latest anchor sweep cron marker and yields with `anchor_priority` unless a successful tick in the current UTC hour reports `spotifyIsrcDue: 0`. The anchor skips the probe when the tick found an empty queue or no ISRC ask slots remain; otherwise one bounded, indexed worklist read asks whether any due ISRC row has never been asked. `spotifyIsrcDue` is 0 or 1, an existence signal, so a nonempty general anchor queue can still leave zero ISRC asks due. A failed probe records `spotifyIsrcDueError`, leaves the due signal `null`, and keeps the tap closed; previous-hour, failed, and admission-skipped markers do not open it. This multi-firing timer deliberately does not use the daily-retry runner: a successful partial firing must never suppress the remaining window. `Persistent=false` prevents a missed window from catching up during the quota-closed day. The host failure notifier still catches service failures.

## The model: a thin trigger, a Worker that does the work

The BOX is a TRIGGER and nothing more. It POSTs bounded passes of `backfill_label_releases` with its agent token until the due seed labels are drained; the **Worker** does the whole job — the official-Spotify fresh-release search, the single album/track reads, the gate, the dedupe, the mint. The box holds no Spotify identity and no vendor token on this path.

It calls the oRPC endpoint over **HTTP directly**, never `fluncle admin backfills label-releases`: the baked CLI is a PINNED release, and a pin that predates a flag fails the run outright (`Unknown option '--limit'`, seen live). HTTP has no such version coupling.

### The round trip through Apify, and back (2026-07-20)

For half a day this sweep ran the Apify actor `musicae~spotify-extended-scraper` itself and POSTed candidate albums for the Worker to verify — to keep the tap off the official app's small shared budget. That is **reverted**, because the actor's ALBUM mode broke Spotify-side the same day: an album search, an album-by-id, and even a famous-album query all returned `result:"0/N", albums:[]` while its TRACK mode kept working and the actor's own code was untouched (last modified 10 days prior) — the signature of a rotated GraphQL persisted-query hash, which only the actor's maintainer can re-fix. The alternatives were measured dead too: `apiharvest`'s actors 403 behind their residential proxy (2026-07-18), and the working TRACK mode cannot substitute — `label:"X" tag:new` returns nothing there (`tag:new` is ALBUM-only) and track results carry no `release_date`, the one field this tap exists for.

The official API's album search is a documented endpoint rather than a scraped GraphQL op, it is stable, and it supports `label:"X" tag:new` (verified live). So the tap came home — and the budget problem that drove it away is solved properly now, by the shared call meter rather than by a second vendor.

**The catalogue ANCHOR sweep still uses the actor** ([../anchor-timer/README.md](../anchor-timer/README.md)) — its TRACK mode works — and is untouched by any of this.

### The budget: user write paths get the window, the tap takes only slack

The tap is back on the same per-app Spotify budget as the user-facing paths (a new crew member's playlist mint, the Frontier refresh, publish), so it is paced rather than trusted. Every call the Worker makes is recorded into the shared call meter (`apps/web/src/lib/server/spotify-budget.ts`), and before each label — and each batch of single reads — the tap checks that the window is below **its own ceiling, a fraction of the meter's max**. It stops while there is still real headroom, so a mint arriving a moment later finds room; it never spends the last of the window.

Hitting that ceiling is not an error. The pass reports `budgetPaused` and ends cleanly; each label's album and track cursor is durable in `label_releases_progress_json`, so the next pass resumes at the unfinished item. A completed label clears that cursor and stamps `label_releases_checked_at`. The sweep stands down one meter window (~30s) and asks again, bounded by a pause fuse and a 12-minute firing wall budget so a permanently-busy app ends the firing instead of spinning. A throttled label remains unchecked and rotates behind other never-checked labels; checked labels become due again after 20 hours. The Worker also enforces the operator setting `spotify_label_releases_daily_budget`, default 500 Spotify calls per UTC day, across tap firings. Its `spotify_budget_spent` response ends the firing without another wait; the daily call count includes search, album, and track reads.

**The scaling ceiling to watch:** this is comfortable at today's volume (~1 search per label per day plus a trickle of single reads). If the crew grows enough that mints regularly find the window spent, the fix is to measure the app's real sustainable rate and raise `SPOTIFY_CALL_WINDOW_MAX`, not to loosen the tap's ceiling.

That pacing is what makes the cadence, not the batch size, the real throttle. The Worker persists the album list and its album/track cursor with each label, so "run again" and "resume" follow the same path after a box reboot or a spent call window. The dedupe also skips rows already minted from either direction — Spotify id/uri/ISRC and same-album title fold.

- `FLUNCLE_LABEL_RELEASES_LABELS` (default `5`) — enabled seed labels asked for per PASS; `--limit N` overrides it for an attended burn. `FLUNCLE_LABEL_RELEASES_MAX_PASSES` (default `40`) — the tick's pass fuse. `FLUNCLE_LABEL_RELEASES_BUDGET_WAIT_MS` (default `30000`) / `FLUNCLE_LABEL_RELEASES_MAX_BUDGET_WAITS` (default `12`) — the budget stand-down and its fuse. The 12-minute wall bound includes a reserve for one 120-second Worker request, leaving room inside the service's 910-second timeout and the 15-minute timer cadence.

## The gate: artist-grounding AND an exact copyright match (both mandatory)

`label:"<name>" tag:new` forwards Spotify's freshness filter — but that filter is FUZZY for generic names (`label:"RAM Records"` returned 93 junk albums live; `label:"Hospital Records"` returned exactly its 2 real ones). So an album mints ONLY when:

1. **artist-grounding** (the PRIMARY anchor, always required) — at least one of the album's Spotify artist ids (`artists[].id`) is already in `artists.spotify_artist_id`. This killed 100% of the cross-genre junk the first live drain minted (an Indian devotional record, Brazilian live albums — every one by an artist we had never certified); AND
2. **an exact copyright match** (the SECONDARY attribution confirmation) — the ℗/© string's label portion (dropping the symbol + year) fold-**equals** the seed name. Not a substring: a loose `includes` caught homonym labels worldwide for generic seed names ("Lens" matched "℗ 2026 Silent Lens"). Our tier's album object carries **no `label` field at all**, so the copyright is the attribution signal available.

And an album with **no `release_date` is dropped outright**, before either signal: `/fresh` selects on `release_date`, so a null-dated row would be permanently invisible there — all of the pollution, none of the freshness this tap exists for.

The tradeoff is deliberate: a brand-new artist's debut is skipped until the MB tail-first re-arm backfills them. Correctness over completeness for a public surface.

## The operator's steering wheel

The tap only ever probes labels whose `seed_state` is `enabled` — the SAME allowlist the crawl seeds from, never widened. A disabled/undecided label is never in the worklist, and the mint op re-checks the seed state (a label disabled mid-flight is a no-op). Enabling a label stays OPERATOR tier (`update_label`); the tap itself is agent tier.

Run one tick by hand any time (the anchor-sweep way — there is no `fluncle` CLI command for the tap):

```bash
sudo systemctl start fluncle-label-releases.service            # one tick
journalctl -u fluncle-label-releases.service -n 40 --no-pager  # expect a { "ok": true, … } summary
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-label-releases`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret, and one fewer than before**: `backfill_label_releases` is AGENT tier, so the box's existing agent-scoped token in `~/.fluncle-secrets.env` drives it, and that is the ONLY secret this sweep needs. The tap's Spotify calls happen in the Worker on the publish path's OAuth grant, so there is no vendor token on the box for this path at all.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-label-releases.service --refresh-unit fluncle-label-releases.timer
sudo systemctl restart fluncle-label-releases.timer

# Verify one tick now.
sudo systemctl start fluncle-label-releases.service            # one tick
journalctl -u fluncle-label-releases.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-label-releases.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.label-releases` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober. The sweep atomically accumulates each UTC day's probes and demand in `cron/output/fluncle-label-releases/daily/YYYY-MM-DD.json`, outside the 20-marker retention set. After the free window, health reads that file and expects `min(labelsDue, floor(tapDailyBudget / 10))` completed labels, using ten calls per probe as a conservative capacity estimate. A day stopped by `spotify_quota` or `spotify_budget_spent`, or a day whose firings were all held by `anchor_priority`, is exempt from that floor; a failed latest firing still reports failed. The daily file counts non-priority firings so one early anchor pause cannot hide later shortfall. The sweep also emits `labelsDue`, `neverChecked`, `quotaExceeded`, `tapDailyBudget`, `tapDailyCallsSpent`, and `blockedReason` in the run ledger.
