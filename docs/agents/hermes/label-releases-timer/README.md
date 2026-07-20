# fluncle-label-releases-timer — the freshness tap on a host timer

The rave-02 host trigger for the `--no-agent` **freshness tap** sweep (D8). `fluncle-label-releases` finds the **fresh releases** of the labels the operator ENABLED — via the Apify Spotify-scraper actor — and mints uncertified catalogue rows into `tracks` with their **day-one release dates**.

## Why it exists: the ~2-week MusicBrainz lag

The catalogue crawler ([../crawl-timer/README.md](../crawl-timer/README.md)) WALKS the graph off MusicBrainz — the complete, recording-centric spine. But MusicBrainz's editorial database lags a release by ~2 weeks (a volunteer has to enter it), so a Friday drop is invisible on `/fresh` until then. Spotify has it on day one. So the doctrine amendment (operator-ratified 2026-07-19): **MusicBrainz walks the graph; Spotify taps freshness.** This probe closes the lag cliff.

It **certifies nothing** — a tapped track is a `tracks` row with no `findings` row, so it has no Log ID, no note, no video, no galaxy, and no place on `/log`, the feeds, the sitemap or the Galaxy game. It **captures no audio** (the row lands with `capture_status` at its DDL default). It **never widens the graph** — it mints tracks/albums for the PROBED seed label and nothing else (no new labels, no artist hops). **Zero LLM tokens** — a pure trigger. The full design is [label-releases.ts](../../../../apps/web/src/lib/server/label-releases.ts) + [docs/catalogue-crawler.md](../../../catalogue-crawler.md).

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/label-releases-sweep.sh`](../scripts/label-releases-sweep.sh) → [`../scripts/label-releases-sweep.ts`](../scripts/label-releases-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: box-runs-actor / Worker-verifies (the anchor-sweep precedent)

The first cut ran the Spotify reads IN THE WORKER against the official dev-mode Spotify app — the same app the user paths (adds, publish, the Frontier mints) depend on. That app is rate-limited to death at its tier (batch endpoints 403, search `limit` ≤ 10, sustained 429s), and sharing its tiny budget with the user writes is what blocked the tap's backfill. So on **2026-07-20** the tap moved OFF that budget onto the Apify actor `musicae~spotify-extended-scraper` — the SAME actor + split the catalogue **anchor** already uses ([../anchor-timer/README.md](../anchor-timer/README.md)):

- **the BOX runs the actor.** It reads the due seed labels (`GET /api/admin/backfill/label-releases/work`, agent token), runs `albums:["label:\"<name>\" tag:new"]` once per label — returning up to `searchKeywordLimit` fresh albums, each with its inline `tracks[]` (+ ISRCs) + `artists[]` — maps each to a candidate, and POSTs a label's candidates to `backfill_label_releases`.
- **the WORKER verifies + writes.** It re-runs the FULL gate (artist-grounding + label attribution + dedupe — the box's match is NEVER trusted, the `anchor_track`/`verify_capture` doctrine) and mints the survivors. Completing a label stamps `label_releases_checked_at`, so an empty result is not re-asked (or re-billed) that window.

That split is what makes the cadence, not the batch size, the real throttle. Every scrap of state is in the database, so "run again" and "resume" are the same command: a box reboot mid-probe costs one label's re-tap, not a re-mint (the dedupe skips rows already minted, from both directions — Spotify id/uri/ISRC and same-album title fold).

- `FLUNCLE_LABEL_RELEASES_LABELS` (default `5`) — enabled seed labels probed per tick; `--limit N` overrides it for an attended burn. `FLUNCLE_LABEL_RELEASES_KEYWORD_LIMIT` (default `10`) — the actor's per-label fresh-album cap.

## The gate: artist-grounding (mandatory) + label attribution (when the actor gives it)

`label:"<name>" tag:new` forwards Spotify's freshness filter — but that filter is FUZZY for generic names (`label:"RAM Records"` returned 93 junk albums live; `label:"Hospital Records"` returned exactly its 2 real ones). So an album mints ONLY when:

1. **artist-grounding** (the PRIMARY anchor, always required) — at least one of the album's Spotify artist ids (`artists[].id`) is already in `artists.spotify_artist_id`. This killed 100% of the cross-genre junk the first live drain minted (an Indian devotional record, Brazilian live albums — every one by an artist we had never certified); AND
2. **label attribution** (the SECONDARY confirmation, applied ONLY when present) — the actor's `album_label` (exact-fold-equals the seed name), or failing that its `album_copyright` (℗/© string). In the actor's `albums`-search mode both come back **null** (measured live 2026-07-20), so the tap runs on grounding ALONE there — the documented fallback; the gate engages the moment a mode/actor populates `album_label`, no code change.

The tradeoff is deliberate: a brand-new artist's debut is skipped until the MB tail-first re-arm backfills them, and in grounding-only mode a known artist's release the fuzzy filter mis-attributed self-corrects via the MB crawl's dedupe convergence. Correctness over completeness for a public surface.

## The operator's steering wheel

The tap only ever probes labels whose `seed_state` is `enabled` — the SAME allowlist the crawl seeds from, never widened. A disabled/undecided label is never in the worklist, and the mint op re-checks the seed state (a label disabled mid-flight is a no-op). Enabling a label stays OPERATOR tier (`update_label`); the tap itself is agent tier.

Run one tick by hand any time (the anchor-sweep way — there is no `fluncle` CLI command for the tap):

```bash
sudo systemctl start fluncle-label-releases.service            # one tick
journalctl -u fluncle-label-releases.service -n 40 --no-pager  # expect a { "ok": true, … } summary
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-label-releases`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `backfill_label_releases` + the worklist read are AGENT tier, so the box's existing agent-scoped token drives them, and the actor runs on the `APIFY_API_TOKEN` the catalogue **anchor** sweep already provisions in `~/.fluncle-secrets.env` (the tap reuses the SAME one). So the moment the anchor sweep is live — it is — this tap has every secret it needs.

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
