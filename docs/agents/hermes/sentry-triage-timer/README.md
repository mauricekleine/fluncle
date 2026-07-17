# fluncle-sentry-triage — the nightly Sentry-triage timer

A repo-checked-in host systemd timer on the rave-02 host that checks **Sentry every night** and
opens a fix PR for each production error that is a straightforward fix. It is deliberately its **own
cron on its own set time** — NOT part of the codebase-audit rotation — because Sentry should be
looked at every single night, not one night in seven.

- **`fluncle-sentry-triage`** (03:30 Amsterdam) — reconciles yesterday's merged fixes (resolves
  their Sentry issues), pulls tonight's NEW unresolved issues from both projects, and runs one
  agentic `claude -p` session that fixes the straightforward ones (one PR each) and files the rest
  to `docs/sentry-backlog.md`.

Same host-timer model as every other sweep (`../cron/README.md`): the schedule is code (this unit),
the work is a baked script (`/opt/hermes-scripts/sentry-triage-sweep.{sh,ts}` + `sentry-triage-prompt.md`,
Unit A), and each run self-writes the `/status` freshness marker via `cron-output.sh`. Like the audit
sweep it is a full agentic `claude -p` session (subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`, zero
OpenRouter tokens), so the `.service` `TimeoutStartSec` is an hour, not 300s.

## The schedule (03:30 Amsterdam) and why

A fixed wall-clock slot chosen to sit clear of the box's other nightly ops crons — the audit at
01:00, the DB backup at 03:00, the reach snapshot at 04:00, the audit reviewer at 05:00. 03:30 lands
in the quiet gap after the backup finishes and well before the reviewer. The unit names the
`Europe/Amsterdam` zone explicitly because the host clock is UTC; the registry entry carries the same
`schedule: { time: "03:30", tz: "Europe/Amsterdam" }`, so `/status` computes the true next-fire
across DST.

## How it works (the loop is stateless — GitHub is the store)

The deterministic `sentry-triage-sweep.ts` owns every Sentry API call; the one `claude -p` owns the
code judgment. The two never share a token: the Sentry token stays in the driver, claude only gets
the GitHub PAT (to open PRs). The loop needs no on-box state because GitHub holds it, via the PR-body
markers:

- A **fix PR** body carries `Sentry-Issue: <id>` lines. On a later night, `reconcile` resolves those
  issues **once the PR has merged to `main`** — we resolve only what actually landed, never a blanket
  sweep, so an un-merged or reverted fix never wrongly closes an issue. Reconcile is **bounded to PRs
  merged in the last ~48h** (2 nightly runs of slack): each fix is resolved once, shortly after its
  merge, and never re-resolved forever. That matters because a resolved issue that later **regresses**
  is auto-unresolved by Sentry — an unbounded reconcile would silently re-close it every night,
  masking the regression. A regressed issue's id still lives in its long-merged PR body, but merged
  PRs are **not** in the fetch dedupe set (only open PRs + the ledger are), so the regression
  correctly re-enters the nightly worklist as a fresh issue to triage.
- A **ledger PR** (docs-only) body carries `Sentry-Filed: <id>` lines and appends rows to
  `docs/sentry-backlog.md`, each ending with an invisible `<!-- sentry_id:<id> -->` marker. A filed
  issue is **never** auto-resolved.
- The nightly `fetch` excludes any issue already covered by an open triage PR or an existing ledger
  row, so nothing is triaged twice.

## Auto-merge posture (opt-in)

By default a fix lands as an **open PR on a `sentry-triage/` branch** for the operator to merge — a
merge to `main` is a production deploy, and this cron has no second reviewer behind it (unlike the
audit's 05:00 reviewer). To mirror the audit's "merge on green" posture without a second cron, set
`SENTRY_TRIAGE_AUTOMERGE=1` in the box env: claude then enables GitHub auto-merge on each fix PR
(`gh pr merge --squash --auto`), so a green `deploy:gate` merges it hands-off. That requires the repo
to have auto-merge + required-checks branch protection enabled; if not, the command errors harmlessly
and the PR is left open. Turn it on only once you're happy for green-CI Sentry fixes to reach `main`
unattended.

## Secrets (op-synced, 0600)

The sweep reads these from the shared secrets file `~/.fluncle-secrets.env`, materialized by
`../secrets/fluncle-secrets-sync.sh`:

- `SENTRY_TRIAGE_TOKEN` — **the one new secret.** A Sentry token that can **READ and RESOLVE issues
  and post comments**: an **internal-integration token** (or a user auth token) with `event:read` +
  `event:write` scopes (`event:read` lists issues; `event:write` resolves them + posts notes).
  **An organization auth token will NOT work** — those cannot access the issues/events endpoints.
  Create it under the `fluncle` org (Settings → Developer Settings → Internal Integration). EU region,
  so the sweep talks to `de.sentry.io`.
- `FLUNCLE_AUDIT_GITHUB_PAT` — **REUSED** from the audit (no new PAT): the box's PR-opening PAT
  (Contents + Pull requests write). Drives `git push` + `gh pr create`/`merge`/`comment`.
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code subscription auth (already synced).

Optional env knobs (non-secret; override in the box env if needed): `SENTRY_TRIAGE_AUTOMERGE` (see
above), `SENTRY_TRIAGE_MAX` (issues/night, default 12), `SENTRY_TRIAGE_PROJECTS` (default
`fluncle-web,fluncle-worker`), `SENTRY_TRIAGE_ORG` (default `fluncle`), `SENTRY_TRIAGE_API_BASE`
(default `https://de.sentry.io`).

## Activation (the one-time go-live — operator-gated, NOT this PR)

The repo half ships in this PR (the sweep, the prompt, this timer, the registry/`/status`/prober
wiring, the ledger). **Activation is two operator steps:**

1. **Add the token.** Put `SENTRY_TRIAGE_TOKEN` in the `Fluncle Automations` 1Password vault and add
   it to the box's `fluncle-secrets.env.tpl` (the host template, in the private companion — never in
   this public repo), then re-run `fluncle-secrets-sync`. Until the token is present the timer ticks
   and **skips cleanly** (`{"ok":true,"action":"skipped"}` — a healthy, green `/status` row, not a
   failure).
2. **Install the timer.** `sudo bash docs/agents/hermes/install-host-timers.sh` (it auto-discovers
   this `*-timer/` dir), or enable it alone: `sudo systemctl enable --now fluncle-sentry-triage.timer`.

**Pilot before trusting it** — run one night by hand and inspect what it opens (does NOT need the
timer):

```
docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/sentry-triage-sweep.sh --dry-run
```

(`--dry-run` fetches + triages + edits + writes `.sentry/report.md` in `~/sentry-triage-workspace/fluncle`
without pushing; drop it to open real PRs.)

## Watching it

- `/status` shows `cron.sentry-triage` freshness (24h cadence; the prober reads the `cron-output.sh`
  marker). A dead token or a failed ship shows as stale/degraded there.
- Per-run logs: `journalctl -u fluncle-sentry-triage`, and the markers under
  `~/.hermes/cron/output/fluncle-sentry-triage/`.
- The filed ledger accumulates at `docs/sentry-backlog.md`; the operator triages from it.

## Reset boundary

Same as the other timers: a re-provision restores CODE (baked image, Unit A) + SCHEDULE (this unit,
via `install-host-timers.sh`) + SECRETS (the op sync). Nothing lives only on the box.
