# fluncle-backfill-timer — the catalogue-backfill sweep on a host timer

The Hermes box trigger for the `--no-agent` **backfill** sweep. `fluncle-backfill` repairs the music-graph side-channels over already-published findings — the Discogs release-id resolve, the Last.fm love, and the Apple Music URL — and drains their catalogue siblings. The two Discogs legs use the same split as label images: the Worker prepares bounded work, the box performs only paced vendor reads, and the Worker re-verifies the candidates and owns every write. The other vendor legs retain their Worker/CLI paths. Zero box tokens. A host systemd timer runs the baked sweep every 30 minutes.

The sweep WORK is BAKED at `/opt/hermes-scripts/` — the `.sh`/`.ts` pair (source: [`../scripts/backfill-sweep.sh`](../scripts/backfill-sweep.sh) → [`../scripts/backfill-sweep.ts`](../scripts/backfill-sweep.ts)) — riding the image and auto-updating from `main` via pin-watch (Unit A). The host timer only triggers it.

## Why a host timer + the /status marker

Every automation cron runs from a repo-checked-in host timer so the SCHEDULE is code. Because a `docker exec` sends stdout to journald, the sweep self-writes the `/status` marker (`# Cron Job: fluncle-backfill`) via the shared [`cron-output.sh`](../scripts/cron-output.sh) helper, so the [`fluncle-healthcheck`](../scripts/fluncle-healthcheck.ts) prober's `cron.backfill` row stays honest. The prober is UNCHANGED.

## Admission: one short phase per Worker request

The sweep takes its own phase-scoped admission, as `fluncle-crawl` and `fluncle-anchor` do; the unit does not wrap it in `database-admission-runner.sh`. Every Worker request the sweep makes is its own `database-admission-runner.sh phase fluncle-backfill -- …` window, and nothing between two requests holds the lease:

| Leg                            | Admitted phases                                                                                                   | Unleased between them         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Discogs release ids            | the prepare POST, then the decide POST                                                                            | the box's paced Discogs reads |
| Last.fm, Apple Music, Beatport | one phase per page of `POST /admin/backfill/<leg>`, following `nextCursor` until the leg's batch is handled       | nothing                       |
| Apple catalogue, Deezer        | one phase per pass of `POST /admin/backfill/<leg>`, repeated until the batch is handled or a pass handles nothing | nothing                       |
| Discogs facts                  | the prepare POST, then the decide POST                                                                            | the box's paced Discogs reads |

The Worker handles at most three findings per page on the published-finding legs, so a leg's batch can take several pages; the sweep drives that pagination itself, with each page in its own phase, rather than letting the `fluncle admin backfills` CLI loop pages inside one lease. A full healthy tick with nothing left to paginate takes nine phases. The phase child is the same `backfill-sweep.ts` run with `--admission-phase <state>`. It sends exactly one POST, and only to the seven `/api/v1/admin/backfill/<leg>` endpoints the sweep uses, with only the `boxFetch`, `cursor`, `dryRun`, and `limit` query keys, and a body only for the two Discogs decides. It adds the token from its own environment, so the token never lands in the state file. The Worker-side vendor lookups (Apple, Beatport's Firecrawl scrapes, Deezer, Last.fm) happen inside that one request, so a phase lasts one Worker request; the Discogs reads, the only vendor work the box does itself, never sit under a lease.

A phase that yields (queue wait, a closed lane, the breaker) is not retried in the run (`yieldRetries: 0`). The tick stops there with `reason: "database_admission"`, keeps the counts of every page already written, and names the unfinished legs in `deferredLegs`; the next tick starts again from the first leg. A decide phase that yields writes nothing, so its prepare hands the same work out again next tick. Every write the legs make is replay-safe (`backfill.vendor-sweep` is `replay-safe-idempotent` in the operation registry: existing-null guards, stable upserts, idempotent Last.fm love), so stopping between phases needs no per-item receipt.

The sweep also stays inside the unit's `TimeoutStartSec=730`. A phase starts only when its worst case still fits before a 660-second deadline (`FLUNCLE_BACKFILL_DEADLINE_MS`): 250 seconds per phase (`FLUNCLE_BACKFILL_PHASE_WORST_MS`, the runner's 120-second queue wait plus the child's 120-second request timeout and slack), and a Discogs leg needs room for both of its phases plus 60 seconds for its fetch before it prepares. A leg that does not fit is deferred with `reason: "phase_budget"`. If a phase is still running at the deadline, the sweep stops it (the runner releases the lease) and writes its summary with `reason: "deadline"` and every unfinished leg deferred, so the `/status` marker is always written.

