# fluncle-isrc-recovery — the free ISRC-recovery sweep on a host timer

This host timer runs a tokenless Deezer pass over un-anchored catalogue tracks that have no stored ISRC. Recovering an ISRC moves a row into the billed anchor queue's high-precision exact-ISRC head, where the existing anchor sweep can resolve its Spotify track without asking the fuzzy tail to compete for the same batch.

The sweep work is baked at `/opt/hermes-scripts/`: [`../scripts/isrc-recovery-sweep.sh`](../scripts/isrc-recovery-sweep.sh) invokes [`../scripts/isrc-recovery-sweep.ts`](../scripts/isrc-recovery-sweep.ts), and the wrapper records the final JSON summary as the cron's `/status` marker.

## The zero-Apify boundary

The box fetches candidates; the Worker keeps verification authority:

1. Fetch up to `FLUNCLE_ISRC_RECOVERY_BATCH` rows from `GET /api/v1/admin/tracks/work?kind=isrc-recovery`, each with its server-built `deezerQuery`.
2. Search Deezer once per row, sequentially and paced at roughly 1.1 seconds between requests.
3. POST at most five candidates to the existing `resolve_anchor` operation with `spotifySearch: false`. The Worker applies the shared identity and duration gate and writes a recovered ISRC only when the candidate clears it.

This sweep never calls `anchor_track` and never invokes Apify. Deezer search is tokenless, so the only credential is the existing agent-scoped `FLUNCLE_API_TOKEN`; no new secret or operator token is required.

Deezer can report quota exhaustion as an HTTP 200 error body. The client classifies that outcome separately from an empty result, retries it, and aborts the remaining work after a short consecutive quota streak. The final summary keeps quota-blocked rows distinct from genuine Deezer-empty rows and transport failures, so a quota-blind tick cannot look like a clean miss.

## Pace and controls

The checked-in service sets `FLUNCLE_ISRC_RECOVERY_BATCH=100`, which is also the code default. Override that environment variable for a deliberately smaller bounded tick. The timer runs hourly, spaces requests by roughly 1.1 seconds, applies `RandomizedDelaySec=90`, and persists missed firings. An empty or backoff-covered worklist is a no-op.

## Install and verify

The repository carries the scripts, units, `/status` registration, and healthcheck mapping. A host-timer installer discovers every unit-bearing `*-timer/` directory, so a full provision includes this timer automatically. To add it to an already-running host from a repository checkout:

```bash
sudo install -m 0644 docs/agents/hermes/isrc-recovery-timer/fluncle-isrc-recovery.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/isrc-recovery-timer/fluncle-isrc-recovery.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-isrc-recovery.timer
```

Verify one bounded tick and its schedule:

```bash
sudo systemctl start fluncle-isrc-recovery.service
journalctl -u fluncle-isrc-recovery.service -n 40 --no-pager
systemctl list-timers fluncle-isrc-recovery.timer
```

The journal's final stdout line is one JSON summary. `/status` reads the same run through `cron.isrc-recovery`; no extra probe wiring is needed.
