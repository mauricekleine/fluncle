# fluncle-label-lineage-timer — the label-lineage filler on a host timer

The rave-02 host trigger for the `--no-agent` **label-lineage fill** sweep — the label entity's lineage half (RFC label-lineage-remixer, U1). `fluncle-label-lineage` gives each label its **founding facts** and its **place in the imprint hierarchy** from MusicBrainz. The full design is [docs/label-entity.md](../../../label-entity.md#label-lineage-founding-facts--the-imprint-hierarchy).

**What it writes.** For each pending label it walks one MusicBrainz label lookup (`inc=label-rels`) and persists: `life-span.begin` → `founding_date` (verbatim — a year or a full date), `area.name` → `founded_location`, and the `backward` `label ownership` / `imprint` label-rels → `parent_label_id` — matched to an EXISTING `labels` row by MBID. It **NEVER mints a label**: a parent MusicBrainz names that no archive row carries is only counted (`unmatchedParents`), never created. Emitted on `/label/<slug>` as the Organization's `foundingDate` / `location` / `parentOrganization` / `subOrganization`, and as the visible "Founded 1996 · London" reference line.

**Why a dedicated sweep, not a rider on the label-image sweep.** The image sweep is TERMINAL per label (a resolved/none label is never re-walked), so a label whose logo already resolved would never get its lineage. Lineage carries its OWN state machine (`lineage_state` / `lineage_attempted_at` / `lineage_failures`) so it reaches EVERY label — existing and crawler-minted — exactly once. It reuses the machinery it can: the shared 1 req/s MusicBrainz client and the exact-fold identity search (`searchMbLabelId`), so the two sweeps resolve a label's MBID the same way.

It **certifies nothing**, **mints nothing**, and **publishes nothing** — label lineage is internal, reversible metadata (agent tier, the `backfill_label_images` precedent). **Zero LLM tokens** — a pure trigger.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/label-lineage-sweep.sh`](../scripts/label-lineage-sweep.sh) → [`../scripts/label-lineage-sweep.ts`](../scripts/label-lineage-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch.

## The model: Worker-paced, and the schedule is the loop

The box holds no MusicBrainz budget; the Worker does. So the walk happens IN THE WORKER (`backfill_label_lineage`, agent tier) and this driver only paces it — the `fluncle-recording-mbids` shape, verbatim. The Worker carries the durable per-row reliability state (`lineage_state` + `lineage_attempted_at`), the ~1 req/s MusicBrainz gate, and the rate-limit circuit breaker.

That split makes the **cadence, not the batch size, the real throttle.** Every scrap of state is on the `labels` row, so "run again" and "resume" are the same command: a walked label is terminal and skipped forever; a label MusicBrainz cannot identify is marked `none` and drains; a throttle just circuit-breaks and the next tick resumes fresh. A reboot mid-worklist costs nothing.

- `FLUNCLE_LABEL_LINEAGE_LIMIT` (default `25`) — labels handled per tick. The CLI loops the slug cursor internally up to this cap (or until the worklist drains, or MusicBrainz throttles); the Worker clamps a single pass to 8 labels regardless, each ≤2 paced ~1.1s calls, so a tick is under a minute.

At 25 labels every 60 minutes — against a worklist that is the findings' labels plus the crawler's slow drip — the worklist stays drained with wide headroom, and a tick that finds every label walked/attempted is a cheap no-op.

Check on it any time:

```bash
fluncle admin backfills label-lineage --dry-run   # the eligible worklist; writes nothing
```

## Why a host timer + the /status marker

Every automation cron runs off repo-checked-in host timers so the SCHEDULE is code. Because a `docker exec` sends stdout to journald instead of the gateway's output dir, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-label-lineage`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper.

## Activation (OPERATOR-GATED — the repo half ships; the box enable does not)

The repo carries the scripts, the timer units, and this doc. Enabling it on the box is one manual pass — **no new secret**: `backfill_label_lineage` is AGENT tier, so the box's existing agent-scoped token drives it.

```bash
# On the rave-02 HOST, from a repo checkout, as root:
sudo install -m 0644 docs/agents/hermes/label-lineage-timer/fluncle-label-lineage.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/label-lineage-timer/fluncle-label-lineage.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-label-lineage.timer

# Verify one tick now.
sudo systemctl start fluncle-label-lineage.service            # one tick
journalctl -u fluncle-label-lineage.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-label-lineage.timer
```

(A full re-provision restores it automatically — [`../install-host-timers.sh`](../install-host-timers.sh) globs every `*-timer/` dir; the manual pass above is only for the FIRST enable on an already-running box.)

**It is already on /status.** `cron.label-lineage` is registered in `@fluncle/registry` and in the `fluncle-healthcheck` prober's `CRON_SPECS`, so the moment the timer runs its first tick the `/status` row goes live. Nothing further to wire.
