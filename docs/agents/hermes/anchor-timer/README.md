# fluncle-anchor-timer — the catalogue Spotify-anchor sweep on a host timer

The rave-02 host trigger for the `--no-agent` **catalogue Spotify-anchor** sweep. `fluncle-anchor` fills the `spotify_uri`/`spotify_url` anchor on uncertified catalogue rows — a `tracks` row with no `findings` row, resolved from MusicBrainz, that may have landed with no Spotify presence. An anchored row can be recommended, minted into a playlist, and (once the operator certifies it) published.

The full design is [docs/catalogue-crawler.md](../../../catalogue-crawler.md) § the anchor. The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/anchor-sweep.sh`](../scripts/anchor-sweep.sh) → [`../scripts/anchor-sweep.ts`](../scripts/anchor-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## Why the sweep exists: Spotify's official app can't carry this

Filling the anchor used to run **in the Worker** against the official (dev-mode) Spotify app. That app has a tiny permanent budget, and at catalogue scale it **starved under sustained 429s** — while it is also the app the user-facing paths need (adds, publish, the Frontier playlist mints). So all catalogue anchor-filling moved **off** the official app onto **this box sweep**, driven by an **Apify** Spotify-scraper actor that has its own Spotify budget. The official app now serves only user-facing paths.

## The model: box fetches candidates, the Worker rules

The box holds no verification authority — it only fetches candidates. Per tick:

1. **Fetch** the anchor worklist from the Worker with the box's AGENT token (`GET /api/admin/tracks/work?kind=anchor`). Each row carries a ready-made `anchorQuery` (its artists + title), so the driver never builds the query.
2. **Run** the Apify actor (`run-sync-get-dataset-items`) with the batch's queries (`searchKeywordLimit: 3`, artists + album on, audio features off).
3. **Group** the actor's flat results by `target` (the query) and map each to a candidate.
4. **POST** each row's candidates to `anchor_track` (agent tier). **The Worker re-runs the full verification** — exact ISRC first (the actor returns each candidate's ISRC), else the folded artist + title + ±2s-duration search triple — and writes the anchor on a hit. **The box's own match is never trusted.**

Every attempt stamps `spotify_anchor_attempted_at`, a **14-day re-ask backoff** (`ANCHOR_REASK_AFTER_DAYS`): "not on Spotify today" is not "never on Spotify", so a missed row is re-asked — but not re-billed for two weeks. The worklist is DERIVED (`spotify_uri is null`), so a stopped tick loses nothing and "run again" is "resume".

**It calls the oRPC HTTP endpoints directly** (the `verify-captures.ts` precedent), never a `fluncle admin …` subcommand — the box's baked CLI is a PINNED release and must not gain a new dependency.

- `FLUNCLE_ANCHOR_BATCH` (default `15`) — rows per tick.
- `--limit N` — an attended backlog burn (overrides the batch for one run); rows are still chunked into Apify runs of `FLUNCLE_ANCHOR_APIFY_CHUNK` (default 15).

## The cost, and how to control it

Each result item is ~**$0.005**, and at `searchKeywordLimit: 3` a row is ~3 items → ~**$0.015/row**.

- **Default pace:** 15 rows/hour ≈ **360 rows/day** ≈ **$5-6/day** while the backlog drains. Once the backlog is anchored, most ticks are cheap no-ops (a drained worklist) plus the trickle of newly-crawled rows crossing the re-ask window.
- **Burn the backlog faster (attended):** `--limit N` in one run.
- **Pause the spend entirely:** stop the timer (`sudo systemctl stop fluncle-anchor.timer`). No spend flows while it is stopped; the worklist is derived, so resuming picks up exactly where it left off.

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
