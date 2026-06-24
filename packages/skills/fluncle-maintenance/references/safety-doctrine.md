# Safety doctrine — Opus is the brake

This routine runs **hands-off**, on Opus 4.8, with **no human in the loop on a tick**. There is no approval prompt before a bump lands in a PR. So the model's judgment is the only safety mechanism — and the doctrine is built around one asymmetry:

> **A missed bump is a non-event. A bad auto-applied bump that takes the gateway down — with nobody watching — is a real incident.**

Everything below follows from that. When the two sides are close, you brake. You are not optimizing for freshness; you are optimizing for _never shipping a regression unattended_. Freshness is what the operator gets from your **report**, not from your auto-applies.

## The deploy-gate is the floor, not the ceiling

The repo's CI deploy-gate is `bun run deploy:gate` = `format:check` + `lint` + `typecheck` + `test`. A PR that edits a **repo-side** pin (`package.json` `packageManager`, a workflow `bun-version:`, an Actions SHA-pin) is validated by this gate before it can merge — that is real, automatic validation, and it is what makes those edits safe to auto-apply.

But the gate has a **blind spot**: it does **not** rebuild or run the Hermes image. A Dockerfile `FROM`/`npm -g` edit passes the gate trivially (the gate never touches the Dockerfile) and yet is completely unvalidated until the operator rebuilds. So:

- **Gate passes + the change is repo-side and patch/minor → safe to apply.**
- **Gate passes but the change only ships on a box rebuild → the gate told you nothing about it.** Treat the Dockerfile edit's safety on its own merits (the rules below), and always flag the rebuild as an operator follow-up.

## SAFE to auto-apply

Edit the pin, open a PR, let the gate validate. The blast radius is bounded and the failure mode is visible-and-cheap:

1. **A patch or minor bump of the `fluncle` CLI** (first-party; a stale CLI just lacks a recent command; a patch/minor never removes one).
2. **A patch or minor bump of the Claude Code CLI** (the agent binary, not the model or the auth; a patch rarely changes the `claude -p` contract).
3. **A patch or minor bump of bun**, edited in **all three** places at once (Dockerfile installer + `package.json` `packageManager` + every workflow `bun-version:`) — the gate runs CI on the new bun, which is exactly the interpreter the box will run.
4. **SHA-pinning a GitHub Action at its CURRENT major** (replace `@v6` with the commit SHA `v6` resolves to today, keeping `# v6` as a trailing comment). This changes **no behaviour** — it pins the same commit — and the PR's CI run proves the workflow still parses and runs. This is the `.deepsec` hardening, and it is the safest thing in this whole skill.
5. **Adding a Renovate (or Dependabot) config to keep SHA-pinned actions bumped** — low-risk, but **name it explicitly** in the PR body; do not slip a CI-config change in silently.

For 1–3, remember: the repo edit is safe to land, but the **box only catches up on an operator rebuild** — say so in the PR.

## PULL THE BRAKE — report, never auto-apply

Open no bump PR for these. Report the drift, the reason, and the bump-procedure pointer, and let the operator decide:

1. **Any MAJOR bump, anywhere.** The leading version digit moved → assume a breaking change until a human reads the changelog. `fluncle` major (a renamed/removed command could break a cron), Claude Code major (the `-p`/skills contract could change), bun major (toolchain-wide behaviour), an Actions major (new inputs/behaviour) — all brake.
2. **The Nous Research Hermes base image — _any_ change.** It is **pre-1.0**: even a "patch" calendar tag can change the runtime, and a model-context regression takes the **whole gateway** down at startup, not one feature. The only validation is a box rebuild + smoke test this routine cannot run. Always report the newer tag; never auto-apply. (The operator periodically _should_ take a base bump for security patches — your job is to surface it, not to pull it.)
3. **box.ascii — nothing to apply.** Pre-1.0, self-updating, unpinnable. The routine never acts on it; the operator re-verifies the conductor after a rebuild. A sweep mentions it only as a one-line "unpinnable, re-verify post-rebuild" note.
4. **Anything touching auth, the runtime, or the model.** A changed token shape, an OAuth/credential flow change, the model pin, a base-image runtime swap. These are never "clearly safe" regardless of the version delta — they are the operator's call, full stop. (If a CLI's _release notes_ mention an auth or credential change even on a patch, treat it as a brake.)
5. **A pin that is already internally inconsistent** (e.g. the Dockerfile bun ≠ `package.json` bun ≠ the workflows). Don't "fix" it blind — report the inconsistency so the operator picks the intended version; an auto-reconcile could pin the wrong one.

## When in doubt

**Brake.** If you cannot cleanly classify a drift as patch/minor-and-safe, if a changelog is ambiguous, if "check latest" returns something you can't parse, or if the same bump touches more than one of the items above — do not bump. Write the clearest possible report and stop. The operator reads it at their pace; nothing is lost by waiting a week.

## Scope discipline (so a tick stays bounded)

- **One bounded pass per tick.** Sweep the inventory once, act, stop. Do not loop to "catch up."
- **Stay inside the inventory.** This skill owns the six runtime pins — not the workspace dependency catalog (the `bunfig.toml` `minimumReleaseAge` flow), not the app dependency tree, not the model or voice. If you notice catalog drift, mention it in the report as "out of scope for this routine" and leave it.
- **Never touch the box.** No SSH, no rebuild, no redeploy, no `box`/`docker` command — ever. The routine's deliverable is a PR and/or a report; the box is the operator's.
- **Never auto-merge.** Open the PR; the orchestrating session / operator merges. (A push to `main` is a production deploy of `apps/web` — and the routine should not be the thing that triggers one unattended.)
