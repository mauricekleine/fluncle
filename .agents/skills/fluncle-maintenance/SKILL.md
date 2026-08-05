---
name: fluncle-maintenance
description: "Keep Fluncle's pinned/baked supply chain current — the version-drift sweep over the Hermes image's pins (base image, bun, the fluncle CLI, the Claude Code CLI), the box.ascii render-box CLI, and the GitHub Actions tags. Ships the clearly-safe bumps END-TO-END (edit the pin → PR → CI green → merge); a baked Dockerfile pin then self-deploys via the on-box fluncle-pin-watch timer (rave-02): rebuild → pre-smoke → swap → auto-rollback. Brakes (reports, never ships) on anything risky — a major bump, the base image, or auth/runtime/model. ALSO owns the dependency VULNERABILITY posture: the two advisory feeds (Dependabot + the report-only bun-audit CI workflow), the severity policy, the justified `--ignore` allowlist, and vulnerability-driven bumps sequenced by reachability. Use whenever checking for version drift, bumping a pinned Hermes dependency, judging whether a base-image / CLI / Actions-tag bump is safe, SHA-pinning the workflow actions, merging a safe bump, triaging a security advisory or the bun-audit findings, or running the maintenance routine. NOT for the routine freshness-only workspace catalog bump pass (the bunfig minimumReleaseAge flow with no advisory driving it), nor for changing what the agent may do or its voice (the fluncle-hermes-operator skill)."
---

# Fluncle maintenance

Fluncle's runtime supply chain is **pinned and baked**: the Hermes box runs a Docker image that pins an upstream base plus a small toolchain (bun, the `fluncle` CLI, the Claude Code CLI), and CI runs GitHub Actions referenced by tag. Pins do not float — that is deliberate (a reproducible box, a layer-cache bust on every bump) — so they go stale silently. This skill is the **drift sweep** that keeps them current: read each pin, check latest, and either ship a clearly-safe bump **end-to-end** or report the drift and pull the brake. The galaxy should self-maintain — repo AND box.

This file is the doctrine and the decision map. The drift surface (file:line + current pin + a "check latest" one-liner + how to bump) lives in [references/version-inventory.md](references/version-inventory.md); the merge procedure in [references/bump-procedure.md](references/bump-procedure.md); the Opus-as-gate rules in [references/safety-doctrine.md](references/safety-doctrine.md). The hands-off sweep runs hourly in `.github/workflows/hermes-pin-drift.yml`; Renovate maintains GitHub Actions digests. [automation/](automation/) documents the current wiring.

## What this covers (and what it does not)

**In scope — the pinned/baked runtime supply chain:**

