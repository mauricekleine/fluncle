---
name: fluncle-maintenance
description: "Keep Fluncle's pinned/baked supply chain current — the version-drift sweep over the Hermes image's pins (the Nous Research Hermes base image, bun, the fluncle CLI, the Claude Code CLI), the box.ascii render-box CLI, and the GitHub Actions tags. Use whenever the task is checking for version drift, bumping a pinned dependency on the Hermes box, deciding whether a base-image / CLI / Actions-tag bump is safe to apply, SHA-pinning the workflow actions, or running the weekly maintenance routine. Trigger on mentions of version drift, stale pins, bumping the Hermes image or its baked CLIs, the maintenance routine, keeping the galaxy current, or whether a bump is safe to auto-apply. NOT for the workspace dependency catalog freshness pass (that is the bunfig minimumReleaseAge flow), and NOT for changing what the agent may do or its voice (that is the fluncle-hermes-operator skill)."
---

# Fluncle maintenance

Fluncle's runtime supply chain is **pinned and baked**: the Hermes box runs a Docker image that pins an upstream base plus a small toolchain (bun, the `fluncle` CLI, the Claude Code CLI), and CI runs GitHub Actions referenced by tag. Pins do not float — that is deliberate (a reproducible box, a layer-cache bust on every bump) — so they go stale silently. This skill is the **drift sweep** that keeps them current: read each pin, check latest, and either apply a clearly-safe bump or report the drift and pull the brake. The galaxy should self-maintain.

This file is the doctrine and the decision map. The drift surface (file:line + current pin + a "check latest" one-liner + how to bump) lives in [references/version-inventory.md](references/version-inventory.md); the bump-and-redeploy procedure in [references/bump-procedure.md](references/bump-procedure.md); the Opus-as-brake rules in [references/safety-doctrine.md](references/safety-doctrine.md). The hands-off weekly routine that runs all of this lives in [automation/](automation/).

## What this covers (and what it does not)

**In scope — the pinned/baked runtime supply chain:**

- The **Nous Research Hermes base image** the agent runs on (`docs/agents/hermes/Dockerfile`).
- **bun** — baked into the image AND mirrored in the repo's `package.json` `packageManager` (and the CI workflows). One version, three places; they move together.
- The **`fluncle` CLI** baked into the image (`npm -g`).
- The **Claude Code CLI** baked into the image (`npm -g`).
- **box.ascii CLI** — the render box's transport. Pre-1.0, self-updating, **unpinnable** (the installer offers no version). Not a pin to bump; a thing to **re-verify** after a base rebuild.
- The **GitHub Actions** mutable tags in `.github/workflows/` (`actions/checkout@v6`, `oven-sh/setup-bun@v2`, …) — a `.deepsec` scan flags these as a supply-chain risk and recommends SHA-pinning + a bot to bump them.

**Out of scope (separate flows — reference, do not duplicate):**

- **The workspace dependency catalog freshness.** The repo's app/package deps live in `package.json` `workspaces.catalog` + each package's deps, governed by the `bunfig.toml` `minimumReleaseAge` (3-day) policy. Bumping those is a different, larger pass with its own gate — not this skill. This skill touches the **runtime pins** (the image + Actions), not the app dependency tree.
- **What the agent may do, its model, or its voice.** Those levers are the **`fluncle-hermes-operator`** skill (Worker role guards, `config.yaml`, `SOUL.md`). This skill only keeps the _toolchain versions_ current.

## The mental model: pins are deliberate, drift is silent, Opus is the brake

Three facts shape every decision here:

1. **The pins are intentional.** Floating `latest` would make the box non-reproducible and would mean an upstream push silently changes the runtime. So the box pins everything (Hermes is pre-1.0; pin the whole toolchain). The cost of pinning is that nobody is told when a newer, safer version ships — hence this sweep.
2. **The repo is canonical; the box is a deploy target.** Every bump is an edit to a committed file (the `Dockerfile` pin, or a workflow file), reviewed in git, then shipped by **rebuilding the image and redeploying** (the operator step). You never hand-edit the running box as the source of truth — that drifts from git and the next rebuild erases it. (Same invariant the `fluncle-hermes-operator` skill enforces.)
3. **Running on Opus 4.8, your judgment IS the safety brake.** There is no human in the loop on a routine tick. So the doctrine is conservative by construction: apply only what is _clearly_ safe (a patch/minor whose CI deploy-gate passes), and on anything with real blast radius — a major bump, the pre-1.0 churn of the base image, anything touching auth/runtime/the model — **report and pull the brake**. A missed bump is a non-event; a bad auto-applied bump that takes the gateway down is a real incident. When unsure, you do not bump.

