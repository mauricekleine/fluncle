# Local database & dev data

How Fluncle does databases across prod, dev, and parallel worktrees. The app stays on **Turso (libSQL)** everywhere; the only thing that changes between environments is the connection URL.

## The shape of it

- **Prod** is the remote `fluncle` Turso database. The deployed Worker reads `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` from Cloudflare secrets and talks to it over HTTPS via `@libsql/client/web`.
- **Local dev** talks to a **per-worktree private libSQL server** (`turso dev`) backed by a plain SQLite file at `apps/web/.dev/local.db`. The app code is unchanged — `db.ts` still uses `@libsql/client/web`; it just points at `http://127.0.0.1:<port>` instead of a remote URL. The rest of the local Worker secrets are rendered from `apps/web/.dev.vars.tpl` with 1Password.
- **The snapshot is pulled from production** (`fluncle`), read-only, via `db:pull-prod`. Prod credentials are never in `.dev.vars` — they live only in 1Password and are read at run time, so pulling prod data is a deliberate, human-in-the-loop step.

Why a local server and not a bare `file:./local.db`? The dev server runs the app inside **workerd** (via `@cloudflare/vite-plugin`), which has no filesystem, and `@libsql/client/web` does not support `file:` URLs. A local libSQL server over HTTP is the one form both the Worker runtime and the dev tooling can share, and it mirrors how prod connects.

## Everyday use

```bash
# Render local Worker secrets from 1Password. Needs FLUNCLE_1PASSWORD_ACCOUNT
# and FLUNCLE_1PASSWORD_ENV_ITEM set in the shell, with the 1Password desktop app ready to unlock.
bun run --cwd apps/web db:secrets

# Start dev: boots this worktree's local libSQL server, applies pending
# migrations, then runs Vite. Cleans up the server on exit.
bun run --cwd apps/web dev

# Refresh local dev data from the latest snapshot (rebuilds local.db).
bun run --cwd apps/web db:refresh-dev

# Refresh the snapshot itself from production (read-only). Needs 1Password
# unlocked. Run this in the main checkout when you want newer data; worktrees
# clone it.
bun run --cwd apps/web db:pull-prod
```

`db:secrets` runs `op inject` against the 1Password item named by `FLUNCLE_1PASSWORD_ENV_ITEM` and writes the plaintext local file at `apps/web/.dev.vars` (gitignored). `dev` is a thin orchestrator (`apps/web/scripts/dev.ts`): it reads `TURSO_DATABASE_URL` from `.dev.vars`, and when that is a local `http://127.0.0.1:…` URL it starts `turso dev --db-file .dev/local.db`, waits for it, runs `db:migrate`, then starts Vite. If the URL is remote it just runs Vite against it.

## Migrations

Use these migration commands:

```bash
bun run --cwd apps/web db:generate   # generate SQL from schema.ts changes
bun run --cwd apps/web db:migrate    # apply pending migrations
```

`db:migrate` targets whatever `TURSO_DATABASE_URL` points at. Locally that is your worktree's own libSQL server, so **migrations in one worktree never touch another worktree's database** — the core reason for the per-worktree setup. `dev` already runs `db:migrate` on boot, so a fresh migration applies the next time you start dev (or run `db:migrate` while dev is up).

## Worktrees

Superset provisions each worktree automatically (`.superset/config.json`): after `bun install`, it renders `.dev.vars` with `db:secrets`, then runs `db:refresh-dev`, which:

