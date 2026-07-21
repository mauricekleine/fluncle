# fluncle-anchor-timer — the catalogue Spotify-anchor sweep on a host timer

The rave-02 host trigger for the `--no-agent` **catalogue Spotify-anchor** sweep. `fluncle-anchor` fills the `spotify_uri`/`spotify_url` anchor on uncertified catalogue rows — a `tracks` row with no `findings` row, resolved from MusicBrainz, that may have landed with no Spotify presence. An anchored row can be recommended, minted into a playlist, and (once the operator certifies it) published.

The full design is [docs/catalogue-crawler.md](../../../catalogue-crawler.md) § the anchor. The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/anchor-sweep.sh`](../scripts/anchor-sweep.sh) → [`../scripts/anchor-sweep.ts`](../scripts/anchor-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## Why the sweep exists: Spotify's official app can't carry this

Filling the anchor used to run **in the Worker** against the official (dev-mode) Spotify app. That app has a tiny permanent budget, and at catalogue scale it **starved under sustained 429s** — while it is also the app the user-facing paths need (adds, publish, the Frontier playlist mints). So all catalogue anchor-filling moved **off** the official app onto **this box sweep**, driven by an **Apify** Spotify-scraper actor that has its own Spotify budget. The official app now serves only user-facing paths.

## The model: box fetches candidates, the Worker rules

The box holds no verification authority — it only fetches candidates, and even that only for the paid last resort. Per tick it runs the resolver waterfall (docs/catalogue-crawler.md § the anchor):

1. **Fetch** the anchor worklist from the Worker with the box's AGENT token (`GET /api/admin/tracks/work?kind=anchor`). Each row carries a ready-made `anchorQuery` (its artists + title), so the driver never builds the query.
2. **`resolve_anchor` FIRST, per row** (agent tier — the box POSTs just the `trackId`). The Worker resolves the row from the FREE ListenBrainz rung (recording MBID → Spotify ids → one by-id read) and, **only when the dark flag `anchor_spotify_search_enabled` is on** (default OFF) and outside the Friday-refresh window, from the free Spotify SEARCH rungs (exact ISRC, then fuzzy). A hit here spends **no Apify money**. The response carries `source` (which rung anchored) and `spotifySearchDone` (whether a Spotify search ran — the sweep's pacer signal).
3. **Apify only on a `resolve_anchor` miss.** For the rows that missed every free rung, **run** the Apify actor (`run-sync-get-dataset-items`, `searchKeywordLimit: 3`), **group** its flat results by `target` (the query), and **POST** each row's candidates to `anchor_track` (agent tier).

**The Worker re-runs the full verification on every rung** — exact ISRC first (case-insensitive), else the folded artist + title + ±2s-duration search triple — and writes the anchor on a hit. **No source's match is ever trusted** (ListenBrainz, the Spotify search, or Apify).

**The 60/min Spotify-search ceiling.** The dark Spotify search rungs share the ONE official app that also serves user-facing mints/publish, so the sweep paces them: `resolve_anchor` does ≤2 searches per row, and the box holds consecutive search-bearing calls ≥2s apart (`SPOTIFY_SEARCH_MIN_INTERVAL_MS`) → ≤60 searches/min. The Worker's Friday-window skip + the existing 429/Retry-After backoff are the other two guards, so a Friday mint always has headroom. A flag-OFF sweep never searches and never paces (it runs at slice-1 speed).

Every attempt stamps `spotify_anchor_attempted_at`, a **14-day re-ask backoff** (`ANCHOR_REASK_AFTER_DAYS`): "not on Spotify today" is not "never on Spotify", so a missed row is re-asked — but not re-billed for two weeks. The worklist is DERIVED (`spotify_uri is null`), so a stopped tick loses nothing and "run again" is "resume".

**It calls the oRPC HTTP endpoints directly** (the `verify-captures.ts` precedent), never a `fluncle admin …` subcommand — the box's baked CLI is a PINNED release and must not gain a new dependency.

- `FLUNCLE_ANCHOR_BATCH` (default `15`) — rows per tick.
- `--limit N` — an attended backlog burn (overrides the batch for one run); rows are still chunked into Apify runs of `FLUNCLE_ANCHOR_APIFY_CHUNK` (default 15).

## The cost, and how to control it

Each result item is ~**$0.005**, and at `searchKeywordLimit: 3` a row is ~3 items → ~**$0.015/row**.

- **Default pace:** 15 rows/hour ≈ **360 rows/day** ≈ **$5-6/day** while the backlog drains. Once the backlog is anchored, most ticks are cheap no-ops (a drained worklist) plus the trickle of newly-crawled rows crossing the re-ask window.
- **The dark Spotify search rungs (slice 2) are the ~75-85% cost cut** — but only when flipped on. With the flag OFF (default) the free rung is ListenBrainz alone and Apify carries every LB miss (the numbers above). With it ON, most LB misses resolve on the free Spotify ISRC/fuzzy search instead, so Apify shrinks to the rows even Spotify search can't place. Read the split off the summary line's `anchoredByListenbrainz` / `anchoredBySpotifyIsrc` / `anchoredBySpotifySearch` / `anchoredByIsrc` / `anchoredBySearch` counters.
- **Burn the backlog faster (attended):** `--limit N` in one run.
- **Pause the spend entirely:** stop the timer (`sudo systemctl stop fluncle-anchor.timer`). No spend flows while it is stopped; the worklist is derived, so resuming picks up exactly where it left off.

### The dark flag: flip the Spotify search rungs on for the pilot (operator)

The Spotify search rungs ship **default OFF** — a starved Friday mint is user-facing breakage, so pointing the shared official app at the catalogue is a deliberate operator act, gated by the operator-tier `set_anchor_search` op (no deploy, effective next `resolve_anchor` tick). Flip it with the **operator** token (an agent token 403s):

```bash
# ON  (start the overnight pilot)
curl -fsS -X PUT https://www.fluncle.com/api/v1/admin/catalogue/anchor/search \
  -H "Authorization: Bearer $FLUNCLE_OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled":true}'
