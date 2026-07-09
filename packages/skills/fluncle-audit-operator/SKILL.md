---
name: fluncle-audit-operator
description: >-
  Operator runbook for Fluncle's nightly codebase-audit system — the two rave-02 host systemd timers (`fluncle-audit` at 01:00 and `fluncle-audit-review` at 05:00) that cycle one domain per night (design, voice, architecture, security, surfaces-seo, docs, tests), open a PR of safe fixes, and auto-merge it on green CI. Use this whenever you need to operate or change the audit: run or pilot a domain by hand, triage the findings ledger (`docs/audit-backlog.md`), handle a PR the reviewer held open, pause/resume or enable/disable the timers, tune a domain prompt or the rotation, wire its secrets, or bump its pinned `gh`. Trigger on any mention of the nightly audit, the audit bot, the audit PR/ledger, the rotation agents, or "what did the audit find". The repo is canonical and the box is a deploy target (baked scripts + host timers).
---

# Fluncle audit operator

Fluncle's codebase keeps itself top-notch through a nightly, domain-cycling audit. Two host
systemd timers on the rave-02 box run full agentic `claude -p` sessions (subscription auth, zero
OpenRouter tokens):

- **`fluncle-audit`** (01:00 Amsterdam) — audits one domain (`epoch-day mod 7`: design · voice ·
  architecture · security · surfaces-seo · docs · tests), fixes what's confidently correct, files
  the high-impact/high-risk findings to `docs/audit-backlog.md`, and opens an `audit/<date>-<domain>` PR.
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

| You want to…                              | Change this (in the repo)                                                                                                           | How it ships                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Tune what a domain hunts / fixes-vs-files | `docs/agents/hermes/scripts/audit/prompts/<domain>.md` (or `_preamble.md` for the shared contract; `_reviewer.md` for the reviewer) | push to `main` → baked into the image on the next pin-watch rebuild |
| Add / remove / reorder a domain           | `audit/rotation.ts` (`DOMAINS` + `DOMAIN_META`) + add `prompts/<key>.md`                                                            | push to `main`; update `rotation.test.ts`                           |
| Change a schedule                         | `audit-timer/*.timer` / `audit-review-timer/*.timer` (`OnCalendar`)                                                                 | re-run `install-host-timers.sh` on the box                          |
| Change the driver mechanics               | `scripts/audit-sweep.sh` / `scripts/audit-review-sweep.sh`                                                                          | baked; rebuild                                                      |
| Bump the pinned `gh`                      | `docs/agents/hermes/Dockerfile` (the `gh` layer — manual-watch tier)                                                                | pin-watch rebuild (its pre-smoke does `gh --version`)               |
| Rotate / add a secret                     | the host `fluncle-secrets.env.tpl` + `FLUNCLE_GSC_OP_REF` (bootstrap)                                                               | re-run `fluncle-secrets-sync`                                       |

## The recurring tasks

**Pilot or re-run a domain by hand.** On the box, in the container:

```
docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/audit-sweep.sh --domain <key> --dry-run
```

`--dry-run` audits + edits + writes `.audit/report.md` in the workspace (`~/audit-workspace/fluncle`)
without pushing — inspect the diff there. Drop `--dry-run` to open a real PR. Review a specific PR:
`audit-review-sweep.sh --pr <N>`.

**Triage the ledger.** `docs/audit-backlog.md` accumulates the filed (not-auto-fixed) findings,
newest run on top, deduped. Promote the ones worth scheduling into `docs/planning/ROADMAP.md`;
set a row's `status` to `done`/`wontfix` when handled — never silently delete
(status carries the history). A high-impact finding the reviewer held the PR open for is both in the
ledger and on the open PR.

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

- **The reviewer is the merge gate; green CI is decisive.** A clean night opens no PR; a held PR is
  the reviewer working as designed. Don't loosen the reviewer into a rubber stamp.
- **The auditor fixes by confidence, files by impact.** It never edits secrets/`op://`/auth
  tiers/migrations/`.github/workflows`/CI, never uses the TS `!`, and never drives `main` directly —
  only via the reviewed PR. Keep those rails in `_preamble.md`.
- **`/status` is the honesty signal.** `cron.audit` + `cron.audit-review` show freshness (24h
  cadence); a dead PAT or a failed ship shows as stale/degraded there. Watch it after any change.
- **Public repo.** The prompts + scripts carry no secret values or topology — the concrete `op://`
  refs live on the host (`FLUNCLE_GSC_OP_REF`, the sweep tpl), never in these committed files.

Keep this skill and `docs/agents/hermes/audit-timer/README.md` in step when either changes.
