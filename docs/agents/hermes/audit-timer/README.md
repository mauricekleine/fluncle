# fluncle-audit + fluncle-audit-review — the nightly codebase-audit timers

Two repo-checked-in host systemd timers on the rave-02 host that keep the codebase top-notch
without a human in the loop each night:

- **`fluncle-audit`** (01:00 Amsterdam) — the **auditor**. Picks one domain on an 8-day rotation,
  audits it deeply, fixes what's safe, files the rest to `docs/audit-backlog.md`, and opens a PR.
- **`fluncle-audit-review`** (05:00 Amsterdam) — the **reviewer**. Reviews the auditor's PR
  adversarially: fixes small residual nits and **merges** when CI is green and nothing
  high-impact remains, else comments and leaves it open for the operator.

Same host-timer model as every other sweep (`../cron/README.md`): the schedule is code (these
units), the work is a baked script (`/opt/hermes-scripts/audit-sweep.sh` +
`audit-review-sweep.sh` + the `audit/` tree, Unit A), and each run self-writes the `/status`
freshness marker via `cron-output.sh`. Unlike the thin Worker-trigger sweeps, each of these is a
full agentic `claude -p` session (subscription auth via `CLAUDE_CODE_OAUTH_TOKEN`, zero
OpenRouter tokens), so each pass carries a long wall budget rather than the thin sweeps' 300s —
owned by the script, with the unit's `TimeoutStartSec` as the outer backstop (see _Failure is
loud_ below).

## The rotation

`audit/rotation.ts` maps the day → one domain by `epoch-day mod 8` (stateless, continuous across
year boundaries, timezone-independent):

`design · voice · architecture · security · surfaces-seo · docs · tests · db-query-shape`

Each domain has a brief at `audit/prompts/<domain>.md`, appended after the shared operating
contract `audit/prompts/_preamble.md`. The reviewer uses `audit/prompts/_reviewer.md`.

Adding a domain is three edits in `audit/rotation.ts` + one new file, and `rotation.test.ts` pins
all three together: append the key to `DOMAINS`, add its `DOMAIN_META` label + blurb, and write
`audit/prompts/<key>.md`. The driver is domain-agnostic (it resolves the brief by name), so nothing
in `audit-sweep.sh` or the units changes — the next rotation slot picks the new domain up on its own.

`db-query-shape` is the newest slot (added 2026-07-26): the semantic half of the DB-scale guardrail
from `docs/db-scale-backlog.md` — it hunts recompute-by-full-scan on the four growing tables
(`tracks`, `crawl_frontier`, `track_artists`, `findings`-as-anti-join) that the static build-fail net
`apps/web/src/lib/server/db-query-shape.test.ts` cannot see. It fixes hoists and rewrites; an index
or a stored column is always filed, gated on an operator-run hosted-Turso proof.

## The box-fit contract (why the audit runs less than `bun run check`)

The hermes container's memory cap is shared by ~40 sweeps, the paid capture lane, and the MuQ embed trickle that holds torch resident. The repo's whole-repo passes do not fit in what is left, and no knob makes them fit — the peak is one TypeScript program graph, not parallelism:

| pass                             | peak RSS | note                                                                    |
| -------------------------------- | -------- | ----------------------------------------------------------------------- |
| whole-repo type-aware lint       | 3.34 GB  | 3.55 GB at `--threads=2` — the thread pool is not what holds the memory |
| whole-repo `turbo run typecheck` | 2.81 GB  | 2.91 GB at `--concurrency=1` — serializing does not lower it either     |
| `apps/web typecheck` alone       | 2.80 GB  | one package IS the whole-repo figure                                    |
| `apps/cli typecheck`             | 0.36 GB  | a normal package fits comfortably                                       |
| **path-scoped type-aware lint**  | 1.50 GB  | what the ladder actually runs                                           |

`tsgolint` is a Go binary, so a Node heap cap (`--max-old-space-size`) never reaches the process doing the allocating — which is why there is no heap-cap knob here.

So both agents verify through **one command**, [`../scripts/audit/verify.sh`](../scripts/audit/verify.sh), which derives the changed paths, runs formatting and the lint rules scoped to them, then each changed package's own `typecheck` and `test`, each behind a wall budget and a cgroup-headroom precondition. A step it cannot afford is recorded as `skipped` with a reason (`no-headroom`, `ci-only`, `no-script`) rather than started into an OOM kill. The record lands in `.audit/verify.json` and the driver folds it into the summary line, so "which checks ran" is a fact in the run ledger instead of a claim in a report.

