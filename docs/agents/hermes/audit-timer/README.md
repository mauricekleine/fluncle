# fluncle-audit + fluncle-audit-review — the nightly codebase-audit timers

Two repo-checked-in host systemd timers on the rave-02 host that keep the codebase top-notch
without a human in the loop each night:

- **`fluncle-audit`** (01:00 Amsterdam) — the **auditor**. Picks one domain on a 7-day rotation,
  audits it deeply, fixes what's safe, files the rest to `docs/audit-backlog.md`, and opens a PR.
- **`fluncle-audit-review`** (05:00 Amsterdam) — the **reviewer**. Reviews the auditor's PR
  adversarially: fixes small residual nits and **merges** when CI is green and nothing
  high-impact remains, else comments and leaves it open for the operator.

Same host-timer model as every other sweep (`../cron/README.md`): the schedule is code (these
units), the work is a baked script (`/opt/hermes-scripts/audit-sweep.sh` +
`audit-review-sweep.sh` + the `audit/` tree, Unit A), and each run self-writes the `/status`
freshness marker via `cron-output.sh`. Unlike the thin Worker-trigger sweeps, each of these is a
full agentic `claude -p` session (subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`, zero
OpenRouter tokens), so the `.service` `TimeoutStartSec` is an hour, not 300s.

## The rotation

`audit/rotation.ts` maps the day → one domain by `epoch-day mod 7` (stateless, continuous across
year boundaries, timezone-independent):

`design · voice · architecture · security · surfaces-seo · docs · tests`

Each domain has a brief at `audit/prompts/<domain>.md`, appended after the shared operating
contract `audit/prompts/_preamble.md`. The reviewer uses `audit/prompts/_reviewer.md`.

## The contract (why it's safe to run unattended)

- **Fix-vs-file by impact, not size** — the auditor fixes what it's confident is correct and can
  verify; it _files_ the high-impact/high-risk/judgment findings to the committed ledger
  `docs/audit-backlog.md` (so they survive an auto-merge). Details in `_preamble.md`.
- **Hard rails** — never edits secrets/`.env`/`op://`/topology, auth-tier guards, Drizzle
  migrations, `.github/workflows/*`, or CI/deploy config; never uses the TypeScript `!`.
- **The reviewer is the gate** — green required CI is the decisive merge signal; a high-impact
  finding holds the PR open with a comment. A clean night opens no PR.
- **Isolated workspace** — both scripts operate in `~/audit-workspace/fluncle` (a dedicated
  clone freshened to `origin/main` each run), never `/opt/fluncle-build` or the baked scripts.

## Secrets (op-synced, 0600)

The sweeps read these from the shared secrets file `~/.fluncle-secrets.env` (+ a json file for
GSC), materialized by `../secrets/fluncle-secrets-sync.sh` from the `Fluncle Automations` vault:

- `FLUNCLE_AUDIT_GITHUB_PAT` — fine-grained PAT (Contents + Pull requests write, Actions read) on
  `mauricekleine/fluncle`. Drives `git push` + `gh pr create`/`merge`/`comment` (both agents use
  `GH_TOKEN`; no token is written to disk — the git credential helper is `gh auth git-credential`).
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code subscription auth (already synced).
- `FLUNCLE_BING_WEBMASTER_API_KEY` — Bing Webmaster (surfaces-seo day).
- `GOOGLE_APPLICATION_CREDENTIALS=~/.fluncle-gsc.json` — the GSC service-account key on disk (its
  json can't be a shell env var; the sync `op read`s it to a 0600 file).

## Activation (the one-time go-live)

The units are installed by `../install-host-timers.sh` (it auto-discovers every `*-timer/` dir),
but like `embed`/`capture` they are **gated at first deploy** behind a pilot:

1. Ensure the image carries `gh` (baked in the Dockerfile) and the four secrets are synced.
2. **Pilot** — run one domain by hand and inspect the PR it opens (does NOT need the timers):
   ```
   docker exec -u hermes -e HOME=/opt/data/home hermes bash /opt/hermes-scripts/audit-sweep.sh --domain surfaces-seo --dry-run
   ```
   (`--dry-run` audits + edits + writes `.audit/report.md` without pushing; drop it to open a real PR.)
3. Once a pilot PR looks right, enable both timers:
   ```
   sudo systemctl enable --now fluncle-audit.timer fluncle-audit-review.timer
   ```
   (or re-run `install-host-timers.sh`, which enables every timer).

## Watching it

- `/status` shows `cron.audit` + `cron.audit-review` freshness (24h cadence; the prober reads the
  `cron-output.sh` markers). A dead PAT or failed ship shows as stale/degraded there.
- Per-run logs: `journalctl -u fluncle-audit` / `-u fluncle-audit-review`, and the markers under
  `~/.hermes/cron/output/fluncle-audit{,-review}/`.
- The findings ledger accumulates at `docs/audit-backlog.md`; the operator triages from it.

## Reset boundary

Same as the other timers: a re-provision restores CODE (baked image, Unit A) + SCHEDULE (these
units, via `install-host-timers.sh`) + SECRETS (the op sync). Nothing lives only on the box.
