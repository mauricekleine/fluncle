# fluncle-pin-watch — the box self-deploy

The rave-02 (Hermes box) half of the version-currency loop. The [`fluncle-maintenance`](../../../../packages/skills/fluncle-maintenance) routine sweeps the pinned supply chain, opens a clearly-safe bump as a PR, and merges it on green — and then **stops**. This is what closes the loop: a small host systemd timer on rave-02 that watches `main` and, when a baked CLI pin **or the baked content** moves ahead of what the running container has, rebuilds the Hermes image and swaps the container — with a pre-smoke gate and an auto-rollback rail.

## The dual trigger: pins AND baked content

A run rebuilds when **either** signal drifts from `main`:

1. **The CLI pins** — the `fluncle` binary release version + the `@anthropic-ai/claude-code@` pin in the Dockerfile, read off the running container (`fluncle version` / `claude --version`).
2. **The baked content** — a git-tree fingerprint (`git ls-tree -r HEAD`) of the paths the image COPYs from `main`: the sweep scripts (`docs/agents/hermes/scripts`), the `Dockerfile` itself, and the two skills the box runs (`packages/skills/fluncle-track-enrichment/scripts` + `packages/skills/copywriting-fluncle`). The build stamps this fingerprint into the image at `/opt/.hermes-baked-fp`; each run compares the running image's stamp against `main`'s.

**Why the second signal exists.** The image bakes the sweep scripts and skills, but a **script-only change does not move a CLI pin** — so before this, such a change never reached the box. We hit exactly that: a just-merged bio-cron safety guard sat undeployed while the live cron ran the old script. The fingerprint closes that gap: any content change under the baked paths moves the hash, so the next hourly tick rebuilds and stamps the new fingerprint. An **empty** stamp (an image built before the fingerprint existed) counts as drift too, so the mechanism is self-healing on first deploy.

The fingerprint is a **git-tree** hash, not a `find | sha256sum` of the container filesystem: `git ls-tree -r` is deterministic and immune to filesystem-state noise (timestamps, chmod), so it can never false-positive into an every-hour rebuild loop. It reads only `HEAD`'s tree, so it is safe on the depth-1 shallow clone at `/opt/fluncle-build` (which has no history to diff against).

**The one residual gap (honest).** The fingerprint only covers the paths in `BAKED_PATHS`. A change to a baked path **not** in that list — e.g. `apps/cli/assets/fonts/`, or a skill outside the two listed — still needs a manual `sudo /opt/fluncle-pin-watch/rebuild-hermes.sh --force`. Add the path to `BAKED_PATHS` if it becomes a routinely-changing baked input.

This is the **pull model**: the repo is canonical, the box is the deploy target, and the box deploys _itself_ — the same self-heal shape the box already uses for enrich / observe / the render conductor. It means the maintenance routine never needs SSH, `op`, or box access, so it can run anywhere (Claude Desktop today, the cloud tomorrow).

## Why it's a host timer, not a Hermes cron

A container can't cleanly rebuild and replace _itself_. The rebuild has to run on the **host** (which owns the Docker daemon), so this is a systemd timer on the rave-02 host — the same pattern as the rave-01 [`fluncle-rave-watchdog`](../../../../apps/ssh/watchdog). The Hermes-container crons (enrich/observe/render) do _app_ work; this does _infra_ work.

## Serializing the rebuild against the sweeps

