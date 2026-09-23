---
name: fluncle-audit-operator
description: >-
  Operator runbook for Fluncle's nightly codebase-audit system — the two rave-02 host systemd timers (`fluncle-audit` at 01:00 and `fluncle-audit-review` at 05:00) that cycle one domain per night (design, voice, architecture, security, surfaces-seo, docs, tests, db-query-shape), open a PR of safe fixes, and auto-merge it on green CI. Use this whenever you need to operate or change the audit: run or pilot a domain by hand, triage the findings ledger (`docs/audit-backlog.md`), handle a PR the reviewer held open, pause/resume or enable/disable the timers, tune a domain prompt or the rotation, wire its secrets, or bump its pinned `gh`. Trigger on any mention of the nightly audit, the audit bot, the audit PR/ledger, the rotation agents, or "what did the audit find". The repo is canonical and the box is a deploy target (baked scripts + host timers).
---

# Fluncle audit operator

Fluncle's codebase keeps itself top-notch through a nightly, domain-cycling audit. Two host
systemd timers on the rave-02 box run full agentic `claude -p` sessions (subscription auth, zero
OpenRouter tokens):

- **`fluncle-audit`** (01:00 Amsterdam) — audits one domain (`epoch-day mod 8`: design · voice ·
  architecture · security · surfaces-seo · docs · tests · db-query-shape), fixes what's confidently
  correct, files the high-impact/high-risk findings to `docs/audit-backlog.md`, and writes
  `.audit/report.md`. The driver, not the agent, then commits that working tree, pushes, and opens
  an `audit/<date>-<domain>` PR with the report as its body.
- **`fluncle-audit-review`** (05:00) — reviews that PR adversarially, fixes small residual nits,
  and **merges** when required CI is green and nothing high-impact remains; otherwise comments and
  leaves it open for you.

The mental model is the same as every other box automation (see the `fluncle-hermes-operator`
skill): **the repo is canonical, the box is a deploy target.** Change the audit in the repo (the
scripts + prompts under `docs/agents/hermes/scripts/audit*`, the units under `*-timer/`), and it
reaches the box by the baked-image + host-timer path. The full architecture, secrets, and one-time
activation live in [`docs/agents/hermes/audit-timer/README.md`](../../../docs/agents/hermes/audit-timer/README.md);
this skill is the operator's map of the recurring tasks.

## Which lever for which change

| You want to…                              | Change this (in the repo)                                                                                                           | How it ships                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Tune what a domain hunts / fixes-vs-files | `docs/agents/hermes/scripts/audit/prompts/<domain>.md` (or `_preamble.md` for the shared contract; `_reviewer.md` for the reviewer) | push to `main` → baked into the image on the next pin-watch rebuild                                                                    |
| Add / remove / reorder a domain           | `audit/rotation.ts` (`DOMAINS` + `DOMAIN_META`) + add `prompts/<key>.md`                                                            | push to `main`; update `rotation.test.ts`                                                                                              |
| Change a schedule or a unit timeout       | `audit-timer/*` / `audit-review-timer/*` (`OnCalendar`, `TimeoutStartSec`)                                                          | `sudo bash docs/agents/hermes/install-host-timers.sh --refresh-unit fluncle-audit.service --refresh-unit fluncle-audit-review.service` |
| Change what the agents verify locally     | `scripts/audit/verify.sh` (the ladder) — it runs from the CHECKOUT, so it is live the moment it merges                              | push to `main`; no rebake needed                                                                                                       |
| Change a pass's wall budget               | `scripts/agent-pass.sh` (`AGENT_PASS_BUDGET_SECS`) — MUST stay under the unit's `TimeoutStartSec`                                   | baked; rebuild — and refresh the unit if you moved the ceiling too                                                                     |
| Change the driver mechanics               | `scripts/audit-sweep.sh` / `scripts/audit-review-sweep.sh`                                                                          | baked; rebuild                                                                                                                         |
| Change a pass's reasoning effort          | `AUDIT_CLAUDE_EFFORT` / `AUDIT_REVIEW_CLAUDE_EFFORT` as plain lines in the host `fluncle-secrets.env.tpl` (default `high`)          | re-run `fluncle-secrets-sync`; no rebake                                                                                               |
| Bump the pinned `gh`                      | `docs/agents/hermes/Dockerfile` (the `gh` layer — manual-watch tier)                                                                | pin-watch rebuild (its pre-smoke does `gh --version`)                                                                                  |
| Rotate / add a secret                     | the host `fluncle-secrets.env.tpl` + `FLUNCLE_GSC_OP_REF` (bootstrap)                                                               | re-run `fluncle-secrets-sync`                                                                                                          |