The whole-lifetime lease this replaces held the lane across every leg, including the box's Discogs reads. The runner journal for 2026-09-25 07:00 to 2026-09-28 07:00 UTC recorded 123 released backfill holds: median 75 s, p90 111 s, maximum 156 s. 39 of them lasted 90 s or more, and 10 ran past the 120-second queue wait, the point at which every writer that queued behind them expires. With phases, each hold is one Worker request. Read the new per-phase `hold_ms` from the runner events tagged `phase_scoped:true`.

## Rollout: the unit follows the image

Pin-watch rebakes the scripts but never reinstalls host units, so the phased script and this unit can reach the box in either order. Every pairing is safe:

- **Previous unit, new script** (after the rebake, before the unit refresh). The old `ExecStart` still wraps the sweep in `database-admission-runner.sh fluncle-backfill -- …`, and the runner exports `FLUNCLE_ADMISSION_RUNNER_PID` to its payload. The script sees it and runs every leg through the CLI in-process under that one inherited lease, exactly as the whole-lifetime sweep did, with no nested phase acquisition (a nested phase would queue behind its own parent's lease). Its summary reports `admissionMode: "inherited-lease"`.
- **New unit, new script.** No runner context, so every Worker request takes its own phase (`admissionMode: "phased"`).
- **New unit, old script.** Two guards keep this pairing from ever running the old script without admission. The unit declares `X-Fluncle-Baked-Capability=/opt/hermes-scripts/backfill-sweep.ts fluncle-backfill-phased-admission-v1`, a key systemd ignores. [`install-host-timers.sh`](../install-host-timers.sh), in a full install or a `--refresh-unit`, checks the baked script for that marker (the `BACKFILL_ADMISSION_CAPABILITY` constant in `backfill-sweep.ts`). When the marker is missing, it installs [`fluncle-backfill.service.whole-lifetime`](./fluncle-backfill.service.whole-lifetime) under the unit's name instead, which keeps the old admission wrap, and reports the unit as `held on fallback`. And a unit installed by hand still runs `ExecStartPre` against the same marker, so on an old image it fails before the payload starts (its `OnFailure` alert fires) instead of running unadmitted.

Operator steps, in order:

1. **Merge** the change to `main`.
2. **Let pin-watch rebake the image**, then confirm the box carries the phased script: `docker exec hermes grep -c fluncle-backfill-phased-admission-v1 /opt/hermes-scripts/backfill-sweep.ts` prints a non-zero count. Until step 3 the previous unit keeps running, now in the inherited-lease branch, and its journal summary shows `"admissionMode":"inherited-lease"`.
3. **Refresh only this service** with the roster-derived installer. It reloads systemd without changing the timer's enabled or active state:

   ```bash
   sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-backfill.service
   ```

   If the output lists `fluncle-backfill.service` under `held on fallback`, the image does not carry the phased script yet. Go back to step 2 and rerun this step after the rebake. If it instead exits non-zero with `capability probe unavailable, left unchanged`, the hermes container was not running (for example mid pin-watch swap): the installer wrote neither variant and left the installed unit as it was, so rerun this step once the container is up.

4. **Verify.** `systemctl cat fluncle-backfill.service` shows the `ExecStartPre` capability check and an `ExecStart` that starts `backfill-sweep.sh` directly, with no `database-admission-runner.sh`. Run one attended tick with `sudo systemctl start fluncle-backfill.service`, then read `journalctl -u fluncle-backfill.service -n 80 --no-pager`. Expect runner events with `"owner":"fluncle-backfill"` and `"phase_scoped":true`, one per Worker request, each with a `hold_ms` of that one request, and a summary line with `"admissionMode":"phased"`.

## Deploy (on rave-02, one time)

Install through [`../install-host-timers.sh`](../install-host-timers.sh), never with a bare `install`, so the baked-capability gate above applies. Use a full install for every timer, or just this one:

```bash
sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-backfill.service --refresh-unit fluncle-backfill.timer
sudo systemctl enable --now fluncle-backfill.timer

# Verify.
sudo systemctl start fluncle-backfill.service            # one tick now
journalctl -u fluncle-backfill.service -n 40 --no-pager  # expect a { "ok": true, … } summary line
systemctl list-timers fluncle-backfill.timer
```
