# sonar's deploy — the runtime unit + the self-deploy loop

Everything rave-01 needs to run and keep running [`apps/sonar`](../), the in-memory vector-similarity engine behind sonic search, "sounds like these artists", and the log page's more-like-this. Two things live here, and they close two separate gaps.

## Runtime state contract

The runtime service owns two writable libSQL files below the private directory created by `StateDirectory=fluncle-sonar`:

- `SONAR_REPLICA_PATH` points at the embedded source replica. Sonar calls libSQL `Database::sync()` explicitly. No background replica sync interval is configured.
- `SONAR_STATE_PATH` points at a separate consumer database containing exact raw vectors, producer revisions and tombstones, the validated manifest, the local checkpoint, and any pending remote acknowledgement.

The two paths must differ and stay on the service account's local disk. The committed unit creates the directory with mode `0700` and applies `UMask=0077`. The public unit names only environment variables. Concrete credentials and topology remain in the operator-owned environment file.

The service reads `FLUNCLE_API_BASE_URL`, `FLUNCLE_API_TOKEN`, and `SONAR_CONSUMER_ID` for the agent-authenticated `sonar.track@1/1` consumer. `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are replica-sync inputs, not query credentials. Every corpus SELECT runs against `SONAR_REPLICA_PATH`.

The isolated pre-smoke sets `SONAR_VALIDATE_ONLY=true`. It opens and validates the existing local state, builds both indexes, and serves `/health`, but it performs no replica sync, registration, change read, checkpoint, or acknowledgement. The live daemon keeps running during the pre-smoke, so two processes must never advance one consumer or write one state database concurrently.

**Gap 1 — the runtime unit was committed nowhere.** [`sonar.service`](./sonar.service) is what the box actually runs: `User=sonar`, the binary at `/opt/sonar/sonar`, `EnvironmentFile=/etc/sonar.env` (Turso read creds, `SONAR_SECRET`, port, TLS paths — installed `0600 root:root`, never in this repo), `CAP_NET_BIND_SERVICE` so a non-root user can bind 443 for Cloudflare's origin, a strict-ish sandbox, and `MemoryMax=2G` so a runaway index can never squeeze the SSH terminal off the same box. It was living only on the box; now it lives here, where a change to it is reviewable.

**Gap 2 — no self-deploy.** sonar was deployed **by hand**: cross-build the musl binary on a Mac, `scp` it up, restart. So a merge to `main` did not reach the live engine until someone remembered. [`fluncle-sonar-freshen.sh`](./fluncle-sonar-freshen.sh) + its [`.service`](./fluncle-sonar-freshen.service) / [`.timer`](./fluncle-sonar-freshen.timer) close that: a host systemd timer that watches a rolling GitHub Release, verifies the published artifact, pre-smokes it in isolation, swaps it in, and auto-rolls-back on any failure.

This is the **pull model** — the repo is canonical, the box is the deploy target, and the box deploys _itself_ — the sonar sibling of [`apps/ssh/deploy`](../../ssh/deploy) on the same box and of [`docs/agents/hermes/pin-watch`](../../../docs/agents/hermes/pin-watch) on rave-02.

## Why a host timer (not a container / not the app itself)

The `sonar` service can't cleanly replace _its own_ running binary. The swap has to run as a separate host process — a `Type=oneshot` systemd timer on the rave-01 host — exactly like [`fluncle-ssh-freshen`](../../ssh/deploy) beside it and [`pin-watch`](../../../docs/agents/hermes/pin-watch) on rave-02.

## Build model: CI-built artifact (the deliberate divergence from `apps/ssh`)

The SSH terminal's [deploy README](../../ssh/deploy/README.md#build-model-on-box-go-build-and-why-vs-a-ci-built-artifact) argues the opposite of what this one does, and it is right to: it builds **on the box** because a CI-built artifact "would add a whole second moving part … for the sole benefit of keeping the Go toolchain off the edge box", and the Go toolchain is a lone static compiler with no daemon, dormant except for the **~10 seconds** of an actual build.

None of that transfers to Rust. Concretely:

|                                     | `apps/ssh` (Go)                 | `apps/sonar` (Rust)                                                                      |
| ----------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Toolchain on the box                | tens of MB, one static compiler | **~1.5GB** (rustc + cargo + std + the registry cache)                                    |
| Release build                       | **~10s**                        | **~42s on an M5** → **~7–14 min on rave-01's 2 shared vCPUs** (LTO, `codegen-units = 1`) |
| What else is on the box during that | the SSH terminal, DNS, sonar    | the SSH terminal, DNS, **sonar itself**                                                  |

Seven-to-fourteen minutes of both vCPUs pinned at 100%, on the box that is _at that moment_ serving the live SSH terminal, the DNS server, and sonar's own latency-critical scans, in exchange for a build that CI does for free in a cached ninety seconds. So this loop takes the second moving part on purpose: **GitHub Actions builds the static musl binary and publishes it; the box downloads, verifies, and swaps.**

This is a divergence in the build step only. Everything the ssh doctrine is actually about — pull model, credential-free, pre-smoke in isolation before the swap, atomic swap, post-smoke, auto-rollback, Discord alert + `/status` post — is identical, deliberately, line for line.

### The trust boundary

On-box building has one property this loses for free: the box knows the binary is the source, because it compiled it. Pulling an artifact means trusting something it did not build, so that trust is made explicit and mechanical:

- CI publishes three assets to the rolling `sonar-latest` pre-release: **`sonar`** (the binary), **`sonar.sha256`** (its checksum), **`sonar.commit`** (the full commit SHA it was built from).
- The box verifies `sonar.sha256` against the downloaded binary with `sha256sum -c` **before the binary is executed at all**, even in `--dry-run`. A mismatch is a loud, alerting failure and the live service is never touched. No verifier available on the box is _also_ a hard failure — never a silent skip.
- The repo is public, so all three are fetched by plain unauthenticated `curl`. **No GitHub token goes on the box** — the same credential-free posture as the ssh sibling, reached a different way.
- `sonar.commit` — not the git tag, not the asset's timestamp — is the artifact's identity and the only input to "is there anything to do".

The second, independent net is the **pre-smoke**: the box boots the downloaded binary in isolation and refuses to swap unless it actually serves. A corrupt, mis-targeted, or wrong-CPU artifact dies there, with the live engine untouched.

## What a run does (`fluncle-sonar-freshen.sh`)

Default `--if-changed` (the timer); `--force` redeploys unconditionally (the operator pilot); `--dry-run` downloads + verifies + pre-smokes then stops (never swaps).

1. **Single-flight** (flock) — never two runs at once.
2. **Ask what is published.** `GET` the release's `sonar.commit` asset and compare it to the recorded deployed SHA (`/opt/sonar-freshen/deployed-sha`). Equal → no-op, `/status` gets an `ok`, done. (`--dry-run` skips this short-circuit on purpose — it never touches the live service, so previewing the current release stays useful on an up-to-date box.) An unreachable or malformed release feed (CI hasn't published yet, GitHub is having a moment, an HTML error page came back instead of a SHA) is logged, posted as `degraded`, and **exits cleanly** — a broken release feed never becomes a broken box.
3. **Require the current runtime contract.** Before downloading a candidate, verify that the live service environment has the complete local-replica + artifact-consumer configuration. A predecessor still using the remote-query contract or a partially provisioned environment fails loudly with the live service untouched. The binary updater never invents paths, copies credentials, or performs this provisioning migration. There is one explicit transition case: until the freshener has recorded a successful local-state bootstrap, a real deploy may continue to step 6 so Sonar can bootstrap or retry its own derived local state under the committed service. A readable SQLite file is not readiness because a failed bootstrap can create it before committing a manifest. An unmarked readable state therefore gets a validate-only attempt: success proves it complete; failure retries the guarded bootstrap. `--dry-run` refuses an absent or invalid state because it promises no mutation.
4. **Download + VERIFY.** Fetch `sonar` + `sonar.sha256` into a throwaway dir and check the digest (see the trust boundary above). Abort loudly on any mismatch.
5. **Pre-smoke the new binary in isolation before touching the live service.** When durable state exists, boot the candidate on a free high loopback port with TLS disabled and `SONAR_VALIDATE_ONLY=true`, using the live environment's consumer-state path and search secret. Then poll `/health` until it reports `ok`. This proves the binary runs on the CPU, opens the embedded state, validates the durable manifest and raw vectors, builds both indexes, and serves HTTP. It does not open/sync the replica or contact/mutate the artifact consumer. Any failure after the completed-bootstrap marker exists leaves the live service untouched and fails the deploy. Before that marker exists, an invalid partial state follows the retry bridge into step 6. The throwaway process is always reaped because it holds a second full copy of the index in RAM.
6. **Swap** (the only moment the live service changes): snapshot the current binary to `sonar.prev` (the rollback target), atomically rename the new one into place, `systemctl restart sonar`. Replacing the on-disk file under the running process is safe on Linux (the old process holds its inode until restart). The systemd unit and `/etc/sonar.env` are **left untouched** — same contract as the ssh sibling: reuse the already-provisioned env, read nothing from `op`. On the first local-replica deployment, this start performs Sonar's bounded registration, local-replica sync, snapshot attestation, durable build, and activation; any failure enters the same binary rollback rail as an ordinary restart. Only a healthy post-swap service atomically writes the freshener's `local-state-ready` marker, so a crash or rollback before acceptance remains retryable without deleting local files.
7. **Post-swap smoke:** the service is `active` and the live port answers `/health` with `"ok":true`, polled for the same timeout. Before binding the HTTP port, every normal restart validates the durable last-good state and confirms that its exact checkpoint is the artifact consumer's active checkpoint. A valid local manifest left by a crash before activation is rebuilt and reactivated synchronously rather than reported healthy; only then does the background loop resume replica reconciliation and bounded deltas. Each artifact API call has a 10-second connect timeout and a 30-second total request timeout, safely inside the 180-second post-swap budget, so a peer that accepts but stalls makes startup fail and lets systemd's restart policy recover it instead of leaving an active unit without a listener. The loopback TLS probe ignores hostname validation because the origin certificate names the public host, not `127.0.0.1`.
8. **On any post-swap failure → ROLLBACK:** restore `sonar.prev`, restart, confirm healthy, alert loudly. If the rollback itself fails, fire the loudest alert, post `down`, and stop for a human. **The box is never left broken.**

**What a deploy costs the surfaces.** The restart in step 6 takes sonar away for as long as it needs to re-read the corpus (~30s today, growing with it), and again if step 8 rolls back. That is not an outage: every surface routing through sonar treats an unreachable engine exactly like a disabled flag and **falls back to the Turso exact scan**, so results stay correct and only get slower for the length of the reload. Worth knowing before hunting a latency spike that lines up with the timer's hour — and worth remembering when picking that hour, since the fallback path is the slow one the engine exists to replace.

**Every run also reports itself to the run ledger.** The last line of a run's stdout is a JSON summary — `checked`, `produced`, `errors`, `queueDepth`, `gateState`, `expectedIntervalMs` — and it is POSTed to the agent-tier `record_run` op alongside the run's start, end, and exit code. This unit needed it more than most: a self-deploy legitimately deploys nothing for weeks, so `produced == 0` says nothing about its health and only the DENOMINATOR does. `checked` stays **0** until the release feed actually resolves a commit, so a feed that has been unreachable for a week is legible AS blindness rather than as seven quiet successes — and because that path exits 0 on purpose, the failure is COUNTED, so the verdict the Worker derives from the exit code AND the error count does not read green over it. The line states no `ok` of its own: a summary that grades itself is rejected at the edge. `queueDepth` is 1 while a published build is not yet on the box, giving the ledger its `produced == 0 AND queueDepth > 0` alarm; a gated tick that measured nothing reports `null` counters rather than zeros, because "never got to try" and "tried and found nothing" are different facts. The emitter is carried verbatim from [`cron-output.sh`](../../../docs/agents/hermes/scripts/cron-output.sh) (this box shares no bash library with rave-02) and `run-events.test.ts` pins the copies byte for byte — plus, because byte-equality between copies cannot tell you the copies are RIGHT, it resolves the endpoint they POST at against the contract the Worker actually serves.

### Diagnose a `never reported` self-deploy

Read the run ledger before treating the public `self-deploy-sonar` row as a status-only problem:

```bash
fluncle admin telemetry read --unit fluncle-sonar-freshen --since 72h --json
```

Rows prove the timer reached this script: quote the newest row's `exitCode` and `summaryRaw`, then diagnose the facts it reported. No rows across several hourly cadences means the self-deploy path has supplied no evidence that it runs; do not call that cosmetic. Check the unit journal and timer state. If the committed timer file is already installed at `/etc/systemd/system/fluncle-sonar-freshen.timer` and activation is the only missing step, the exact operator command on rave-01 is:

```bash
sudo systemctl enable --now fluncle-sonar-freshen.timer
```

Installing or activating the unit is an operator action, never part of a repository diagnosis. The full one-time install and pilot remain below.

**`gateState` speaks the ledger's own closed vocabulary** — `active` / `disabled` / `dry-run` / `forced` / `locked` / `paused`, the `run_events.gate_state` enum — not words of this script's invention, because the Worker rejects an unknown one and a rejected POST leaves no row at all. Two ticks are gated, and they take DIFFERENT words on purpose. A run that finds the flock held says `locked`: it looked at nothing, so its counters are `null` too. A `--dry-run` says `dry-run`: it verifies and pre-smokes and then deliberately leaves the build undeployed, so its `produced:0` beside `queueDepth:1` is an operator's choice rather than a stalled box. The distinction is load-bearing rather than cosmetic — the Worker nulls the work counters of the gates that NEVER LOOKED (`disabled` / `locked` / `paused`) and keeps them for the ones that did, so spelling a dry run `paused` would throw away the `checked:1` proving it read the release feed. `--force` is **not** gated at all: it is a real deploy that really swaps, and gating it would erase the `produced:1` that proves the swap happened — nor can it raise a false alarm, since a forced swap ends `produced:1, queueDepth:0`.

Discord alerts (deploy / rollback / failure) use `DISCORD_ALERT_WEBHOOK` from the optional env file. Every run also reports a **`self-deploy-sonar`** health check to the public [`/status`](https://www.fluncle.com/status) board (POST `/api/v1/admin/health`, agent tier) — beside `self-deploy-ssh` from the same box: `ok` when current or freshly deployed, `degraded` when a download/verify/pre-smoke failed or a swap was rolled back (the engine is healthy on the prior binary, a human should look), `down` if a rollback itself failed. Both the alert and the status post are best-effort and public-safe (no host, no raw error). The shared status read synthesizes `never reported` when this expected writer has no row, and degrades an existing row after three missed hourly reports, so a missing token or stopped timer cannot leave the automation absent or green.

The host unit executes the freshen directly rather than entering primary-database admission. Fetch, verify, smoke, swap, and rollback are control-plane work that must continue during a database outage; the small receipt-backed `/status` post is optional telemetry and never authorizes suppressing that payload.

## Memory: the pre-smoke holds a SECOND index

sonar's whole point is that the corpus lives in RAM, and for the length of the pre-smoke there are **two** of them: the live service's and the throwaway one. **Box headroom must exceed 2× the index.** Today (~15k embedded tracks × 1024-dim f32 ≈ 4KB/vector ⇒ roughly 60MB of vectors per copy) that is comfortable. As the corpus grows toward catalogue scale (~150k tracks ⇒ ~600MB per copy, ~1.2GB for the pair before process overhead) it stops being free — re-check it then, and note that the unit's `MemoryMax=2G` caps the **live** service only, not the freshen's throwaway child, so the box's own free RAM is the real ceiling. When the pair no longer fits, the fix is to move the pre-smoke off the hot path (smoke on a scratch host, or accept a stop-then-start window), not to drop it.

The timer is deliberately off-beat from the box's other schedules for the same reason: `fluncle-ssh-freshen` starts at `OnBootSec=5min` with 90s of jitter and the watchdog runs every ~10min, so this one uses `OnBootSec=11min` with a 7-minute randomised window. Two self-deploys smoking a service simultaneously would fight for the box's two vCPUs.

## Upgrade from the remote-query runtime

The local-replica release changes the runtime contract as well as the binary. The freshener deliberately does not edit `/etc/sonar.env` or install `sonar.service`, so upgrade the contract before asking it to swap the binary. Existing values are reused; this transition does not require rotating a credential.

| Input                  | Upgrade source                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `TURSO_DATABASE_URL`   | Preserve the existing service value. This is private topology, not a new credential.                  |
| `TURSO_AUTH_TOKEN`     | Preserve the existing read credential.                                                                |
| `SONAR_SECRET`         | Preserve the existing search credential.                                                              |
| `FLUNCLE_API_BASE_URL` | The public Worker base; non-secret and derivable.                                                     |
| `FLUNCLE_API_TOKEN`    | Reuse the existing agent-scoped box token through the private runbook; never print or rotate it here. |
| `SONAR_CONSUMER_ID`    | Choose one stable deployment identity and never rename it between restarts.                           |
| `SONAR_REPLICA_PATH`   | A local file below the private directory owned by `StateDirectory=fluncle-sonar`.                     |
| `SONAR_STATE_PATH`     | A different local file below that same private directory.                                             |

The attended order is:

1. Capture the timer's enabled/active state, stop only `fluncle-sonar-freshen.timer`, and leave the running Sonar process serving.
2. Install the committed `sonar.service`, atomically provision the complete environment above through the private runbook, and run `systemctl daemon-reload`. Preserve the existing bind, port, TLS, Turso, and search-secret values.
3. Restart the still-old binary once under the current unit and verify `/health`. The old binary ignores the added local-runtime inputs; this restart materializes the systemd-owned private state directory before the new binary needs it.
4. Install the current freshener and start one attended real run. With a complete contract and no state file, it downloads and checksum-verifies the candidate, then uses the guarded swap as the one-time bootstrap: the new service registers its artifact consumer, syncs the local replica, attests and builds durable state, activates, and must answer `/health` before the deploy is accepted. Any failure restores the old binary and proves it healthy.
5. Run `--dry-run` after the successful swap. State now exists, so this second pass must execute the ordinary isolated `SONAR_VALIDATE_ONLY=true` pre-smoke.
6. Restore the timer to its captured state and verify a finite next elapse plus a successful ledger row.

Do not reverse steps 2 and 4. A binary swap against the predecessor's environment cannot start the current runtime, and an empty-state `--dry-run` cannot truthfully validate a state that does not exist.

## Install (on rave-01, one time)

No pre-req beyond what the box already has: `curl`, `flock`, `sha256sum`, `systemctl`. **No Rust toolchain** — that is the whole point of the CI-built model.

```bash
# 1. The runtime unit (if the box is still on a hand-installed copy, this makes the
#    committed one canonical; it is byte-identical to what is deployed today).
sudo install -m 0644 apps/sonar/deploy/sonar.service /etc/systemd/system/

