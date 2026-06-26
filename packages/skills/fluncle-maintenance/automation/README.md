# Hands-off maintenance (the version-drift routine)

Two **server-side** mechanisms keep Fluncle's baked supply chain current, hands-off — no laptop, no operator tick:

1. **`.github/workflows/hermes-pin-drift.yml`** — a weekly GitHub Actions sweep. It checks the baked toolchain pins (the `fluncle` CLI, the Claude Code CLI, bun) against their registries and, for a clearly-safe **same-major** bump, opens a PR. The deterministic detect-and-edit is `.github/scripts/hermes-pin-drift.sh`. A **major** bump or a newer Nous Research Hermes **base image** is reported as a GitHub issue, never auto-bumped. On merge of a Dockerfile pin, the rave-02 `fluncle-pin-watch` timer self-deploys it (rebuild → pre-smoke → swap → auto-rollback).
2. **Renovate** (`renovate.json`) — keeps the **GitHub Actions** pinned to commit SHAs and refreshes them (same-major) as the actions ship updates. Scoped to the `github-actions` manager only; it does not touch the app dependency tree or the baked CLIs.

Together they cover the inventory: the workflow owns `fluncle` / `claude-code` / `bun` and the base-image report; Renovate owns the Action digests; box.ascii is unpinnable (pin-watch re-verifies it after any rebuild it does).

## The split: bump in CI, deploy on the box

The bump-PR half needs **write credentials** (push a branch, open a PR); the box deliberately holds **none** — `fluncle-pin-watch` is credential-free (a read-only public clone plus the running container's own env). So the two halves live apart on purpose:

- **GitHub Actions / Renovate** (they have the repo + a token) → open the PR that moves the pin.
- **rave-02 `fluncle-pin-watch`** (credential-free) → deploy the merged pin within the hour.

That keeps the box token-free while the galaxy still self-maintains, **repo AND box**.

## Auth + how far it ships

`hermes-pin-drift.yml` runs on the default `GITHUB_TOKEN` out of the box: it **opens the PR for an operator to review and merge** (CI runs on the operator's interaction with the PR). To make it fully hands-off, add a fine-scoped PAT as the `PIN_DRIFT_TOKEN` repo secret — the PR then triggers CI and is set to **auto-merge on green**. Either way, the merge is the deploy trigger for a baked Dockerfile pin (pin-watch takes it from there). Renovate opens its own PRs as the Renovate GitHub App; **install the app on the repo to activate `renovate.json`** — the config is inert until then.

## What the deterministic sweep does NOT decide

The workflow encodes only the _provably_ safe rule — a same-major bump of a first-party / Anthropic CLI or bun. It deliberately does not read release notes or weigh nuance. Anything with real blast radius — a **major**, the **base image**, an **auth-shape** change — is a **reported brake** the operator decides and ships via [references/bump-procedure.md](../references/bump-procedure.md). When a sweep genuinely needs judgment beyond semver, run the skill itself by hand: [maintenance.prompt.md](maintenance.prompt.md) is the full Opus-gated pass over the doctrine and the inventory, kept as the manual / deep path (it is not on a schedule).

## Operating notes

- **One bounded sweep per run by design.** The weekly cadence (the workflow's cron + Renovate's schedule) is the throttle; a run sweeps once. It does not "catch up" months of drift at once.
- **The box self-deploys baked-pin bumps safely.** The on-box `fluncle-pin-watch` timer captures the previous image, pre-smokes the new one before swapping, auto-rolls-back on any failure, and Discord-alerts on deploy or rollback. The base image is always a brake (its failure mode is the whole gateway — too coarse to ship unattended even with pin-watch's safety net).
- **Determinism is the gate for the automated path.** No human approves a CI tick, so the workflow ships only what semver proves safe (a same-major first-party/Anthropic CLI or bun bump) and reports everything else. A red CI run is never merged.
- **Out of scope, on purpose.** The workspace dependency catalog (the `bunfig.toml` `minimumReleaseAge` flow) and the agent's model/voice/permissions are separate flows — neither mechanism here touches them.
- **Pause it** by disabling the workflow (Actions tab) and/or the Renovate app. In-flight artifacts are an open PR (reviewable like any other). Pausing never leaves a half-rebuilt box — neither mechanism touches the live box; only the merge → pin-watch path does.

## Retired: the local Mac Routine

This sweep previously ran as a **Claude Code desktop-app Routine on the operator's Mac** (driven by `maintenance.prompt.md`). It worked but was laptop-dependent — a closed lid skipped a week — and in practice the **bump-PR half was never actually running**, so the pins drifted while only the box's deploy half (pin-watch) stayed live. It is **retired** in favour of the always-on CI workflow above. `maintenance.prompt.md` is kept as the doctrine-complete manual / deep sweep — run it by hand when you want the full judgment pass, not as the scheduled mechanism.
