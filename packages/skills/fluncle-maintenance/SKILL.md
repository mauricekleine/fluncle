---
name: fluncle-maintenance
description: "Keep Fluncle's pinned/baked supply chain current — the version-drift sweep over the Hermes image's pins (the Nous Research Hermes base image, bun, the fluncle CLI, the Claude Code CLI), the box.ascii render-box CLI, and the GitHub Actions tags. Ships the clearly-safe bumps END-TO-END: edit the pin, open a PR, wait for CI green, merge. For a baked Dockerfile pin the routine's job ends at the merge — the on-box fluncle-pin-watch timer (rave-02) self-deploys it (rebuild → pre-smoke → swap → auto-rollback). Brakes (reports, never ships) on anything risky — a major bump, the base image, or auth/runtime/model. Use whenever checking for version drift, bumping a pinned Hermes dependency, deciding whether a base-image / CLI / Actions-tag bump is safe, SHA-pinning the workflow actions, merging a safe bump, or running the weekly maintenance routine. NOT for the workspace dependency catalog freshness pass (the bunfig minimumReleaseAge flow), and NOT for changing what the agent may do or its voice (the fluncle-hermes-operator skill)."
---

# Fluncle maintenance

Fluncle's runtime supply chain is **pinned and baked**: the Hermes box runs a Docker image that pins an upstream base plus a small toolchain (bun, the `fluncle` CLI, the Claude Code CLI), and CI runs GitHub Actions referenced by tag. Pins do not float — that is deliberate (a reproducible box, a layer-cache bust on every bump) — so they go stale silently. This skill is the **drift sweep** that keeps them current: read each pin, check latest, and either ship a clearly-safe bump **end-to-end** or report the drift and pull the brake. The galaxy should self-maintain — repo AND box.

This file is the doctrine and the decision map. The drift surface (file:line + current pin + a "check latest" one-liner + how to bump) lives in [references/version-inventory.md](references/version-inventory.md); the merge procedure in [references/bump-procedure.md](references/bump-procedure.md); the Opus-as-gate rules in [references/safety-doctrine.md](references/safety-doctrine.md). The hands-off weekly routine that runs all of this lives in [automation/](automation/).

## What this covers (and what it does not)

**In scope — the pinned/baked runtime supply chain:**

- The **Nous Research Hermes base image** the agent runs on (`docs/agents/hermes/Dockerfile`).
- **bun** — baked into the image AND mirrored in the repo's `package.json` `packageManager` (and the CI workflows). One version, three places; they move together.
- The **`fluncle` CLI** baked into the image (`npm -g`).
- The **Claude Code CLI** baked into the image (`npm -g`).
- **box.ascii CLI** — the render box's transport. Pre-1.0, self-updating, **unpinnable** (the installer offers no version). Not a pin to bump; a thing to **re-verify** after a base rebuild.
- The **GitHub Actions** mutable tags in `.github/workflows/` (`actions/checkout@v6`, `oven-sh/setup-bun@v2`, …) — a `.deepsec` scan flags these as a supply-chain risk and recommends SHA-pinning.

**Out of scope (separate flows — reference, do not duplicate):**

- **The workspace dependency catalog freshness.** The repo's app/package deps live in `package.json` `workspaces.catalog` + each package's deps, governed by the `bunfig.toml` `minimumReleaseAge` (3-day) policy. Bumping those is a different, larger pass with its own gate — not this skill. This skill touches the **runtime pins** (the image + Actions), not the app dependency tree.
- **What the agent may do, its model, or its voice.** Those levers are the **`fluncle-hermes-operator`** skill (Worker role guards, `config.yaml`, `SOUL.md`). This skill only keeps the _toolchain versions_ current. The `fluncle-hermes-operator` skill is the reference for the box's run/smoke mechanics that the on-box pin-watch encodes; the maintenance routine does not drive those mechanics.

## The mental model: pins are deliberate, drift is silent, Opus is the gate

Three facts shape every decision here:

1. **The pins are intentional.** Floating `latest` would make the box non-reproducible and would mean an upstream push silently changes the runtime. So the box pins everything (Hermes is pre-1.0; pin the whole toolchain). The cost of pinning is that nobody is told when a newer, safer version ships — hence this sweep.
2. **The repo is canonical; the box is a deploy target — and for a baked pin the merge IS the deploy trigger.** Every bump is an edit to a committed file (the `Dockerfile` pin, or a workflow file), reviewed in git, merged once CI is green. For a baked Dockerfile pin, the routine's job ends at the merge: the on-box `fluncle-pin-watch` timer (rave-02) watches `main`, rebuilds the image, pre-smokes it (versions + an agent read + the role boundary) BEFORE touching the live container, swaps, post-smokes, and **auto-rolls-back on any failure** — Discord-alerting on deploy or rollback. You never hand-edit the running box as the source of truth; the box self-deploys from `main` (`docs/agents/hermes/pin-watch/`). The rebuild, smoke, rollback, and single-flight are the pin-watch script's job, not the routine's.
3. **Running on Opus 4.8, your judgment IS the gate — for stopping AND for continuing.** There is no human in the loop on a routine tick. So you decide, conservatively, both _whether to bump_ and _how far to carry it_: a clearly-safe bump you take all the way to the merge; anything with real blast radius — a major bump, the pre-1.0 churn of the base image, anything touching auth/runtime/the model — you **stop before merge** and report. And you stop MID-FLIGHT on a CI failure: a red CI run is not merged. A missed bump is a non-event; a bad baked-pin merge that the pin-watch pre-smoke catches is also caught safely — the box auto-rolls-back and alerts. **When unsure, you stop.** The asymmetry is the whole doctrine.

