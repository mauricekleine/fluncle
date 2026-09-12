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

The crawler runs **one pass per tick** because its pace is a _vendor's_ rate limit (MusicBrainz, ~1 req/s) and there is no prize for hurrying. Ranking has no external budget at all — it is pure local SQL — and it has a natural finish line. So this sweep **loops while `remaining > 0`**, up to a hard tick budget, and stops. Between pages it advances the shared track due-work repair queue until the guarded rank read is clean; it never weakens or skips that guard.

- `FLUNCLE_RANK_BATCH` (default `250`) — rows per call (the Worker clamps at 1000).
- `FLUNCLE_RANK_MAX_CALLS` (default and maximum `8`) — the tick's hard rank-page budget. 250 × 8 = 2,000 rows/tick; the rest simply drains on the next tick, and `remaining > 0` in the summary says so honestly.

Each admitted child runs exactly one `projections advance --target track_due_work --action repair --limit 500 --max-steps 1 --no-terminal-status` call. An incomplete repair child exits successfully and releases its lease before the next child queues, so other writers get a fair admission point between every five-marker source-repair page. A complete repair child may rank one page before releasing the same lease; this closes the race between the clean convergence proof and the guarded queue read. A phase yield is healthy partial progress and is never replayed inside the firing because a lost fence makes the write result ambiguous.

Each rank write already leaves a durable source marker. Ordinary repair normalizes embedded and unembedded rank fingerprints exactly like the rank rebuild, so it removes the page that just converged before the next page is selected. The same path automatically repairs an incorrectly ready rank entry left by an older worker; rollout needs no blanket rebuild, migration, or new operator gate.

The repair-phase cap is derived from the configured page bounds: `1 + FLUNCLE_RANK_MAX_CALLS × ceil(FLUNCLE_RANK_BATCH / 5)`. At the defaults that is 401 phases: one initial clean proof, enough five-marker repair phases for every one of the eight possible 250-row rank pages, and therefore bounded cleanup after page eight. A monotonic 600-second phase-start budget is the independent wall bound. Every CLI child has a 120-second timeout. Exhausting either bound reports a healthy partial summary with a positive `remaining` sentinel; it never reports a clean empty queue.

During a rolling image update, an old installed unit may already own a whole-lifetime admission lease. `FLUNCLE_ADMISSION_RUNNER_PID` detects that inherited lease: the new script does not nest phase admission, makes at most one legacy rank request, and reports any work or typed `due_work_maintenance_pending` response as healthy partial progress. The checked-in service directly starts `rank-sweep.sh`; once that unit is installed, normal firings use the short phased shape.

**Self-healing, so an idle tick is cheap.** Staleness is a fingerprint of the finding corpus (`"<findings>:<embedded>"`) stored on every ranked row. Log a finding or embed one and the fingerprint moves, so every catalogue row disagrees with it and re-ranks on later ticks — **no invalidation call from the publish path**. On an unchanged archive the tick is one scoped `COUNT` and a no-op.

**It certifies nothing.** `rank_catalogue` writes only DERIVED columns, and only on CATALOGUE rows (a `tracks` row with no `findings` row). It cannot mint a coordinate, write a note, or touch a finding — the columns for that do not exist on the rows it can reach. Agent tier, agent token, **no new secret**. Zero LLM tokens.

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-rank`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper. Both `cron.rank` and `cron.crawl` are registered in `@fluncle/registry`, so they light up `/status` the moment the timers run.

## The script owns the work bound

The unit's `ExecStart` is a `docker exec`, so `TimeoutStartSec` primarily bounds the client process on the host. The script therefore stops starting phases after 600 monotonic seconds instead of relying on systemd to reap container work. A final composite phase can wait at most 120 seconds for admission and run at most two 120-second CLI children, bounding its worst completion at 960 seconds; the unit's 1,030-second backstop leaves 70 seconds for wrapper and process teardown.

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
