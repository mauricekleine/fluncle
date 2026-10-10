# Running the admin smokes

Run the four core admin browser smokes by hand or from an agent session in a prepared worktree:

```bash
bun run --cwd apps/web smoke:routine
```

The wrapper ([`apps/web/scripts/smoke-routine.ts`](../../apps/web/scripts/smoke-routine.ts)) starts an isolated `turso dev` libSQL server over this checkout's database, applies migrations, starts Vite, then runs `shell`, `queue` with `SEED=1`, `touch`, and `labels` with `SEED=1` in order. It tears the stack down afterward. The [admin-shell verification guide](../admin-shell.md#verifying) covers individual smokes and the additional admin fixtures.

## Prerequisites and results

Use a local environment with the repository's dependencies, Bun, the Turso CLI, and system Chrome installed. The checkout needs a seeded `apps/web/.dev/local.db` and rendered `apps/web/.dev.vars`; see [local database setup](../local-database.md) for `db:secrets` and `db:refresh-dev`. Both dedicated ports defined in the wrapper must be free, and this checkout's configured libSQL server must be stopped before the wrapper rewrites its bindings. Preflight refuses occupied ports without stopping their processes.

After a stack run, the wrapper prints one machine-readable summary line:

```text
SMOKE ROUTINE: shell=PASS|FAIL queue=PASS|FAIL touch=PASS|FAIL labels=PASS|FAIL
```

It exits `0` only when all four smokes pass. A failing smoke does not prevent the remaining smokes from running. A boot failure reports its error and leaves unrun smokes marked `FAIL`; a preflight failure exits before the summary.

## Database URL contract

`@cloudflare/vite-plugin` loads `apps/web/.dev.vars` as Worker bindings, so passing `TURSO_DATABASE_URL` only through the Vite child's process environment does not override that file. The wrapper temporarily rewrites the file's URL to its dedicated libSQL server so the Worker and the browser fixtures' `loadDevVars` use the same database. It backs up the original under the gitignored `.dev/`, restores it during teardown and on `SIGINT` or `SIGTERM`, and recovers a leftover backup on the next run. Keep other dev processes in this checkout stopped during the run.

## Failure triage

Read each failing assertion, its screenshots or logs, the UI/server code it exercises, and the relevant Git history before changing expectations.

- **Fixture rot:** a deliberate product change explains the failure. Cite that commit, update the stale browser fixture, and rerun `smoke:routine` to confirm all four pass. Ship fixture changes through the repository's normal PR process.
- **Suspected regression:** no deliberate change explains the failure. Preserve the assertion and report the observed behavior, suspect commits, and the surface to inspect. Diagnose the product behavior before weakening the smoke.

If the stack fails to boot, report the boot error separately from assertion failures. For an agent handoff, report one status per smoke (`PASS`, `ROT-FIXED` with its commit, or `REGRESSION-SUSPECTED`) and include details for failures.