# 2. The self-deploy script at its deployed path.
sudo install -D -m 0755 apps/sonar/deploy/fluncle-sonar-freshen.sh \
  /opt/sonar-freshen/fluncle-sonar-freshen.sh

# 3. (Optional) The 0600 operator env file for the Discord alert + /status post.
#    Keys: DISCORD_ALERT_WEBHOOK, FLUNCLE_API_TOKEN
#    (values in the ops runbook note —
#    the same pair the ssh freshen and the watchdog use). Skip this and the self-deploy
#    still runs, just without Discord/status visibility.
sudo install -d -m 0755 /etc/fluncle
sudo install -m 0600 /dev/null /etc/fluncle/sonar-freshen.env
sudo "$EDITOR" /etc/fluncle/sonar-freshen.env

# 4. When completed durable state already exists, rehearse first: download, verify,
#    pre-smoke, and STOP. A first local-state bootstrap intentionally skips this step;
#    follow the attended upgrade order above and run --dry-run after the real pilot.
sudo /opt/sonar-freshen/fluncle-sonar-freshen.sh --dry-run

# 5. The real pilot: deploy the published build and prove the swap + post-smoke.
sudo /opt/sonar-freshen/fluncle-sonar-freshen.sh --force

# 6. Install the units, reload, enable + start the timer.
sudo install -m 0644 apps/sonar/deploy/fluncle-sonar-freshen.service /etc/systemd/system/
sudo install -m 0644 apps/sonar/deploy/fluncle-sonar-freshen.timer \
  /etc/systemd/system/fluncle-sonar-freshen.timer