## The drift sweep (what a tick does)

The whole loop, bounded to one pass:

1. **Read every pin** — the inventory's file:line table. Record the current pin for each.
2. **Check latest** — run each inventory "check latest" one-liner. Compute the drift (none / patch / minor / major) per item.
3. **Judge safety** per [references/safety-doctrine.md](references/safety-doctrine.md). Classify each drifted item as **apply** or **brake**.
4. **Either:**
   - **Apply the safe bumps.** Edit the pin in place (the Dockerfile line, or SHA-pin a workflow action), commit on a branch, open a PR, and let the CI deploy-gate validate it. Note in the PR that the **image rebuild + redeploy is an operator follow-up** (the routine does not touch the box).
   - **Report the drift + pull the brake** for anything that is not clearly safe, with the reason (major? pre-1.0? auth/runtime/model?) and the bump-procedure pointer, so the operator decides.
5. **Stop.** One bounded pass per tick. Do not chase the whole tree; do not touch the box; never auto-rebuild or auto-deploy.

## Safety doctrine (the short version)

The full rules are [references/safety-doctrine.md](references/safety-doctrine.md). The spine:

- **SAFE to auto-apply** (edit the pin, open a PR, let the gate validate): a **patch or minor** bump of the `fluncle` CLI or the Claude Code CLI, and **SHA-pinning** a GitHub Action at its _current_ major (pin the tag you already use to its commit SHA — that is a no-op-behaviour hardening, not a version change). These pass the CI deploy-gate (`format:check` + `lint` + `typecheck` + `test`) before merge, and their blast radius is one CLI on the box or one CI step.
- **PULL THE BRAKE — report, never auto-apply:**
  - **Any MAJOR bump** (the leading version digit moved) — anywhere.
  - **The Nous Research Hermes base image.** It is pre-1.0; a base bump can change the runtime or drop the gateway below the model-context floor, and the only validation is a box rebuild + smoke test the routine cannot run. Always report, never auto-apply.
  - **box.ascii** — pre-1.0, self-updating, unpinnable. There is nothing to bump; just re-verify the conductor after the operator rebuilds (see the inventory).
  - **Anything touching auth, the runtime, or the model** — a token shape, an OAuth/credential change, the model pin, a base-image runtime swap. These are never "clearly safe"; they are the operator's call.
- **When in doubt, brake.** The asymmetry is the whole point: a deferred bump costs nothing; a bad auto-applied one can take the gateway down with no human watching.

## How a bump actually ships

Editing a pin is half the job; the change only reaches the live box on a **rebuild + redeploy**, which is an **operator** step (the routine never touches the box). The exact build context, build/run commands, secrets, and smoke tests live in **the Hermes ops runbook note in 1Password** and in the in-repo procedure docs — see [references/bump-procedure.md](references/bump-procedure.md), which routes to them. This skill and its references stay at the architecture/procedure level: **no host names, IPs, secret values, `op://` paths, box SSH/docker commands, or local filesystem paths** in any committed file here (public-repo rule — same as `fluncle-hermes-operator`).

## Cadence

**~Weekly.** Drift accrues slowly; a weekly sweep keeps the pins fresh without churning the box. The hands-off routine (see [automation/](automation/)) is the mechanism; a manual run is just "follow the sweep above."

## Source priority

Read top-down; earlier sources override on conflict.

1. The user's current brief.
2. **This skill and its references** — the doctrine, the inventory, the safety rules, the bump procedure.
3. `docs/agents/hermes/Dockerfile` and `docs/agents/hermes/cron/README.md` — the pins of record and the operator's rebuild/redeploy runbook. The Dockerfile is the source of truth for what is pinned; if a line number in the inventory has drifted, the pin's **comment marker** (each pin line carries a "Bump lever" / "Pinned …" comment) still locates it.
4. `AGENTS.md` — the repo's quality-check + git + skill conventions.
5. The `fluncle-hermes-operator` skill — for the box rebuild/redeploy mechanics this skill routes to but does not own.