- The **Nous Research Hermes base image** the agent runs on (`docs/agents/hermes/Dockerfile`).
- **bun** — baked into the image AND mirrored in the repo's `package.json` `packageManager` (and the CI workflows). One version, three places; they move together.
- The **`fluncle` CLI** baked into the image (the standalone bun-compiled binary, pinned by release-asset URL — the Bun-runtime commands need it; the `npm -g` thin client runs under node and can't).
- The **Claude Code CLI** baked into the image (`npm -g`).
- **box.ascii CLI** — the render box's transport. Pre-1.0, self-updating, **unpinnable** (the installer offers no version). Not a pin to bump; a thing to **re-verify** after a base rebuild.
- The **GitHub Actions** mutable tags in `.github/workflows/` (`actions/checkout@v6`, `oven-sh/setup-bun@v2`, …) — a `.deepsec` scan flags these as a supply-chain risk and recommends SHA-pinning.

**Out of scope (separate flows — reference, do not duplicate):**

- **The workspace dependency catalog freshness.** The repo's app/package deps live in `package.json` `workspaces.catalog` + each package's deps, governed by the `bunfig.toml` `minimumReleaseAge` (3-day) policy. Bumping those for freshness alone is a different, larger pass with its own gate — not this skill. This skill touches the **runtime pins** (the image + Actions) — and, as the one exception into the app dependency tree, **vulnerability-driven bumps** under the posture section below: when an advisory names a dependency, the triage and the fix ship through this skill's judgment, not the freshness pass.
- **What the agent may do, its model, or its voice.** Those levers are the **`fluncle-hermes-operator`** skill (Worker role guards, `config.yaml`, `SOUL.md`). This skill only keeps the _toolchain versions_ current. The `fluncle-hermes-operator` skill is the reference for the box's run/smoke mechanics that the on-box pin-watch encodes; the maintenance routine does not drive those mechanics.

## The mental model: pins are deliberate, drift is silent, Opus is the gate

Three facts shape every decision here:

1. **The pins are intentional.** Floating `latest` would make the box non-reproducible and would mean an upstream push silently changes the runtime. So the box pins everything (Hermes is pre-1.0; pin the whole toolchain). The cost of pinning is that nobody is told when a newer, safer version ships — hence this sweep.
2. **The repo is canonical; the box is a deploy target — and for a baked pin the merge IS the deploy trigger.** Every bump is an edit to a committed file (the `Dockerfile` pin, or a workflow file), reviewed in git, merged once CI is green. For a baked Dockerfile pin, the routine's job ends at the merge: the on-box `fluncle-pin-watch` timer (rave-02) watches `main`, rebuilds the image, pre-smokes it (versions + an agent read + the role boundary) BEFORE touching the live container, swaps, post-smokes, and **auto-rolls-back on any failure** — Discord-alerting on deploy or rollback. You never hand-edit the running box as the source of truth; the box self-deploys from `main` (`docs/agents/hermes/pin-watch/`). The rebuild, smoke, rollback, and single-flight are the pin-watch script's job, not the routine's.
3. **Automation ships only the deterministic safe set.** A manual deep pass may ship only items classified SHIP by `safety-doctrine.md`; all others are BRAKE items. Red CI stops the merge.

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

## Dependency vulnerability posture (the two feeds)

This skill owns the standing policy for dependency vulnerabilities — the counterpart to the drift sweep: drift is silent staleness, an advisory is a named reason to move.

**The feeds, and who reads them.** Two complementary feeds cover the whole surface: **Dependabot** (GitHub-native, watches the manifests it can parse, alerts on the default branch) and the **report-only `dependency-audit.yml` workflow** (`bun audit` over `bun.lock`, so it sees the transitive surface Dependabot cannot parse; runs on PRs, main pushes, and weekly). Neither feed pages anyone: they are READ on every maintenance pass — a pass begins by checking both — and the weekly scheduled run plus Dependabot's alert badge are the between-pass backstop. A pass that finds new advisories triages them then and there.

**What Dependabot actually watches — `.deepsec/pnpm-lock.yaml`, and nothing else.** `bun.lock` is not a manifest Dependabot parses, so the single file it reads in this repo is `.deepsec/pnpm-lock.yaml`: a standalone pnpm project holding the deepsec scanner's config, outside the bun workspace, never deployed, never imported by the Worker or any app. By the ladder below that is tier 2, local-only tooling — but it is also **100% of the Dependabot feed**, so a full alert list there reads like a repo-wide emergency and trains the operator to ignore the badge. A pass drains it rather than letting it accumulate: run `corepack pnpm update <pkg> --depth Infinity` inside `.deepsec/` (corepack matches the `packageManager` pin; bump that pin to the latest of its own major in the same pass) and re-read the resolved versions in the lockfile against the advisory's patched floor. Where an upstream **exact** pin blocks the bump — `deepsec` pins `@earendil-works/pi-coding-agent` exact and that package pins `undici` exact, so no range update reaches it — the §3 transitive fork applies, keyed to the pinning parent (`"@earendil-works/pi-coding-agent>undici"`) so no sibling chain on a different major is dragged along; drop the entry once upstream floats the pin. Where neither a bump nor a scoped override is possible, record the alert here as accepted with its reason — the dismissal itself is a GitHub security-tab action and stays the operator's.

**The severity policy — reachability first, severity second.** Sequence findings by where the vulnerable code EXECUTES, not by advisory count:

1. **Reachable on the deploy runner or the Worker runtime path** (anything `vite`/`wrangler`/`@tanstack/react-start`/the build chain pulls in): a high/critical fix ships promptly through a SHIP-classified bump, and MAY jump the 3-day `minimumReleaseAge` quarantine — the quarantine guards against fresh-release supply-chain attacks, and a targeted advisory fix is the opposite trade; still prefer the oldest release that carries the fix.
2. **Local-only tooling** (lint, editor, docs, Raycast, Expo dev chains): rides the normal cadence; the quarantine holds.
3. **Prefer bumping the direct parent** over pinning a transitive; a `resolutions`/`overrides` pin is a fork of someone else's tree and carries a comment naming when it can be dropped.
4. **Nothing auto-merges.** Renovate automerges nothing here; every vulnerability-driven bump goes through the same SHIP/BRAKE judgment and green-CI gate as a pin bump.

**The `--ignore` allowlist.** The allowlist lives in the root `audit` script (`package.json`), so local runs and CI report the same residual set. An entry is admitted only with a justification recorded here, and every pass re-checks that the justification still holds (an upstream fix retires the entry). The current entries:

- `GHSA-f88m-g3jw-g9cj` (sharp, libvips CVEs): build-time image tooling; miniflare pins sharp exact, so the fix arrives with routine wrangler bumps and cannot be forced from this tree.
- `GHSA-xcpc-8h2w-3j85` (adm-zip, crafted-ZIP memory allocation): unreachable — it unpacks only onnxruntime's own archives at install time, never untrusted input.

**The blocking flip (operator-gated).** `dependency-audit.yml` currently carries `continue-on-error: true`. The flip — removing it, and optionally marking the check required — is the operator's PR-gate contract change, and its precondition is a clean residual: every non-allowlisted high drained via parent bumps. Advisory drift can redden `main` without a code change, so the flip is deliberately his call, not a pass's.

## Safety doctrine

Anything not explicitly classified SHIP is BRAKE. See `references/safety-doctrine.md` for the decision table.

Keep topology, secrets, and local paths out of committed maintenance files.

## Cadence

**On every `fluncle` release + hourly, in CI.** `hermes-pin-drift.yml` runs the moment a `fluncle` release publishes (a `workflow_run` on `CLI Release`, so the box tracks first-party bumps within minutes) and hourly as the backstop for the external pins (Renovate's Action-digest sweep stays weekly). Each tick is a cheap no-op when nothing drifted or a pin-drift PR is already open. The mechanism is the CI workflow + Renovate (see [automation/](automation/)); a manual run is just "follow the sweep above," or run this skill by hand for a judgment-heavy pass.

## Source priority

Read top-down; earlier sources override on conflict.

1. The user's current brief.
2. **This skill and its references** — the doctrine, the inventory, the safety rules, the bump-and-ship procedure.
3. `docs/agents/hermes/Dockerfile` and `docs/agents/hermes/pin-watch/` — the pins of record and the on-box self-deploy mechanism. The Dockerfile is the source of truth for what is pinned; if a line number in the inventory has drifted, the pin's **comment marker** (each pin line carries a "Bump lever" / "Pinned …" comment) still locates it.
4. **The `fluncle-hermes-operator` skill** — for the box rebuild/redeploy/smoke-test mechanics that the on-box pin-watch encodes.
5. `AGENTS.md` — the repo's quality-check + git + skill conventions.
