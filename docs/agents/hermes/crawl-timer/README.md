# fluncle-crawl-timer — the catalogue crawler on a host timer

The rave-02 host trigger for the `--no-agent` **catalogue crawl** sweep. `fluncle-crawl` advances Fluncle's catalogue by ONE bounded pass per tick: it walks the MusicBrainz release graph outward from the labels the operator ENABLED and writes uncertified catalogue rows into `tracks`.

It **certifies nothing** — a crawled track is a `tracks` row with no `findings` row, so it has no Log ID, no note, no video, no galaxy, and no place on `/log`, the feeds, the sitemap or the Galaxy game. It **captures no audio** (the row lands with `capture_status` at its DDL default, and the capture queue's `findings.log_id is not null` predicate structurally cannot reach it). **Zero LLM tokens** — a pure trigger. The full design is [docs/catalogue-crawler.md](../../../catalogue-crawler.md).

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/crawl-sweep.sh`](../scripts/crawl-sweep.sh) → [`../scripts/crawl-sweep.ts`](../scripts/crawl-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: box-fetched, Worker-ruled, and the schedule is the loop

The driver calls the existing agent-tier `crawl_catalogue` action in three phases: an admitted prepare claims and signs a few nearby frontier snapshots (up to `MAX_CRAWL_PREPARE_LIMIT`, the bound the claim lease sets and the request schema enforces), an unadmitted fetch resolves each node's provider bytes, and each admitted receipt-backed commit atomically applies the expansion and settles that exact claim. No provider wait holds the database's exclusive background-writer lease. The Worker carries the durable frontier (`crawl_frontier`), the storage gate, the `Retry-After` backoff and the circuit breaker. If the maintained crawl projection is deliberately disabled, initialization reports a disabled gate and the sweep performs no fallback mutation.

**The MusicBrainz request itself is made from this box's own IP.** MusicBrainz counts per source address, a Worker's egress is shared with strangers, and its pacing gate lives in an isolate — so the honest budget can only exist here, where one address runs every sweep. The prepare hands back the exact url(s) this claim allows; the sweep fetches them through the shared budget in [`../scripts/musicbrainz-fetch.ts`](../scripts/musicbrainz-fetch.ts) (a lock-guarded next-allowed instant under the sweep home, 1.1 s apart across processes, `Retry-After` pushing that instant forward for every sibling), and hands the bodies to the fetch phase. The Worker reads a body only under a url it itself asks for, parses it with the parser its own fetch feeds, and falls back to its own request for any url the box did not supply. The whole design and its residual risk are in [docs/catalogue-crawler.md](../../../catalogue-crawler.md) § Deterministic · resumable · polite · idempotent.

Both halves of the switch must agree before a single request is spent: the server's `crawl_box_fetch_enabled` KV flag (default on; the exact string `false` closes it, no deploy and no rebake) is answered on the prepare as `boxFetch`, and this box's own `FLUNCLE_CRAWL_BOX_FETCH` is the other half. Either side saying no puts every read back on Worker egress with nothing else changed. The tick reports `boxFetch` and `boxFetched` in its summary, so the ledger says which address the requests came from.

**When the claim defers.** The admitted prepare's claim converges the crawl's own due-work repair first, in bounded source pages and node chunks under one wall bound. Repair wider than that budget is the ordinary shape of a write burst, not a fault: the claim answers the typed `due_work_maintenance_pending` 503 and the sweep reports a **paused** tick (`gateState: "paused"`, `throttled: true`, `reason: "due_work_repair_pending"`) at exit zero, exactly like every other sweep behind that guard ([../cron/README.md](../cron/README.md)). The deferred claim still converged the repair its budget allowed, so the next tick resumes from that durable progress. A phase the Worker deferred cannot simply fail its child — a non-zero phase exit reads as a failed phase — so the child carries the typed answer back across the admission boundary as an exit-zero envelope the driver re-raises.

That split is what makes the cadence, not the batch size, the real throttle. **A catalogue crawl is a marathon the SCHEDULE finishes, not the process.** Every scrap of state is in the database, so "run again" and "resume" are the same command: a box reboot mid-label costs one node, not one crawl.

- `FLUNCLE_CRAWL_NODES` (script default `10`, **set to `60` in the unit**) — frontier nodes per tick, validated as an integer from 1 through 60 before any mutation. Measured ~3s per node against a paced MusicBrainz, so a 60-node tick is ~180s. It rides the `docker exec` as `-e`; a systemd `Environment=` sets it on the host wrapper and never reaches the sweep.
- `FLUNCLE_CRAWL_BOX_FETCH` (default on; `0` disables) — the box's half of the box-fetch switch. Off, the tick supplies nothing and every MusicBrainz read goes back over Worker egress. `FLUNCLE_MUSICBRAINZ_STATE_DIR` overrides where the shared budget lives (default `$HOME/.musicbrainz`); every sweep shares the container `HOME`, which is what makes it one budget.
- `FLUNCLE_CRAWL_MAX_HOP` (default `2`) — the ratified boundary gate, validated from 0 through 3 before any mutation: hop 0 = a release on an enabled seed label, hop 1 = an artist on it, hop 2 = a release that artist also appears on, then STOP.
- `FLUNCLE_CRAWL_THROTTLE_PAUSE_MS` (default `45000`, validated 0 through 120000) — how long the tick waits out a MusicBrainz throttle before claiming again. The shared client has already spent this node's `Retry-After` hints before it reports a throttle at all, so the pause is a flat wait rather than an echo of a hint already proven insufficient.
- `FLUNCLE_CRAWL_WALL_BUDGET_MS` (default `840000`, validated 1000 through 1000000) — the tick's own deadline, a backstop under `TimeoutStartSec=1030`. Checked before every claim and before every node inside one, so an overshoot is bounded to a single node. A tick that reaches it reports `partial: true` with `reason: "wall_budget"`; a tick killed by the unit would report nothing at all.

At 60 nodes every 10 minutes that is ~8,600 nodes/day — a seed label's neighbourhood in a day, politely, still a small fraction of what one compliant 1 req/s client may ask. A tick that finds the frontier drained is a cheap no-op.

**When MusicBrainz throttles.** A throttle is the vendor's state, not the tick's verdict, so it no longer ends the pass. The tick abandons the rest of that claim (its nodes would meet the same wall, and an unworked claim expires back to `ready`), waits `FLUNCLE_CRAWL_THROTTLE_PAUSE_MS`, and claims again — up to three throttles per tick, after which it stops `partial` with `reason: "musicbrainz_throttle"` and leaves the wall to the next tick's fresh rate window. The summary reports `throttles`, a count rather than the bare `throttled` boolean, so the ledger can tell one 503 from a sustained wall. The throttled NODE is untouched by any of this: it returns to the frontier claimable, with its browse cursor and its unspent failure count, because a vendor wall never was its fault.

**One claim, two leases.** A claim's nodes are prepared in one admitted phase and COMMITTED IN ONE MORE (`commit_crawl_nodes`), so a six-node claim takes two admitted database phases rather than seven. The MusicBrainz reads stay outside every lease, on the box, unchanged — the two switches are independent and compose in all four combinations. `FLUNCLE_CRAWL_COMMIT_BATCH=0` in the unit environment puts every node back on its own commit phase; a Worker that advertises no `capabilities.commitBatchLimit` on its prepare does the same without a knob. Neither needs the timeout re-derived — batching only ever removes admission waits from the tick.

**Sizing it.** `TimeoutStartSec=1030` is the whole process backstop, not one database-admission window. MusicBrainz uses the shared client's 15-second per-request timeout plus its bounded `Retry-After` retries and backoff; the service deadline remains the outer process bound. A node's ten-minute durable claim does not cancel provider I/O: its expiry fences the later commit so a late response cannot mutate anything. The signed response envelope is capped at 2 MiB; a response above that bound becomes a failed attempt without truncation or false settlement. The second bound is the SHARED MusicBrainz budget: the sibling MB sweeps still ride the WORKER's serialized 1 req/s gate while the crawl reads from the box's own address, so watch the run ledger's throttled-tick ratio after any raise — if most crawl ticks yield early, or the siblings start starving, the knob is past the contention point. Raise it when the frontier is growing faster than it drains; leave it when the bottleneck is upstream (an `undecided` label backlog gates STORAGE, and no amount of walking fixes that).

## The operator's steering wheel

The crawl only ever seeds from labels whose `seed_state` is `enabled`. A label the walk DISCOVERS that nobody has ruled on enters as `undecided` and surfaces in the `/admin` attention queue — it is **not** crawled until the operator enables it. So the crawl widens only where he lets it, and the whole controls surface is one keystroke per label at `/admin/labels`. Ruling on a label stays OPERATOR tier (`update_label`); the crawl itself is agent tier.

Check on it any time:

```bash
fluncle admin catalogue status
fluncle admin catalogue crawl --dry-run   # the seed plan; writes nothing
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-crawl`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `crawl_catalogue` is AGENT tier, so the box's existing agent-scoped token drives it.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/crawl-timer/fluncle-crawl.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/crawl-timer/fluncle-crawl.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-crawl.timer

# Verify one tick now.
sudo systemctl start fluncle-crawl.service            # one tick
journalctl -u fluncle-crawl.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-crawl.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**Before the first tick, rule on the seed set.** `fluncle admin catalogue crawl --dry-run` prints how many labels are enabled. Whatever is enabled when the timer starts is the neighbourhood it will walk.

**It is already on /status.** `cron.crawl` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `AUTOMATION_CRONS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.

**Enable `fluncle-rank` alongside it.** The Ear's ranking sweep ([../rank-timer/README.md](../rank-timer/README.md)) is what turns the rows this crawl brings back into `/admin/catalogue`. It shipped without a schedule on purpose — a timer ranking an empty table means nothing — and this crawler is what gives it something to rank. The two are one loop.
