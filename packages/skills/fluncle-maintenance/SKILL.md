---
name: fluncle-maintenance
description: "Keep Fluncle's pinned/baked supply chain current — the version-drift sweep over the Hermes image's pins (the Nous Research Hermes base image, bun, the fluncle CLI, the Claude Code CLI), the box.ascii render-box CLI, and the GitHub Actions tags. Ships the clearly-safe bumps END-TO-END: merge the PR after CI goes green, and for a baked Dockerfile pin also rebuild + redeploy + smoke-test the Hermes box, rolling back if the smoke fails. Brakes (reports, never ships) on anything risky — a major bump, the base image, or auth/runtime/model. Use whenever checking for version drift, bumping a pinned Hermes dependency, deciding whether a base-image / CLI / Actions-tag bump is safe, SHA-pinning the workflow actions, merging + deploying a safe bump, or running the weekly maintenance routine. NOT for the workspace dependency catalog freshness pass (the bunfig minimumReleaseAge flow), and NOT for changing what the agent may do or its voice (the fluncle-hermes-operator skill)."
---

# Fluncle maintenance

Fluncle's runtime supply chain is **pinned and baked**: the Hermes box runs a Docker image that pins an upstream base plus a small toolchain (bun, the `fluncle` CLI, the Claude Code CLI), and CI runs GitHub Actions referenced by tag. Pins do not float — that is deliberate (a reproducible box, a layer-cache bust on every bump) — so they go stale silently. This skill is the **drift sweep** that keeps them current: read each pin, check latest, and either ship a clearly-safe bump **end-to-end** or report the drift and pull the brake. The galaxy should self-maintain — repo AND box.

This file is the doctrine and the decision map. The drift surface (file:line + current pin + a "check latest" one-liner + how to bump) lives in [references/version-inventory.md](references/version-inventory.md); the merge-and-redeploy procedure (with the rollback rail) in [references/bump-procedure.md](references/bump-procedure.md); the Opus-as-gate rules in [references/safety-doctrine.md](references/safety-doctrine.md). The hands-off weekly routine that runs all of this lives in [automation/](automation/).

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
- **What the agent may do, its model, or its voice.** Those levers are the **`fluncle-hermes-operator`** skill (Worker role guards, `config.yaml`, `SOUL.md`). This skill only keeps the _toolchain versions_ current — though it **drives that skill's rebuild/redeploy/smoke-test loop** to ship a baked-pin bump.

## The mental model: pins are deliberate, drift is silent, Opus is the gate

Three facts shape every decision here:

1. **The pins are intentional.** Floating `latest` would make the box non-reproducible and would mean an upstream push silently changes the runtime. So the box pins everything (Hermes is pre-1.0; pin the whole toolchain). The cost of pinning is that nobody is told when a newer, safer version ships — hence this sweep.
2. **The repo is canonical; the box is a deploy target — and you ship to both.** Every bump is an edit to a committed file (the `Dockerfile` pin, or a workflow file), reviewed in git, merged once CI is green, then — for a baked pin — shipped to the live box by **rebuilding the image, redeploying, and smoke-testing**. You never hand-edit the running box as the source of truth (that drifts from git and the next rebuild erases it); you change the repo, then redeploy the repo. The box mechanics are the `fluncle-hermes-operator` skill's; this skill drives them with a **rollback rail** so a bad rebuild never lingers.
3. **Running on Opus 4.8, your judgment IS the gate — for stopping AND for continuing.** There is no human in the loop on a routine tick. So you decide, conservatively, both _whether to bump_ and _how far to carry it_: a clearly-safe bump you take all the way (merge + rebuild + smoke); anything with real blast radius — a major bump, the pre-1.0 churn of the base image, anything touching auth/runtime/the model — you **stop before merge** and report. And you stop MID-FLIGHT on a failure: a red CI run is not merged; a failed smoke test is rolled back, not left. A missed bump is a non-event; a bad shipped bump that takes the gateway down — with nobody watching — is a real incident. **When unsure, you stop.** The asymmetry is the whole doctrine.

## The drift sweep (what a tick does)

The whole loop, bounded to one pass:

1. **Read every pin** — the inventory's file:line table. Record the current pin for each.
2. **Check latest** — run each inventory "check latest" one-liner. Compute the drift (none / patch / minor / major) per item.
3. **Judge** per [references/safety-doctrine.md](references/safety-doctrine.md). Classify each drifted item as **SHIP** (clearly safe — take it end-to-end) or **BRAKE** (risky — report, never ship).
4. **For the SHIP items — carry them all the way:**
   1. Edit each safe pin on a branch, run the local gate, open ONE PR (the auditable artifact + the CI gate).
   2. **Wait for the PR's CI to go green** (the deploy-gate + gitleaks + the Cloudflare build). A **red** check → do NOT merge; drop those items back to a report and leave the PR for a human.
   3. **Merge** the green PR (squash).
   4. **If the merged change includes a baked Dockerfile pin** (a `fluncle`/Claude Code CLI bump — the half CI can't validate): rebuild the image, redeploy the box, and run the smoke test (the `fluncle-hermes-operator` verify checklist) — which is the validation CI could not do. **Capture the running container's config and KEEP the previous image first**, so the next step is reversible. On smoke **pass**, done. On smoke **fail**, **roll back** to the previous image and report loudly — never leave the box on a broken build.
   5. Fully-repo-side edits (Action SHA-pins, `package.json`, workflows) ship on the merge alone — no box step.
5. **For the BRAKE items** — report the drift, the reason, and the bump-procedure pointer, so the operator decides and ships it themselves.
6. **Stop.** One bounded pass per tick.

## Safety doctrine (the short version)

The full rules are [references/safety-doctrine.md](references/safety-doctrine.md). The spine:

- **SHIP end-to-end** (edit → PR → CI-green → merge → rebuild-if-baked → smoke → rollback-on-fail): a **patch or minor** bump of the `fluncle` CLI or the Claude Code CLI, a **patch/minor** bun bump (all three places), and **SHA-pinning** a GitHub Action at its _current_ major (a no-op-behaviour hardening). The repo-side ones are validated by CI before merge; the baked ones are validated by the **post-rebuild smoke test**, with automatic rollback. Blast radius is one CLI on the box or one CI step, and the failure mode is caught-and-reverted.
- **PULL THE BRAKE — report, never ship:**
  - **Any MAJOR bump** (the leading version digit moved) — anywhere.
  - **The Nous Research Hermes base image.** Pre-1.0; a base bump can change the runtime or drop the gateway below the model-context floor at startup (the whole gateway, not one feature). The smoke test can catch a dead gateway, but the failure mode is too coarse and the upgrade too consequential to take unattended — always report, let the operator pull it.
  - **box.ascii** — pre-1.0, self-updating, unpinnable. Nothing to bump; re-verify the conductor after a rebuild (see the inventory).
  - **Anything touching auth, the runtime, or the model** — a token shape, an OAuth/credential change, the model pin, a base-image runtime swap. Never "clearly safe"; the operator's call.
- **STOP mid-flight on failure.** A red CI run is never merged. A failed smoke test is rolled back, not left. If the rollback itself fails (the worst case), do not keep going — fire the loudest alert you can and stop for a human.
- **When in doubt, stop.** A deferred bump costs nothing; a bad shipped one can take the gateway down with no human watching.

## How a bump actually ships (now end-to-end)

The routine carries a clearly-safe bump the whole way: **edit → PR → CI-green → merge → (for a baked pin) rebuild + redeploy + smoke-test, with rollback on a failed smoke**. The box-side mechanics — the exact build context, the `docker build`/`docker run` invocation, the env-file + secret placement, the cron user, the smoke-test checklist, and the rollback (keep the previous image, restart it on failure) — are the **`fluncle-hermes-operator`** skill's, driven via [references/bump-procedure.md](references/bump-procedure.md); the secret-bearing steps live in **the Hermes ops runbook note in 1Password**. This skill and its references stay at the architecture/procedure level: **no host names, IPs, secret values, `op://` paths, box SSH/docker commands, or local filesystem paths** in any committed file here (public-repo rule). The routine reads the concrete commands from the operator skill + the ops note at run time; it does not inline them.

## Cadence

**~Weekly.** Drift accrues slowly; a weekly sweep keeps the pins fresh without churning the box. The hands-off routine (see [automation/](automation/)) is the mechanism; a manual run is just "follow the sweep above."

## Source priority

Read top-down; earlier sources override on conflict.

1. The user's current brief.
2. **This skill and its references** — the doctrine, the inventory, the safety rules, the bump-and-ship procedure.
3. `docs/agents/hermes/Dockerfile` and `docs/agents/hermes/cron/README.md` — the pins of record and the operator's rebuild/redeploy runbook. The Dockerfile is the source of truth for what is pinned; if a line number in the inventory has drifted, the pin's **comment marker** (each pin line carries a "Bump lever" / "Pinned …" comment) still locates it.
4. **The `fluncle-hermes-operator` skill** — for the box rebuild/redeploy/smoke-test mechanics this skill drives but does not own.
5. `AGENTS.md` — the repo's quality-check + git + skill conventions.