The rebuild is docker-heavy: a `docker build` plus a fistful of throwaway `--rm` pre-smoke `docker run`s, then the container swap. rave-02 also runs the recurring **sweep timers** (`fluncle-embed`, `fluncle-enrich`, `fluncle-label-lineage`, … — each a `*-timer` that fires its own `docker run`). When a sweep fires _during_ a rebuild, the daemon contention (buildkit's "only one connection allowed", the rapid pre-smoke container create/delete churn) **SIGKILLs the sweep container (exit 137)** — confirmed on rave-02, and confirmed **not** an OOM (no kernel OOM log, RAM free, the sweep died seconds after starting). It self-heals on the next tick, but every rebuild that overlaps a sweep (~daily) throws a false failure alarm and burns a wasted tick.

So the rebuild **quiesces the sweeps** for its docker-heavy section. Immediately before the first `docker build` (i.e. _after_ the drift decision — a no-op `--if-stale` run never touches a timer; `--dry-run` does, because it still builds + pre-smokes):

- **Stop the active sweep timers.** They are enumerated **dynamically** — `systemctl list-units --type=timer --state=active … 'fluncle-*.timer'` — so a newly-added sweep is covered automatically, with **two exclusions**: `fluncle-healthcheck.timer` (the dead-man's-switch beacon must keep pinging `/status` through the rebake) and pin-watch's own timer (never stop the timer that scheduled this run — it is `pin-watch.timer`, already outside the `fluncle-*` glob, and is excluded defensively in case it is ever renamed).
- **Drain any sweep already mid-run.** After stopping the timers, it polls each stopped timer's `.service` twin (`systemctl is-active --quiet`) and waits — bounded to `PINWATCH_SWEEP_DRAIN_TIMEOUT` (default 300s) — so the rebuild does not kill a sweep that was already running. On timeout it logs and proceeds (a rare stuck sweep must not block the rebuild forever).
- **Guarantee the restart.** An `EXIT` trap (composed with the existing tmpfs-env cleanup trap) restarts **exactly** the timers it stopped, best-effort (`|| true` per timer, so one failing start never strands the rest). Because it rides the `EXIT` trap, it fires on success, on `die()`, on a build/pre-smoke failure, **and on the auto-rollback path** — a failed or rolled-back rebuild never leaves the box with its sweeps disabled, which would be worse than the bug it fixes.

The quiesce is a no-op when there are no active sweep timers, and the whole mechanism only engages once a rebuild is actually committed to.

## Credential-free by design

It puts **no token on the box** and reads nothing from `op`:

- **Build context:** the Fluncle repo is public, so the clone at `/opt/fluncle-build` needs no key.
- **Secrets:** the new container reuses the **running container's own runtime env**, captured via `docker inspect` (the container's env minus the image's baked `ENV` = the `--env-file` vars). That capture lives only in a `tmpfs` file for the duration of the swap; nothing is written to host disk persistently, and no secret is ever read from `op`. (The values are already on the box — they were `op read` into the container's env at the last operator deploy.)

The one credential the box does NOT hold is the op service-account token, on purpose: the box never needs to _read_ a secret, only to _carry forward_ the ones it already runs with. (If a future need arises to rotate secrets on the box, that's the only thing that would want a read-only, scoped service token — see the maintenance skill's note.)

## What a run does (`rebuild-hermes.sh`)

Default `--if-stale` (the timer); `--force` runs it unconditionally (the operator pilot).

1. **Single-flight** (flock) — never two rebuilds at once.
2. **Sync** the public repo into `/opt/fluncle-build` (clone or fetch + hard-reset to `origin/main`).
3. **Compare pins AND baked content:** the `fluncle` binary release-URL version + the `@anthropic-ai/claude-code@` pin in `docs/agents/hermes/Dockerfile` vs the running container's `fluncle version` / `claude --version`, AND the baked-content fingerprint on `main` (`git ls-tree -r HEAD` over `BAKED_PATHS`) vs the running image's stamp at `/opt/.hermes-baked-fp`. Both current → **no-op**; either drifted (or an empty stamp) → rebuild. The base image (`FROM`) is _not_ watched — a base bump stays a manual operator brake.
4. **Capture** the running container's runtime env into a `0600` tmpfs file (the rollback-reversibility step) + record the current image as the rollback target.
5. **Quiesce the sweep timers** (only once a rebuild is committed to — see [§ Serializing the rebuild against the sweeps](#serializing-the-rebuild-against-the-sweeps)): stop the active `fluncle-*.timer` sweeps, drain any sweep already mid-run, and arm an EXIT trap that **guarantees** they are restarted on every exit path.
6. **Build** the new image (`fluncle-hermes:v<date>-<sha>`), repo-root context, `-f docs/agents/hermes/Dockerfile`.
7. **Pre-smoke the NEW image in throwaway `--rm` containers — before the live one is touched:** `fluncle version` == the pin; `claude --version` == the pin; an agent-token read returns `{ok:true}`; a publish-class command is **refused** (role boundary intact). Any failure → abort, alert, **the live box is never touched**.
8. **Swap** (the only moment the live container changes): stop+rm, `docker run` the new image with the captured env + the canonical `§ Run` flags.
9. **Post-swap smoke:** the gateway is `Running` and `fluncle` answers.
10. **On any post-swap failure → ROLLBACK:** restore the previous image, confirm it's up, alert loudly. If the rollback itself fails, fire the loudest alert and stop for a human. **The box is never left broken.**
11. **Restore the sweep timers** (the EXIT trap from step 5): whether the run deployed, aborted, or rolled back, the stopped timers are started again before the process exits.

Discord alerts (deploy / rollback / failure) use the `DISCORD_ALERT_WEBHOOK` already in the container's env — no config file.

Every run also reports a **`self-deploy` health check** to the public [`/status`](https://www.fluncle.com/status) board (POST `/api/admin/health`, agent tier) so the self-maintenance loop is visible alongside the other services: `ok` when current or freshly deployed, `degraded` when a bump failed to build / pre-smoke or was rolled back (box healthy on the prior tools, a human should look), `down` if a rollback itself failed. It reuses the **agent token already in the container's env** (the same one the pre-smoke read uses) — no token on disk, none from `op` — and the message is public-safe and deliberately vague (no host, no tool VERSIONS — those are internal — and no raw error; the version detail rides only the operator-only Discord alerts). If the timer ever stops, the row simply goes stale on `/status`, which is itself the signal that the box may be silently drifting.

## Deploy (on rave-02, one time)

```bash
# 1. Drop the script (0755) at its deployed path.
sudo install -D -m 0755 docs/agents/hermes/pin-watch/rebuild-hermes.sh \
  /opt/fluncle-pin-watch/rebuild-hermes.sh

# 2. Clear any accumulated debt + validate the recipe end to end (the pilot).
sudo /opt/fluncle-pin-watch/rebuild-hermes.sh --force

# 3. Install the timer.
sudo install -m 0644 docs/agents/hermes/pin-watch/pin-watch.service /etc/systemd/system/
sudo install -m 0644 docs/agents/hermes/pin-watch/pin-watch.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pin-watch.timer

# Verify.
sudo systemctl start pin-watch.service     # one --if-stale run now
journalctl -u pin-watch.service -n 40 --no-pager
systemctl list-timers pin-watch.timer
```

The script is idempotent and a no-op when current, so the timer is safe to run as often as you like.

## Testing the rollback rail

The rollback rail is the safety net (it restores the previous image if a future bump passes pre-smoke but then fails to come up). Drill it without putting the box at risk: `PINWATCH_TEST_FAIL_POSTSMOKE=1` forces the _first_ (post-swap) health check to fail exactly once — the box swaps to the freshly-built image, "fails", and is restored to the previous image (the second health check, the rollback's own, runs for real). Both images are known-good, so the gateway stays healthy throughout; it just exercises the recovery path end to end.

```bash
sudo env PINWATCH_TEST_FAIL_POSTSMOKE=1 /opt/fluncle-pin-watch/rebuild-hermes.sh --force
```

Expect: `swapping … -> <new>` → `TEST: forcing this post-swap smoke to fail` → `rolling back to <previous>` → `FATAL: rolled back …` (a rollback exits non-zero by design), a `↩️ ROLLED BACK` Discord alert, and `docker ps` back on the previous image, healthy. Verified live 2026-06-25.

Because the drill walks the real rollback path, it also posts a `degraded` `self-deploy` check, so the [`/status`](https://www.fluncle.com/status) row shows amber until the next hourly tick (or a manual `sudo /opt/fluncle-pin-watch/rebuild-hermes.sh`) posts `ok` again. That's expected — the box itself stays healthy throughout.
