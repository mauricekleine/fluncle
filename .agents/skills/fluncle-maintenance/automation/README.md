# Hands-off maintenance (the version-drift routine)

The baked-pin workflow and nightly dependency routine keep their respective inventories current:

1. **`.github/workflows/hermes-pin-drift.yml`** — a GitHub Actions sweep that runs **on every `fluncle` release** (a `workflow_run` trigger on the `Releases` workflow, so a first-party bump reaches the box within minutes) and **hourly** as the backstop (for the external pins — bun, yt-dlp — and any release the event missed to npm-propagation lag). It checks the baked toolchain pins (the `fluncle` CLI, bun, yt-dlp) against their registries and, for a clearly-safe **same-major** bump, opens a PR. bun is the `oven/bun` base image: a bump rewrites the `FROM` tag together with its digest resolved from Docker Hub (and `package.json` `packageManager`), and waits a run when the image is not published yet. The deterministic detect-and-edit is `.github/scripts/hermes-pin-drift.sh`. A **major** bump of fluncle or bun (a bun major is a base-image change) is reported as a GitHub issue, never auto-bumped. On merge of a Dockerfile pin, the rave-02 `fluncle-pin-watch` timer self-deploys it (rebuild → pre-smoke → swap → auto-rollback).
2. **The nightly `mk-dependency-upgrades` routine** uses taze to maintain workspace dependencies and GitHub Actions digests, and reads open Dependabot alerts for supported manifests, Cargo included. Holds and coupled-group guards live in `taze.config.ts`. Dependabot alerts stay enabled; its automated security PRs stay off.

Together they cover the inventory: the workflow owns `fluncle` / `bun` (the base image) / `yt-dlp`; the operator's agent layer owns the Claude Code pin and the managed settings in `docs/agents/hermes/claude-managed-settings.d`, which its sync PR sets together; the nightly routine owns workspace dependencies and Action digests; node, uv, gh, and boat.dev are pinned but manual-watch, deliberately outside the auto-bump.

## The split: bump in CI, deploy on the box

The bump-PR half needs **write credentials** (push a branch, open a PR); the box deliberately holds **none** — `fluncle-pin-watch` is credential-free (a read-only public clone plus the running container's own env). So the two halves live apart on purpose:

- **GitHub Actions / nightly dependency routine** (they have the repo + a token) → open the PR that moves the pin.
- **rave-02 `fluncle-pin-watch`** (credential-free) → deploy the merged pin within the hour.

That keeps the box token-free while the galaxy still self-maintains, **repo AND box**.

## Auth + how far it ships

`hermes-pin-drift.yml` needs the `PIN_DRIFT_TOKEN` repo secret: a fine-grained PAT of the operator's, scoped to this repository with Contents, Pull requests and Issues read/write. The repository does not let the default `GITHUB_TOKEN` open pull requests, and the Hyperspeed reviewer skips any PR whose author or commits are not on its allowlist, so the workflow opens the PR with that token and commits as the token's owner (login and noreply email read from `gh api user`). The PR then triggers CI, gets reviewed, and auto-merges on green. When the secret is empty, the workflow falls back to `GITHUB_TOKEN` and fails at `gh pr create`; the pushed branch stays for a manual PR. The merge is the deploy trigger for a baked Dockerfile pin (pin-watch takes it from there). Dependency PRs follow the normal Hyperspeed review path.

## What the deterministic sweep does NOT decide

The workflow encodes only the _provably_ safe rule — a same-major bump of a first-party / Anthropic CLI or bun. It deliberately does not read release notes or weigh nuance. Anything with real blast radius — a **major** (a bun major is a base-image change), an **auth-shape** change — is a **reported brake** the operator decides and ships via [references/bump-procedure.md](../references/bump-procedure.md). When a sweep genuinely needs judgment beyond semver, run the skill itself by hand: [maintenance.prompt.md](maintenance.prompt.md) is the full Opus-gated pass over the doctrine and the inventory, kept as the manual / deep path (it is not on a schedule).

## Operating notes

- **One bounded sweep per run by design.** The cadence is the throttle — the workflow runs **hourly** (first-party `fluncle` releases ship often, so the box should track them within the hour); the dependency routine runs nightly. Each tick is a cheap check: a no-op when nothing drifted or the open pin-drift PR already carries the same bumps. A pin-drift PR that is stale (different bumps) or conflicting is closed and replaced, so one wedged PR never blocks later ticks.
- **The box self-deploys baked-pin bumps safely.** The on-box `fluncle-pin-watch` timer captures the previous image, pre-smokes the new one before swapping, auto-rolls-back on any failure, and Discord-alerts on deploy or rollback. A same-major bun base bump rides the same path; a bun major is a brake.
- **Determinism is the gate for the automated path.** No human approves a CI tick, so the workflow ships only what semver proves safe (a same-major first-party/Anthropic CLI or bun bump) and reports everything else. A red CI run is never merged.
- **Out of scope, on purpose.** The workspace dependency catalog (the `bunfig.toml` `minimumReleaseAge` flow) and the agent's model/voice/permissions are separate flows — the nightly dependency routine owns workspace dependencies, and neither flow changes agent policy.
- **Pause it** by disabling the workflow (Actions tab) and/or pausing the nightly dependency routine. In-flight artifacts are an open PR (reviewable like any other). Pausing never leaves a half-rebuilt box — neither mechanism touches the live box; only the merge → pin-watch path does.

## The manual deep pass

`maintenance.prompt.md` is the doctrine-complete manual sweep: run it by hand when you want the full judgment pass. It is not scheduled; the CI workflow above is the scheduled mechanism.