## The drift sweep (what a tick does)

The whole loop, bounded to one pass:

1. **Read every pin** — the inventory's file:line table. Record the current pin for each.
2. **Check latest** — run each inventory "check latest" one-liner. Compute the drift (none / patch / minor / major) per item.
3. **Judge** per [references/safety-doctrine.md](references/safety-doctrine.md). Classify each drifted item as **SHIP** (clearly safe — take it end-to-end) or **BRAKE** (risky — report, never ship).
4. **For the SHIP items — carry them all the way:**
   1. Edit each safe pin on a branch, run the local gate, open ONE PR (the auditable artifact + the CI gate).
   2. **Wait for the PR's CI to go green** (the deploy-gate + gitleaks + the Cloudflare build). A **red** check → do NOT merge; drop those items back to a report and leave the PR for a human.
   3. **Merge** the green PR (squash). That is the routine's delivery.
   4. **If the merged change includes a baked Dockerfile pin** (a `fluncle`/Claude Code CLI bump): the merge IS the deploy trigger — the routine does nothing further. The on-box `fluncle-pin-watch` timer (rave-02) detects the new pin on `main`, rebuilds the image, pre-smokes it (versions, an agent-tier `{ok:true}`, a publish-class 403) BEFORE touching the live container, swaps, post-smokes, and **auto-rolls-back on any failure**, Discord-alerting on deploy or rollback. (`docs/agents/hermes/pin-watch/`.)
   5. Fully-repo-side edits (Action SHA-pins, `package.json`, workflows) ship on the merge alone — no box step.
5. **For the BRAKE items** — report the drift, the reason, and the bump-procedure pointer, so the operator decides and ships it themselves.
6. **Stop.** One bounded pass per tick.

## Safety doctrine (the short version)

The full rules are [references/safety-doctrine.md](references/safety-doctrine.md). The spine:

- **SHIP end-to-end** (edit → PR → CI-green → merge; for a baked pin the box's `fluncle-pin-watch` self-deploys it): a **patch or minor** bump of the `fluncle` CLI or the Claude Code CLI, a **patch/minor** bun bump (all three places), and **SHA-pinning** a GitHub Action at its _current_ major (a no-op-behaviour hardening). The repo-side ones are validated by CI before merge; the baked ones are validated by the **pin-watch pre-smoke** before the live container is touched, with automatic rollback on failure. Blast radius is one CLI on the box or one CI step, and the failure mode is caught-and-reverted by pin-watch.
- **PULL THE BRAKE — report, never ship:**
  - **Any MAJOR bump** (the leading version digit moved) — anywhere.
  - **The Nous Research Hermes base image.** Pre-1.0; a base bump can change the runtime or drop the gateway below the model-context floor at startup (the whole gateway, not one feature). Even with pin-watch's pre-smoke safety net, the failure mode is too coarse and the upgrade too consequential to take unattended — always report, let the operator pull it.
  - **box.ascii** — pre-1.0, self-updating, unpinnable. Nothing to bump; re-verify the conductor after a rebuild (see the inventory).
  - **Anything touching auth, the runtime, or the model** — a token shape, an OAuth/credential change, the model pin, a base-image runtime swap. Never "clearly safe"; the operator's call.
- **STOP mid-flight on failure.** A red CI run is never merged. The pin-watch pre-smoke and auto-rollback are the box's own safeguards after the merge; the routine's only mid-flight stop point is CI.
- **When in doubt, stop.** A deferred bump costs nothing; a bad shipped one that slips past pin-watch's pre-smoke can affect the gateway.

## How a bump actually ships

The routine carries a clearly-safe bump all the way to: **edit → PR → CI-green → merge**. That is the whole job. For a baked Dockerfile pin (a `fluncle`/Claude Code CLI bump), the on-box `fluncle-pin-watch` timer (rave-02) takes it from there: it detects the new pin on `main`, rebuilds the image, pre-smokes (versions + an agent-tier read + the role boundary) BEFORE touching the live container, swaps, post-smokes, and auto-rolls-back on any failure, Discord-alerting on deploy or rollback. The rebuild, smoke, rollback, and single-flight for a baked-pin merge are all pin-watch's job; the routine never SSHes, never runs `docker`, never touches `op`. The pin-watch mechanism is documented at `docs/agents/hermes/pin-watch/`. The **`fluncle-hermes-operator`** skill remains the reference for the box's run/smoke mechanics that pin-watch encodes — but the routine no longer drives them. This skill and its references stay at the architecture/procedure level: **no host names, IPs, secret values, `op://` paths, box SSH/docker commands, or local filesystem paths** in any committed file here (public-repo rule).

## Cadence

**~Weekly.** Drift accrues slowly; a weekly sweep keeps the pins fresh without churning the box. The hands-off routine (see [automation/](automation/)) is the mechanism; a manual run is just "follow the sweep above."

## Source priority

Read top-down; earlier sources override on conflict.

1. The user's current brief.
2. **This skill and its references** — the doctrine, the inventory, the safety rules, the bump-and-ship procedure.
3. `docs/agents/hermes/Dockerfile` and `docs/agents/hermes/pin-watch/` — the pins of record and the on-box self-deploy mechanism. The Dockerfile is the source of truth for what is pinned; if a line number in the inventory has drifted, the pin's **comment marker** (each pin line carries a "Bump lever" / "Pinned …" comment) still locates it.
4. **The `fluncle-hermes-operator` skill** — for the box rebuild/redeploy/smoke-test mechanics that the on-box pin-watch encodes.
5. `AGENTS.md` — the repo's quality-check + git + skill conventions.
