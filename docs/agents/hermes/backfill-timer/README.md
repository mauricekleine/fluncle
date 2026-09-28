# fluncle-backfill-timer — the catalogue-backfill sweep on a host timer

The Hermes box trigger for the `--no-agent` **backfill** sweep. `fluncle-backfill` repairs the music-graph side-channels over already-published findings — the Discogs release-id resolve, the Last.fm love, and the Apple Music URL — and drains their catalogue siblings. The two Discogs legs use the same split as label images: the Worker prepares bounded work, the box performs only paced vendor reads, and the Worker re-verifies the candidates and owns every write. The other vendor legs retain their Worker/CLI paths. Zero box tokens. A host systemd timer runs the baked sweep every 30 minutes.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/backfill-sweep.sh`](../scripts/backfill-sweep.sh) → [`../scripts/backfill-sweep.ts`](../scripts/backfill-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why a host timer + the /status marker

Every automation cron runs from a repo-checked-in host timer so the SCHEDULE is code. Because a `docker exec` sends stdout to journald, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-backfill`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.backfill` row stays honest. The prober is UNCHANGED.

## Admission: one lease for the whole tick (a known long hold)

The unit wraps the whole sweep in `database-admission-runner.sh fluncle-backfill -- …`, so the exclusive write lane is held across all seven legs, including the box's paced Discogs reads and the Worker-side Apple, Beatport, and Deezer lookups each leg makes before it writes. The runner's journal measured that hold at 90 to 176 seconds on 19 of 78 ticks over 2026-09-26 to 2026-09-28 (median 69 seconds). Any hold past the 120-second queue wait means a `wait-expired queue` for every writer that queued when it started, so this sweep adds to the queue contention behind a write stall.

The fix is phased admission, as `fluncle-crawl` and `fluncle-anchor` already use: each CLI leg runs as its own `runDatabaseAdmissionPhase` window, and each Discogs leg admits only its prepare POST and its decide POST, with the box's Discogs fetch between them and no lease held. That bounds the hold to the longest single leg. It needs an ordered, operator-gated rollout. Pin-watch rebakes the scripts but never reinstalls host units. So the phased script ships first, keeping a whole-pass branch for when `FLUNCLE_ADMISSION_RUNNER_PID` shows the old unit is still wrapping it. The unit's `ExecStart` then drops the runner wrap through `install-host-timers.sh`. Installing that unit before the phased script would run the old script's legs with no admission at all. The same change moves `backfill.vendor-sweep` to `phased` in the operation registry and adds `fluncle-backfill` to the phased list in [database performance](../../../database-performance.md).

## Deploy (on rave-02, one time)

Install all timers at once with [`../install-host-timers.sh`](../install-host-timers.sh), or just this one:

```bash
sudo install -m 0644 docs/agents/hermes/backfill-timer/fluncle-backfill.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/backfill-timer/fluncle-backfill.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-backfill.timer

# Verify.
sudo systemctl start fluncle-backfill.service            # one tick now
journalctl -u fluncle-backfill.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-backfill.timer
```
