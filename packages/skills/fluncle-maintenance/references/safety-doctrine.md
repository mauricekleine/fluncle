# Safety doctrine — Opus is the gate

This routine runs **hands-off**, on Opus 4.8, with **no human in the loop on a tick**. There is no approval prompt before a bump **ships** — merged to `main`, and for a baked pin the box self-deploys it. So the model's judgment is the only safety mechanism on the repo side — and the doctrine is built around one asymmetry:

> **A missed bump is a non-event. A bad shipped bump that takes the gateway down — with nobody watching — is a real incident.**

Everything below follows from that. When the two sides are close, you stop. You are not optimizing for freshness; you are optimizing for _never leaving a regression running unattended_. The autonomy to ship is granted only because every shipped change is gated (CI before merge; the pin-watch pre-smoke before the box touches the live container) and **reversible** (pin-watch auto-rolls-back on a failed smoke). Where a change can't be gated or reversed safely, you brake and report.

## The deploy-gate is the floor; the pin-watch pre-smoke is the ceiling

The repo's CI deploy-gate is `bun run deploy:gate` = `format:check` + `lint` + `typecheck` + `test` (plus gitleaks + the Cloudflare build on the PR). A PR that edits a **repo-side** pin (`package.json` `packageManager`, a workflow `bun-version:`, an Actions SHA-pin) is fully validated by this gate — that real, automatic validation is what makes those edits safe to **merge** unattended.

But the gate has a **blind spot**: it does **not** rebuild or run the Hermes image. A Dockerfile `FROM`/`npm -g` edit passes the gate trivially (the gate never touches the Dockerfile) and is unvalidated by CI. That blind spot is exactly what the on-box **`fluncle-pin-watch` pre-smoke** covers: after the merge, pin-watch rebuilds the image and smoke-checks it (exactly four checks: `fluncle version`, `claude --version`, an agent-tier read returning `{ok:true}`, and a publish-class command refused with a 403) BEFORE touching the live container — the validation CI could not do — and **auto-rolls-back on a failed smoke**. (The broader box.ascii-auth / `dig` / cron-roster probes belong to the separate `fluncle-healthcheck` cron, not pin-watch.) So:

- **Repo-side pin, patch/minor, gate green → merge it.** Ships on merge; no box step.
- **Baked Dockerfile pin, patch/minor → merge it; pin-watch validates it on the box** via pre-smoke before swap, with auto-rollback on fail. The pre-smoke is the ceiling the CI gate can't reach.
- **A change the pre-smoke can't meaningfully validate** (the base image's failure mode is the whole gateway at startup, not one probe) → that is a brake, no matter the version delta.

## SHIP end-to-end

Edit the pin → open the PR → wait for CI green → merge. For a baked pin, the on-box `fluncle-pin-watch` timer self-deploys it (pre-smoke → swap → auto-rollback on fail). The blast radius is bounded and every step is gated-and-reversible:

1. **A patch or minor bump of the `fluncle` CLI** (first-party; a stale CLI just lacks a recent command; a patch/minor never removes one). Baked → pin-watch pre-smoke validates it before the live container is touched.
2. **A patch or minor bump of the Claude Code CLI** (the agent binary, not the model or the auth; a patch rarely changes the `claude -p` contract). Baked → pin-watch pre-smoke validated.
3. **A patch or minor bump of bun**, edited in **all three** places at once (Dockerfile installer + `package.json` `packageManager` + every workflow `bun-version:`) — the CI runs on the new bun (the repo-side validation), and the box gets it via pin-watch on the same rebuild as any baked pin.
4. **SHA-pinning a GitHub Action at its CURRENT major** (replace `@v6` with the commit SHA `v6` resolves to today, keeping `# v6` as a trailing comment). Changes **no behaviour** — pins the same commit — and the PR's CI run proves the workflow still parses and runs. Fully repo-side; ships on merge. This is the `.deepsec` hardening and the safest thing in the skill.

## PULL THE BRAKE — report, never ship

Open no bump PR (or, if it's bundled with safe items, exclude it). Report the drift, the reason, and the bump-procedure pointer, and let the operator decide:

1. **Any MAJOR bump, anywhere.** The leading version digit moved → assume a breaking change until a human reads the changelog. `fluncle` major (a renamed/removed command could break a cron), Claude Code major (the `-p`/skills contract could change), bun major (toolchain-wide), an Actions major (new inputs/behaviour) — all brake.
2. **The Nous Research Hermes base image — _any_ change.** It is **pre-1.0**: even a "patch" calendar tag can change the runtime, and a model-context regression takes the **whole gateway** down at startup. The failure mode is too coarse and the upgrade too consequential to ship unattended even with pin-watch's pre-smoke safety net — always report the newer tag, let the operator pull it (they periodically should, for security patches; your job is to surface it).
3. **box.ascii — nothing to ship.** Pre-1.0, self-updating, unpinnable. The routine never bumps it. (The pin-watch post-swap smoke is only `fluncle version` + container-running; re-verifying the render conductor is operator / `fluncle-healthcheck` work, not pin-watch's.) A sweep mentions it only as a one-line "unpinnable, re-verify post-rebuild" note.
4. **Anything touching auth, the runtime, or the model.** A changed token shape, an OAuth/credential flow change, the model pin, a base-image runtime swap. Never "clearly safe" regardless of the version delta — the operator's call, full stop. (If a CLI's _release notes_ mention an auth/credential change even on a patch, brake.)
5. **A pin that is already internally inconsistent** (e.g. Dockerfile bun ≠ `package.json` bun ≠ the workflows). Don't "fix" it blind — report so the operator picks the intended version.

## Stop mid-flight on failure

The autonomy to ship is conditional on every gate staying green. The moment one doesn't, you stop where you are:

- **CI red on the PR → do not merge.** Report the failing check; leave the PR open for a human.
- The pin-watch pre-smoke, auto-rollback, single-flight guard, and Discord alerts are the box's own safeguards after the merge — the routine has no mid-flight stop point there, because the routine never touches the box.

## When in doubt

**Stop.** If you cannot cleanly classify a drift as patch/minor-and-safe, if a changelog is ambiguous, if "check latest" returns something you can't parse, or if the same bump touches more than one of the brake items above — do not ship. Write the clearest report and stop. The operator reads it at their pace; nothing is lost by waiting a week.

## Scope discipline (so a tick stays bounded)

- **One bounded pass per tick.** Sweep the inventory once, ship the safe, stop. Do not loop to "catch up."
- **Stay inside the inventory.** This skill owns the six runtime pins — not the workspace dependency catalog (the `bunfig.toml` `minimumReleaseAge` flow), not the app dependency tree, not the model or voice. Out-of-scope drift is a mention in the report, not an action.
- **Never touch the box.** The deploy, pre-smoke, swap, rollback, and single-flight for a baked-pin merge are all the on-box `fluncle-pin-watch` timer's job (`docs/agents/hermes/pin-watch/`). The routine's job ends at `gh pr merge`.
- **Merge ONLY a green PR**, and only for SHIP items. Never merge a red PR; never commit to `main` directly (the PR is the audit trail + the CI gate).