Nothing is lost by not running the whole-repo passes here: every one of them runs on the PR the audit opens (the `quality-checks` action) and again in `deploy:gate` before Cloudflare deploys, and the reviewer merges only on green required checks. Running them a third time on the smallest machine in the chain gated nothing.

`verify.sh` lives in the CHECKOUT the agents audit, not only in the baked image, so a change to the ladder reaches the next night the moment it merges — no rebake.

## Failure is loud (how a bad night reaches the ledger)

Three failure shapes used to reach the run ledger as healthy nights. Each now writes `ok:false` with a `reason`:

- **The unit timeout is a backstop, not a budget.** `TimeoutStartSec` kills the host-side `docker exec` CLIENT; the container-side sweep keeps running, finishes minutes later, and writes its ordinary marker and ledger row. A unit reading `Result=timeout` on the host therefore sat beside an `ok:true` ledger row. The real budget now lives in the script ([`../scripts/agent-pass.sh`](../scripts/agent-pass.sh), `AGENT_PASS_BUDGET_SECS`), which always exits on its own terms. **The ordering invariant:** the script's budget plus its kill grace plus the driver's clone/install/ship time must stay strictly under the unit's `TimeoutStartSec`, or the host kill races the script again. Both `.service` files restate it.
- **An OOM-killed child does not fail its parent.** The agent survives, reports "that check did not run", and exits 0. The helper samples the cgroup's own `memory.events` `oom_kill` counter either side of the pass and reports the delta as `container_oom_kills`; any delta fails the run. The counter is container-wide, so a neighbour sweep's kill also fails the audit night — deliberately: on one shared cap that is the same capacity problem, and the operator needs to see the night it happened.
- **Work nobody checked.** A night with commits and no `.audit/verify.json` is `reason:"unverified"`; a ladder record carrying `failed > 0` is `reason:"verify-failed"`.

The unit's `OnFailure=fluncle-sweep-failure@%n.service` still posts the Discord line for a death so hard the script never runs at all (see [../sweep-failure/README.md](../sweep-failure/README.md)); the script-side budget is what makes every softer failure visible in the ledger.

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
- Both summary lines DERIVE their `ok` from the run's own `errors` count, the same rule the run
  ledger applies server-side (`exit_code === 0 && (summary.errors ?? 0) === 0`). So a night whose
  `claude -p` returned nonzero reads `ok:false` on the marker even when the branch was otherwise
  clean or the PR did open — read `errors` and `action` together, not `action` alone.
- Every summary carries `pass_seconds` and `container_oom_kills`; a bad night adds `reason`
  (`budget-exceeded` · `oom-killed` · `nonzero-exit` · `verify-failed` · `unverified`) and the
  auditor's carries `verify` — the ladder's `{ran, skipped, failed, steps}` record. `pass_seconds`
  creeping toward `AGENT_PASS_BUDGET_SECS`, or a nonzero `container_oom_kills`, is the box telling
  you it is at its cap before a night actually fails.
- Per-run logs: `journalctl -u fluncle-audit` / `-u fluncle-audit-review`, and the markers under
  `~/.hermes/cron/output/fluncle-audit{,-review}/`.
- The findings ledger accumulates at `docs/audit-backlog.md`; the operator triages from it.

## What ships how

- **BAKED** (into the image, self-deploys from `main` via the on-box `fluncle-pin-watch` rebuild + swap; no operator step): `../scripts/audit-sweep.sh`, `../scripts/audit-review-sweep.sh`, `../scripts/agent-pass.sh`, `../scripts/audit/` (the prompts, the rotation, `verify.sh`).
- **HOST-INSTALLED** (the `.service` / `.timer` units; a change needs the operator to refresh them):

  ```
  sudo bash docs/agents/hermes/install-host-timers.sh \
    --refresh-unit fluncle-audit.service --refresh-unit fluncle-audit-review.service
  ```

  Run it from a checkout of `main` on the box after a unit change — `TimeoutStartSec` in particular, since the script-budget ordering invariant above depends on it.

## Reset boundary

Same as the other timers: a re-provision restores CODE (baked image, Unit A) + SCHEDULE (these
units, via `install-host-timers.sh`) + SECRETS (the op sync). Nothing lives only on the box.