sudo systemctl daemon-reload
sudo systemctl enable --now fluncle-sonar-freshen.timer

# Verify.
sudo systemctl start fluncle-sonar-freshen.service   # one --if-changed run now
journalctl -u fluncle-sonar-freshen.service -n 60 --no-pager
systemctl list-timers fluncle-sonar-freshen.timer
```

After the first successful bootstrap, re-run `--dry-run` any time to preview without touching the live service. The script is idempotent and a no-op when current, so the timer is safe to run as often as you like.

## Knobs

Everything is overridable via the environment; the defaults are the canonical deploy paths.

| Env var                             | Default                    | Meaning                                                                                                  |
| ----------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `SONARFRESHEN_RELEASE_REPO`         | `mauricekleine/fluncle`    | The public repo carrying the release.                                                                    |
| `SONARFRESHEN_RELEASE_TAG`          | `sonar-latest`             | The rolling pre-release tag CI publishes to.                                                             |
| `SONARFRESHEN_ASSET_BASE`           | derived from the two above | Full asset download base (point this at a mirror if ever needed).                                        |
| `SONARFRESHEN_STATE_DIR`            | `/opt/sonar-freshen`       | Holds `deployed-sha`.                                                                                    |
| `SONARFRESHEN_BOOTSTRAP_READY_FILE` | derived from state dir     | Marker written only after a healthy post-swap local-state bootstrap; override for tests/provisioning.    |
| `SONARFRESHEN_SERVICE`              | `sonar`                    | The systemd unit to restart.                                                                             |
| `SONARFRESHEN_APP_BIN`              | `/opt/sonar/sonar`         | The binary to swap.                                                                                      |
| `SONARFRESHEN_SERVICE_ENV`          | `/etc/sonar.env`           | Read-only source of local-state paths, replica open credentials, search secret, and live port/TLS shape. |
| `SONARFRESHEN_BOOT_TIMEOUT_SECS`    | `180`                      | How long an index load may take, pre-smoke and post-swap alike.                                          |
| `SONARFRESHEN_WORKER_URL`           | `https://www.fluncle.com`  | Where the `/status` health post goes.                                                                    |

