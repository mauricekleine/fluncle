# Hands-off maintenance (the version-drift routine)

A local Claude Code Routine that sweeps Fluncle's pinned/baked supply chain for version drift, ~weekly, hands-off, and ships the clearly-safe bumps **end-to-end**. The brain is [maintenance.prompt.md](maintenance.prompt.md); this file is orientation.

## What it does

Each run, the prompt runs as a Claude Code agent on Opus 4.8: it reads every pin in the `@fluncle-maintenance` inventory (the Nous Research Hermes base image, bun, the `fluncle` CLI, the Claude Code CLI, box.ascii, and the GitHub Actions tags), checks latest for each, judges each drift against the safety doctrine, and then **either** ships the clearly-safe bumps end-to-end — open a PR, wait for CI green, **merge** — **or** reports the drift and pulls the brake with the reason. For a baked Dockerfile pin, the routine's job ends at the merge: the on-box `fluncle-pin-watch` timer (rave-02) self-deploys it (rebuild → pre-smoke → swap → auto-rollback; `docs/agents/hermes/pin-watch/`). The routine never touches the box. It does one bounded sweep and stops. An empty sweep (nothing drifted) is a quiet one-line no-op. The full per-run contract — the SHIP-vs-BRAKE rules, the mid-flight stop points, the hard rails — lives in the prompt; this file is just orientation.

## Where it runs: a local Claude Code desktop-app Routine on the operator's Mac

The prompt is triggered by a **Claude Code desktop-app Routine** ("Fluncle maintenance") on the operator's Mac. This is deliberately **not** mission-critical: a missed week is a non-event (drift accrues slowly; the next run catches it), so a closed laptop is fine. Maintenance has no queue and no deadline, so it stays a simple local routine.

The routine needs: a clean Fluncle repo checkout on an up-to-date `main`; the operator's `git`/`gh` auth (to branch, commit, open AND **merge** the PR); network for the read-only "check latest" calls (`npm view`, `curl`, the Docker Hub / GitHub APIs). That is all. The routine **never** SSHes to the box, runs `docker`, or touches `op` — the box self-deploys baked-pin bumps via its on-box `fluncle-pin-watch` timer. **The routine's blast radius is GitHub only** (open + merge a PR); it does not reach the live box.

## The per-run behaviors (what a healthy run does)

1. **Sweeps and finds nothing.** All six pins current → a one-line "all pins current" and exit. No PR, no box step, no noise. The common steady-state run.
2. **Finds clearly-safe drift → ships it end-to-end.** A patch/minor `fluncle` or Claude Code CLI bump, a patch/minor bun bump (all three places), or a GitHub Actions SHA-pin → edit on a branch, run the gate locally, open a PR, **wait for CI green, merge**. That is the routine's delivery. For a baked Dockerfile pin (the CLIs), the on-box `fluncle-pin-watch` timer then picks it up — rebuild → pre-smoke → swap → auto-rollback — within the hour. SHA-pins / `package.json` / workflow edits are fully repo-side and ship on the merge alone.
3. **Finds risky drift → pulls the brake.** A major bump, a new Hermes base tag, or anything touching auth/runtime/the model → no merge; a report with the current pin, the latest, the drift class, and the reason, so the operator decides and ships it via the bump procedure.

## Operating notes

- **One bounded sweep per run by design.** The weekly cadence is the throttle; the prompt sweeps once and stops. It does not "catch up" months of drift in a single run.
- **The box self-deploys baked-pin bumps safely.** The on-box `fluncle-pin-watch` timer captures the previous image, pre-smokes the new one before swapping, auto-rolls-back on any failure, and Discord-alerts on deploy or rollback. The base image is always a brake (its failure mode is the whole gateway — too coarse to ship unattended even with pin-watch's safety net).
- **Opus is the gate — for stopping and continuing.** There is no human approving a tick, so the prompt takes only what the safety doctrine calls _clearly_ safe all the way, and stops the instant a CI check goes red. When in doubt, it stops.
- **Out of scope, on purpose.** The workspace dependency catalog (the `bunfig.toml` `minimumReleaseAge` flow) and the agent's model/voice/permissions are separate flows — the routine mentions drift it notices there but never acts on it.
- **Pause it** by disabling the "Fluncle maintenance" Routine in the Claude Code app. In-flight artifacts are an open/merged PR (reviewable like any other). Pausing never leaves a half-rebuilt box — the routine never touches the box.

## How it's wired in the Claude app

The Routine is a single scheduled entry in the Claude Code desktop app: a ~weekly schedule, a working directory pointed at a Fluncle repo checkout, and a prompt that loads the `@fluncle-maintenance` skill and runs [maintenance.prompt.md](maintenance.prompt.md). Point it at a checkout that stays on a fresh `main` (or have the routine pull first), and ensure its permission mode allows the unattended `git`/`gh` operations it needs. Nothing else is configured in-repo — the schedule and the working directory live in the app, and the prompt is self-contained.