# → {"ok":true,"enabled":true}

# OFF (kill switch — one flip, no deploy)
curl -fsS -X PUT https://www.fluncle.com/api/v1/admin/catalogue/anchor/search \
  -H "Authorization: Bearer $FLUNCLE_OPERATOR_TOKEN" -H "Content-Type: application/json" \
  -d '{"enabled":false}'
```

Watch the Apify dashboard + the sweep's per-rung counters over the first night; if a mint ever looks starved, flip it OFF (or it self-protects: the Friday-morning window is skipped and the 60/min ceiling + 429 backoff keep it a trickle).

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, this doc, and the `/status` registration (`cron.anchor` in `@fluncle/registry` + the `fluncle-healthcheck` prober). Enabling it on the box is one manual pass, and it needs **one new secret** — the Apify token.

1. **Add the Apify token** to the shared op-injected secrets file as `APIFY_API_TOKEN` (placeholder `op://<vault>/APIFY_API_TOKEN/credential`; the concrete vault path lives in the private companion). It joins the same `${HOME}/.fluncle-secrets.env` every sweep sources. `FLUNCLE_API_TOKEN` (the box's agent token) is already present — `anchor_track` and the worklist read are agent tier, so **no operator token**.

2. **Install + enable the timer** on the rave-02 HOST, from a repo checkout, as root:

   ```bash
   sudo install -m 0644 docs/agents/hermes/anchor-timer/fluncle-anchor.service /etc/systemd/system/
   sudo install -m 0644 docs/agents/hermes/anchor-timer/fluncle-anchor.timer   /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now fluncle-anchor.timer

   # Verify one tick now.
   sudo systemctl start fluncle-anchor.service            # one tick
   journalctl -u fluncle-anchor.service -n 40 --no-pager  # expect a { "ok": true, "anchoredByIsrc": …, … } summary line
   systemctl list-timers fluncle-anchor.timer
   ```

   (A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

3. **Watch the spend.** The first days drain the backlog at ~$5-6/day; confirm the pace against the Apify dashboard, and use `--limit` (or the timer's cadence) to widen/narrow it.

**It is already on /status.** `cron.anchor` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `AUTOMATION_CRONS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