1. Picks a deterministic per-worktree port (8100–8999, derived from the worktree path) and rewrites `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` in the worktree's `.dev.vars` to that local server.
2. Rebuilds `apps/web/.dev/local.db` from the golden snapshot at `$SUPERSET_ROOT_PATH/apps/web/.dev/seed.sql` (the main checkout's snapshot). If no snapshot exists yet, it bootstraps one from production via `db:pull-prod` (which needs 1Password unlocked).

So a new worktree comes up with its own isolated, prod-shaped database and a private port. Run several in parallel and their migrations stay independent.

> One caveat for _simultaneous_ dev servers: Vite (and `BETTER_AUTH_URL` / the Spotify redirect) is pinned to `:3000`, so only one `bun run dev` can serve at a time. The database isolation holds regardless — `db:migrate`, tests, and scripts in each worktree hit that worktree's own database whether or not its dev server is running.

### Previewing a worktree's DB-backed routes on localhost

To preview a worktree's DB-backed route in a browser without provisioning anything, copy the main checkout's rendered `apps/web/.dev.vars` into the worktree and run `bun run --cwd apps/web dev:vite` directly — Vite serves the worktree's code against main's already-running `turso dev` (the copied `TURSO_DATABASE_URL` points at main's local server). The plain `dev` script is the wrong entry here: its orchestrator reads that same copied local URL and boots a second `turso dev` on the same port, colliding with main's.

## Keeping dev in sync with prod

The snapshot comes straight from production, so it is as fresh as the last `db:pull-prod`. Everyday local work needs no credentials at all — it only reads the already-dumped `seed.sql`. When you want newer data, unlock 1Password and run `db:pull-prod` in the main checkout, then `db:refresh-dev` in each worktree to adopt it. The pull is read-only (`SELECT`s); production credentials are read at run time from the 1Password item that `FLUNCLE_TURSO_OP_ITEM` points at (`db-pull-prod.ts` reads that env var; the concrete item lives in the ops runbook note) and never touch `.dev.vars`.

## Production deploy & migrations

Cloudflare deploys via Workers Builds, and migrations run as part of the **deploy step**, captured in a committed script so it is not hidden in the dashboard:

```jsonc
// apps/web/package.json
"deploy:cf": "bun run db:migrate:production && bun run db:backfill && bun run db:migrate:telemetry:production && wrangler deploy && bun scripts/purge-edge-cache.ts"
```

`db:migrate:production` runs the phase-bounded `scripts/migrate.ts --phase deploy`, not the ordinary full-journal Drizzle command.

The deploy phase reads the generated journal and the target database's Drizzle ledger, then constructs one atomic libSQL batch ending immediately before the first pending protected contraction. It can apply expansions `0161` through `0168`, but it cannot execute `0169`, `0170`, or `0171`; setting `FLUNCLE_PROTECTED_MIGRATION_APPROVAL` on this path is rejected rather than treated as permission. Once all three contractions have been applied by their attended phases, the same rule advances to later journal entries normally. The local `db:migrate` command and the `dev` startup path remain the full-journal Drizzle path.

The contractions have two fixed attended commands, matching the release manifest rather than accepting an arbitrary `--through` tag. H4 requires the target ledger through `0168`, stops through `0170`, and requires the exact tags it would apply; H8 requires the ledger through `0170`, stops through `0171`, and requires only `0171`. From the initial `0168` state the exact invocations are:

```bash
FLUNCLE_PROTECTED_MIGRATION_APPROVAL=0169_lonely_mariko_yashida,0170_motionless_squadron_supreme bun run --cwd apps/web db:migrate:production:h4
FLUNCLE_PROTECTED_MIGRATION_APPROVAL=0171_watery_skreet bun run --cwd apps/web db:migrate:production:h8
```

Run H4 only after H1–H3, clean-checkout 1×/2×/4× proof, package gates, and attended hosted scratch evidence are green. Run H8 only after H7 and the final 171-index/29-track-index/67-consumer proof is green. A partially applied earlier phase changes the required approval to only its still-pending suffix; never reuse a stale approval. Each bounded migration batch includes its matching Drizzle ledger stamps in the same transaction, so a failed statement rolls back that batch. Applied expansions stay in place on application rollback. Applied contractions are never down-migrated: restore any required index forward before rolling application code back.

`db:backfill` is the idempotent data-backfill step folded into the deploy (a chain of `scripts/backfill-*.ts` scripts, beginning with `scripts/backfill-plan-recording-mixtape.ts`): DDL and the data it populates ship atomically, and because every backfill step is guarded (`where not exists` / convergent updates), re-running it on every deploy is a no-op once done. A new schema change that needs a data backfill appends another `backfill-*.ts` script to the chain rather than relying on a manual post-deploy step.

The telemetry migration is required and runs after the primary backfills but before `wrangler deploy`. Missing telemetry credentials or a failed telemetry migration exits non-zero, so a new Worker cannot become live before its additive run-ledger schema. The telemetry expansion may safely remain if the later Worker deployment fails or is rolled back.

The Cloudflare **Deploy command** is `bun run --cwd apps/web deploy:cf` (build still runs separately as the Build command). Prod `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` and `TURSO_TELEMETRY_DATABASE_URL` / `TURSO_TELEMETRY_AUTH_TOKEN` come from the Cloudflare build/deploy environment, so the two migration steps inspect and migrate their disjoint production databases there.

## Files

- `apps/web/scripts/dev.ts` — local dev orchestrator (server + migrate + Vite).
- `apps/web/scripts/render-dev-vars.ts` — render `apps/web/.dev.vars` from `apps/web/.dev.vars.tpl` via `op inject --account "$FLUNCLE_1PASSWORD_ACCOUNT"`; the 1Password item path comes from `FLUNCLE_1PASSWORD_ENV_ITEM`.
- `apps/web/scripts/db-refresh.ts` — clone the snapshot into this worktree's `local.db` and point `.dev.vars` at a local port.
- `apps/web/scripts/db-pull-prod.ts` — dump production to `.dev/seed.sql` over libSQL HTTP, with prod creds read from 1Password at run time (no `turso` CLI login, no creds in `.dev.vars`). The dump skips `tracks_fts` and its FTS5 shadow tables — a derived artifact ([docs/search.md](./search.md)) the dev flow's own `db:migrate` rebuilds; dumping them double-creates the shadow tables on restore.
- `apps/web/scripts/migrate.ts`: load the real generated SQL, request one fixed production phase, authorize it against the target ledger, and atomically apply only that journal prefix.
- `apps/web/scripts/guard-production-migrations.ts`: validate the generated phase boundary, enforce each attended phase's predecessor ledger, and require the exact pending protected tags while keeping the ordinary deploy phase contraction-free.
- `apps/web/scripts/migrate-telemetry.ts`: keep local unprovisioned runs optional, but make the pre-publication production telemetry migration required and fatal on failure.
- `apps/web/.dev.vars.tpl` — committed 1Password reference template for local Worker secrets.
- `apps/web/.dev/` — local database + snapshot (gitignored).

## Local is not production — never trust `turso dev` for a performance claim

Local `turso dev` and hosted Turso differ in query planning, response limits, and vector behavior. Use local development for correctness and hosted Turso with realistic volume for performance validation.

### The four traps

**1. The probe-binding cliff — bind a query vector as a raw BLOB, never as text.**

| Path (100k rows, one round trip)    | Hosted p50    | Local (sqld) |
| ----------------------------------- | ------------- | ------------ |
| exact scan, probe bound as **text** | **26,700 ms** | 175 ms       |
| exact scan, probe bound as **blob** | **1,883 ms**  | 175 ms       |

A **14× cliff on hosted that does not exist locally.** The text version benchmarks identically in dev and is a catastrophe in prod. This single detail is the difference between a working vector search and an unusable one.

**2. Do not build `libsql_vector_idx` on a populated table.** Hosted creation can block writes, while local creation can yield an empty index. Use an exact `vector_distance_cos` scan behind a btree pre-filter.

**3. The response cap fails loudly in dev and silently in prod.**

Rank growing vector columns in SQL. Local development rejects responses above 10 MiB, while hosted queries can continue until they exhaust the Worker's 128 MB isolate.

**4. A CTE fanned out by `union all` branches is re-executed once per branch — never fan a multi-probe scan out as branches.**

A flattened CTE is re-executed for every `union all` branch or outer `cross join` row. Fold multi-probe distances into one select-list expression. Materialize both sides of a bounded pair scan and pin the small findings table as the driver with `cross join`.

### The rule

**Any query that scans a table which grows with the archive must be proven against hosted Turso before it is claimed to scale** — spin up a scratch Turso Cloud DB, load realistic volume, measure through `@libsql/client/web`, destroy it. Never `fluncle` or `fluncle-dev`. Local dev remains the right tool for correctness, schema, and everyday work; it is simply not evidence about performance.

### Also worth knowing

- Storing a 1024-d vector as JSON text costs **21.8 KB/row**; as `F32_BLOB(1024)` it is ~4 KB. At 100k that is **2,474 MB vs 440 MB — the JSON column alone would be 82% of the database.**
- Reading an `F32_BLOB` back through the driver yields an **`ArrayBuffer`**, not a `Uint8Array`. Handle it.
- Bulk writes are fine: **348 rows/s** on hosted with reads holding at 355 ms p50 during the burst. Writes were never the problem.

`countTrackWork` reads the partial embed-queue index. At 100k tracks it is approximately 54 ms with a 1k backlog and 317 ms when the full corpus is queued. Include the `findings` join only when the predicate references it.
