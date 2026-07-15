# fluncle-rank-timer — The Ear's ranking sweep on a host timer

The rave-02 host trigger for the `--no-agent` **catalogue-ranking** sweep. `fluncle-rank` keeps The Ear's ranking fresh: each tick scores a bounded batch of **stale** catalogue rows against every embedded finding — entirely in SQL inside the Worker — and stores each one's nearest finding, the cosine similarity to it, and (for a row with no audio yet) its capture-priority tier. The full design is [docs/the-ear.md](../../../the-ear.md).

## Why this timer lands with the crawler's PR

The Ear shipped `rank_catalogue` **deliberately without a schedule**, and said so in its own doc: _"a timer ranking an empty table would be a `/status` row that means nothing; the crawler is what creates rows, so its PR is where `rank_catalogue` gets its schedule."_ The crawler now exists ([docs/catalogue-crawler.md](../../../catalogue-crawler.md)), so the ranking has something to rank. The two are one loop:

```
fluncle-crawl  (every 10m) → writes catalogue rows
fluncle-rank   (every 30m) → ranks them against the findings
                           → /admin/catalogue shows the operator what is close to what he loves
```

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/rank-sweep.sh`](../scripts/rank-sweep.sh) → [`../scripts/rank-sweep.ts`](../scripts/rank-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: it DRAINS, unlike the crawl

The crawler runs **one pass per tick** because its pace is a _vendor's_ rate limit (MusicBrainz, ~1 req/s) and there is no prize for hurrying. Ranking has no external budget at all — it is pure local SQL — and it has a natural finish line. So this sweep **loops while `remaining > 0`**, up to a hard tick budget, and stops. A crawl that just landed 700 rows is fully ranked by the next tick, not seventy minutes later.

- `FLUNCLE_RANK_BATCH` (default `250`) — rows per call (the Worker clamps at 1000).
- `FLUNCLE_RANK_MAX_CALLS` (default `8`) — the tick's hard budget. 250 × 8 = 2,000 rows/tick; the rest simply drains on the next tick, and `remaining > 0` in the summary says so honestly.

**Self-healing, so an idle tick is cheap.** Staleness is a fingerprint of the finding corpus (`"<findings>:<embedded>"`) stored on every ranked row. Log a finding or embed one and the fingerprint moves, so every catalogue row disagrees with it and re-ranks on later ticks — **no invalidation call from the publish path**. On an unchanged archive the tick is one scoped `COUNT` and a no-op.

**It certifies nothing.** `rank_catalogue` writes only DERIVED columns, and only on CATALOGUE rows (a `tracks` row with no `findings` row). It cannot mint a coordinate, write a note, or touch a finding — the columns for that do not exist on the rows it can reach. Agent tier, agent token, **no new secret**. Zero LLM tokens.

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-rank`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper. Both `cron.rank` and `cron.crawl` are registered in `@fluncle/registry`, so they light up `/status` the moment the timers run.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

Enable it **alongside** `fluncle-crawl` — the two are one loop, and ranking an empty table is the thing The Ear declined to schedule. No new secret.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/rank-timer/fluncle-rank.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/rank-timer/fluncle-rank.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-rank.timer

# Verify one tick now.
sudo systemctl start fluncle-rank.service            # one tick
journalctl -u fluncle-rank.service -n 40 --no-pager  # expect a { "ok": true, "scored": …, "remaining": … } line
systemctl list-timers fluncle-rank.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

Check on it any time:

```bash
fluncle admin catalogue rank --limit 250   # one tick by hand
fluncle admin catalogue list --lens ear    # what the operator sees
```