## The recurring tasks

**Pilot or re-run a domain by hand.** On the box, in the container:

```
docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/audit-sweep.sh --domain <key> --dry-run
```

`--dry-run` audits + edits + writes `.audit/report.md` in the workspace (`~/audit-workspace/fluncle`)
and the driver runs no git write or `gh` — inspect the diff there. Drop `--dry-run` and the driver
commits, pushes, and opens a real PR. Review a specific PR: `audit-review-sweep.sh --pr <N>`.

**Triage the ledger.** `docs/audit-backlog.md` is forward-facing — open findings only, newest run
on top, deduped, never a changelog. Promote the ones worth scheduling into `docs/planning/ROADMAP.md`;
when a row is handled (fixed, rejected, or overtaken), DELETE it in the PR that settles it and name
the resolution in that PR's body — git history carries the record, and a ruling that must outlive
its row is written into the canon doc it governs instead. A high-impact finding the reviewer held
the PR open for is both in the ledger and on the open PR.

**Expect hosted-proof rows from `db-query-shape` night.** That domain (the semantic half of the
DB-scale guardrail — `docs/db-scale-backlog.md`) fixes hoists, rewrites, and projection trims itself,
but it is forbidden from shipping an index or a stored column: Turso keeps no planner statistics, so
whether an index is even picked up is an empirical question only a scratch **hosted** Turso DB answers
(`turso dev` is not evidence — `docs/local-database.md`). Those findings arrive as ledger rows that
name the proof gate, and running it is yours: `apps/web/scripts/bench-db-scale.ts` against a scratch
hosted DB, destroyed after. Record hosted-proof rejections so the audit suppresses already-disproved
proposals.

**Handle a held PR.** When the reviewer leaves an `audit/*` PR open with a comment, it found a
high-impact/high-risk problem it wouldn't merge. Read the comment, decide, and merge or close it
yourself. The next night's auditor branches from fresh `main`, so a lingering open PR never blocks
the next run (different domain, disjoint files).

**Pause / resume.** Stop the nightly without uninstalling:

```
sudo systemctl disable --now fluncle-audit.timer fluncle-audit-review.timer   # pause
sudo systemctl enable  --now fluncle-audit.timer fluncle-audit-review.timer   # resume
```

## Invariants (the why)

- **The reviewer is the merge gate; green CI is decisive.** The reviewer merges only when required
  CI is green and no high-impact finding remains.
- **The auditor fixes by confidence, files by impact.** It never edits secrets/`op://`/auth
  tiers/migrations/`.github/workflows`/CI, never uses the TS `!`, and never drives `main` directly —
  only via the reviewed PR. Keep those rails in `_preamble.md`.
- **Both agents verify through one command, and it is not `bun run check`.** `scripts/audit/verify.sh`
  runs formatting plus the lint rules scoped to the changed paths, then each changed package's own
  typecheck and tests, each behind a wall budget and a cgroup-headroom precondition. The whole-repo
  type-aware lint, whole-repo typecheck, and `apps/web build` exceed the container's memory cap and
  are CI's job — they run on the PR and again in `deploy:gate`, and the reviewer merges on green
  required checks. The measured peaks that settle this are tabled in the audit-timer README.
- **A unit's `TimeoutStartSec` is a backstop, not a budget.** It kills the host-side `docker exec`
  client only; the container-side sweep runs on and self-reports. The real budget is
  `AGENT_PASS_BUDGET_SECS` in `scripts/agent-pass.sh`, and it must stay strictly under the unit's
  ceiling — change one, check the other.
- **`ok:false` carries a reason.** Read `reason` + `container_oom_kills` + `verify` on the summary
  line: `budget-exceeded` means the pass outran its budget, `oom-killed` means the container's cap
  killed something during it, `verify-failed` means the ladder reported a red check, `unverified`
  means the night produced work and ran no checks at all. `action:"unshipped"` means the pass
  failed after editing: the driver never ships a failed pass's work, and it stays in the workspace
  until the next night's reset. `action:"ship-failed"` names the driver step that broke (no
  report, commit, push, or `gh pr create`).
- **`/status` is the honesty signal.** `cron.audit` + `cron.audit-review` show freshness (24h
  cadence); a dead PAT or a failed ship shows as stale/degraded there. Watch it after any change.
- **Public repo.** The prompts + scripts carry no secret values or topology — the concrete `op://`
  refs live on the host (`FLUNCLE_GSC_OP_REF`, the sweep tpl), never in these committed files.

Keep this skill and `docs/agents/hermes/audit-timer/README.md` in step when either changes.
