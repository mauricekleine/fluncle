# fluncle-backfill-timer — the catalogue-backfill sweep on a host timer

The Hermes box trigger for the `--no-agent` **backfill** sweep. `fluncle-backfill` repairs the music-graph side-channels over already-published findings — the Discogs release-id resolve, the Last.fm love, and the Apple Music URL — and drains their catalogue siblings. The two Discogs legs use the same split as label images: the Worker prepares bounded work, the box performs only paced vendor reads, and the Worker re-verifies the candidates and owns every write. The other vendor legs retain their Worker/CLI paths. Zero box tokens. A host systemd timer runs the baked sweep every 30 minutes.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/backfill-sweep.sh`](../scripts/backfill-sweep.sh) → [`../scripts/backfill-sweep.ts`](../scripts/backfill-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why a host timer + the /status marker

Every automation cron runs from a repo-checked-in host timer so the SCHEDULE is code. Because a `docker exec` sends stdout to journald, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-backfill`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.backfill` row stays honest. The prober is UNCHANGED.

## Admission: one short phase per database step

The sweep takes its own phase-scoped admission, as `fluncle-crawl` and `fluncle-anchor` do; the unit does not wrap it in `database-admission-runner.sh`. Each database step runs as its own `database-admission-runner.sh phase fluncle-backfill -- …` window, nine per full tick:

| Leg                                             | Admitted phases                                                         | Unleased between them             |
| ----------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| Discogs release ids                             | the prepare POST, then the decide POST                                  | the box's paced Discogs reads     |
| Last.fm, Apple Music, Apple catalogue, Beatport | one phase around each leg's single `fluncle admin backfills <leg>` call | nothing, and nothing between legs |
| Discogs facts                                   | the prepare POST, then the decide POST                                  | the box's paced Discogs reads     |
| Deezer                                          | one phase around its `fluncle admin backfills deezer` call              | nothing                           |

A phase child is the same `backfill-sweep.ts` run with `--admission-phase <state>`: it makes exactly one CLI call or one POST under `/api/v1/admin/backfill/` and prints its status and body, so the parent applies the same parse and partial-failure rules as before. The CLI legs' vendor lookups (Apple, Beatport, Deezer, Last.fm) happen inside their one Worker request, so each of those phases lasts as long as that one request; the Discogs reads, the only vendor work the box performs itself, never sit under a lease. The hold per phase is therefore one leg, never the tick.

A phase that yields (queue wait, a closed lane, the breaker) is not retried in the run (`yieldRetries: 0`). The tick stops there with `reason: "database_admission"`, keeps the counts of the legs that ran, and names the rest in `deferredLegs`; the next tick starts again from the first leg. A decide phase that yields writes nothing, so its prepare hands the same work out again next tick. The sweep stops starting phases after `FLUNCLE_BACKFILL_WALL_BUDGET_MS` (default 360 s) and reports `reason: "wall_budget"`, so a tick whose phases each waited out a long queue still ends inside the unit's `TimeoutStartSec=730`. Every write the legs make is replay-safe (`backfill.vendor-sweep` is `replay-safe-idempotent` in the operation registry: existing-null guards, stable upserts, idempotent Last.fm love), which is what makes stopping between phases safe with no per-item receipt.

The whole-lifetime lease this replaces held the lane across every leg, including the box's Discogs reads. The runner journal for 2026-09-25 07:00 to 2026-09-28 07:00 UTC recorded 123 released backfill holds: median 75 s, p90 111 s, maximum 156 s, 39 of them at or past 90 s and 10 past the 120-second queue wait, the point at which every writer that queued behind it expires. With phases, each hold is one leg's Worker call; read the new per-phase `hold_ms` from the runner events tagged `phase_scoped:true`.

## Rollout: image first, then the unit

The phased script and this unit ship in one change but reach the box in two steps, because pin-watch rebakes the scripts and never reinstalls host units. The script works under both units:

- **Previous unit, new script** (after the rebake, before the unit refresh). The old `ExecStart` still wraps the sweep in `database-admission-runner.sh fluncle-backfill -- …`, and the runner exports `FLUNCLE_ADMISSION_RUNNER_PID` to its payload. The script sees it and runs every leg in-process under that one inherited lease, exactly as the whole-lifetime sweep did, with no nested phase acquisition (a nested phase would queue behind its own parent's lease). Its summary reports `admissionMode: "inherited-lease"`.
- **New unit, new script.** No runner context, so every leg takes its own phase (`admissionMode: "phased"`).
- **New unit, old script** is the one unsafe pairing: the old script under the new unit runs every leg with no admission at all. The ordered steps below never create it.

Operator steps, in order:

1. **Merge** the change to `main`.
2. **Let pin-watch rebake the image**, then confirm the box carries the phased script: `docker exec hermes grep -c runDatabaseAdmissionPhase /opt/hermes-scripts/backfill-sweep.ts` prints a non-zero count. Until step 3 the previous unit keeps running, now in the inherited-lease branch; its journal summary shows `"admissionMode":"inherited-lease"`.
3. **Refresh only this service** with the roster-derived installer; it reloads systemd without changing the timer's enabled or active state:

   ```bash
   sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-backfill.service
   ```

4. **Verify.** `systemctl cat fluncle-backfill.service` shows `ExecStart` starting `backfill-sweep.sh` directly, with no `database-admission-runner.sh`. Run one attended tick with `sudo systemctl start fluncle-backfill.service`, then read `journalctl -u fluncle-backfill.service -n 80 --no-pager`: expect up to nine runner events with `"owner":"fluncle-backfill"` and `"phase_scoped":true`, each with a `hold_ms` of one leg, and a summary line with `"admissionMode":"phased"`.

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