Operator env file (`/etc/fluncle/sonar-freshen.env`, optional, `0600`, kept out of the repo): `DISCORD_ALERT_WEBHOOK`, `FLUNCLE_API_TOKEN`.

## The CI half

[`cli-release.yml`](../../../.github/workflows/cli-release.yml). Starts only after the generic Quality Checks run for the exact pushed `main` SHA succeeds and the selector finds `apps/sonar/**` changes since `sonar-latest`; `workflow_dispatch` can re-publish an exact SHA that already has that validation. Nothing is published until `apps/sonar`'s `cargo fmt --check`, `clippy`, release build, and `cargo test` pass — the box only ever self-swaps onto a gated binary. The release leg builds `x86_64-unknown-linux-musl` (native-arch, different-libc on the ubuntu runner, so `rustup target add` + `musl-tools` is the whole story — no cross container) with `RUSTFLAGS: -C target-cpu=x86-64-v3`, which unlocks AVX2 + FMA in the scan kernel. That is not a micro-optimisation here: sonar is a brute-force dot-product scan over the entire corpus, so SIMD width **is** the latency, and rave-01 is AMD EPYC-Rome (Zen 2) with AVX2 + FMA confirmed. If that assumption ever broke — a box migration to older silicon — the binary would `SIGILL` on first execution, and the box-side pre-smoke catches exactly that before any swap.

Then it moves the rolling `sonar-latest` tag to the built commit and uploads the three assets with `--clobber`.
