# Hands-off maintenance (the version-drift routine)

A local Claude Code Routine that sweeps Fluncle's pinned/baked supply chain for version drift, ~weekly, hands-off. The brain is [maintenance.prompt.md](maintenance.prompt.md); this file is orientation.

## What it does

Each run, the prompt runs as a Claude Code agent on Opus 4.8: it reads every pin in the `@fluncle-maintenance` inventory (the Nous Research Hermes base image, bun, the `fluncle` CLI, the Claude Code CLI, box.ascii, and the GitHub Actions tags), checks latest for each, judges each drift against the safety doctrine, and then **either** opens a PR with the clearly-safe bumps (letting the CI deploy-gate validate them) **or** reports the drift and pulls the brake with the reason. It does one bounded sweep and stops. It never touches the box, never rebuilds or redeploys, never merges. An empty sweep (nothing drifted) is a quiet one-line no-op. The full per-run contract — the apply-vs-brake rules, the bounded-scope rail, the repo-edit-only rule, the hard rails — lives in the prompt; this file is just orientation.

## Where it runs: a local Claude Code desktop-app Routine on the operator's Mac

The prompt is triggered by a **Claude Code desktop-app Routine** ("Fluncle maintenance") on the operator's Mac — the same Routines mechanism the retired video routine used. This is deliberately **not** mission-critical: a missed week is a non-event (drift accrues slowly; the next run catches it), so a closed laptop is fine. Unlike the video render path — which moved off the Mac to a box conductor precisely because a missed hourly tick backed up the queue — maintenance has no queue and no deadline, so it stays a simple local routine.

The routine needs only a clean Fluncle repo checkout on an up-to-date `main`, plus the operator's normal `git`/`gh` auth (to branch, commit, and open a PR) and network access for the read-only "check latest" calls (`npm view`, `curl`, the Docker Hub / GitHub APIs). It needs **no** box access, **no** secrets, and **no** 1Password — by design, since it only edits committed files and opens a PR.

## The per-run behaviors (what a healthy run does)

1. **Sweeps and finds nothing.** All six pins current → a one-line "all pins current" and exit. No PR, no noise. The common steady-state run.
2. **Finds clearly-safe drift → opens one PR.** A patch/minor `fluncle` or Claude Code CLI bump, a patch/minor bun bump (edited in all three places), or a GitHub Actions SHA-pin → edit the pin(s) on a branch, commit, run the gate locally, open a PR. For any Dockerfile edit the PR flags the **operator rebuild follow-up** (the box runs the old pin until rebuilt). A human merges.
3. **Finds risky drift → pulls the brake.** A major bump, a new Hermes base tag, or anything touching auth/runtime/the model → no bump PR; a report with the current pin, the latest, the drift class, and the reason, so the operator decides and ships it via the bump procedure.

## Operating notes

- **One bounded sweep per run by design.** The weekly cadence is the throttle; the prompt sweeps once and stops. It does not "catch up" months of drift in a single run.
- **The box stays the operator's.** This routine only ever edits committed files and opens a PR. The rebuild + redeploy + smoke-test (the half that reaches the live box) is always an operator step — see `@fluncle-maintenance` `references/bump-procedure.md`.
- **Opus is the safety brake.** There is no human approving a tick, so the prompt applies only what the safety doctrine calls _clearly_ safe and reports everything else. When in doubt, it brakes.
- **Out of scope, on purpose.** The workspace dependency catalog (the `bunfig.toml` `minimumReleaseAge` flow) and the agent's model/voice/permissions are separate flows — the routine mentions drift it notices there but never acts on it.
- **Pause it** by disabling the "Fluncle maintenance" Routine in the Claude Code app. There is no in-repo state to clean up; an in-flight run's only artifact is an open PR, which a human reviews like any other.

## How it's wired in the Claude app

The Routine is a single scheduled entry in the Claude Code desktop app: a ~weekly schedule, a working directory pointed at a Fluncle repo checkout, and a prompt that loads the `@fluncle-maintenance` skill and runs [maintenance.prompt.md](maintenance.prompt.md). Point it at a checkout that stays on a fresh `main` (or have the routine pull first). Nothing else is configured in-repo — the schedule and the working directory live in the app, and the prompt is self-contained.
