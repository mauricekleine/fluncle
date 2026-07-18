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

Unchanged from before:

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
"deploy:cf": "bun run db:migrate && bun run db:backfill && wrangler deploy"
```

`db:backfill` is the idempotent data-backfill step folded into the deploy (a chain of `scripts/backfill-*.ts` scripts, beginning with `scripts/backfill-plan-recording-mixtape.ts`): DDL and the data it populates ship atomically, and because every backfill step is guarded (`where not exists` / convergent updates), re-running it on every deploy is a no-op once done. A new schema change that needs a data backfill appends another `backfill-*.ts` script to the chain rather than relying on a manual post-deploy step.

The Cloudflare **Deploy command** is `bun run --cwd apps/web deploy:cf` (build still runs separately as the Build command). Prod `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` come from the Cloudflare build/deploy environment, so the same `db:migrate` runs against prod there.

## Files

- `apps/web/scripts/dev.ts` — local dev orchestrator (server + migrate + Vite).
- `apps/web/scripts/render-dev-vars.ts` — render `apps/web/.dev.vars` from `apps/web/.dev.vars.tpl` via `op inject --account "$FLUNCLE_1PASSWORD_ACCOUNT"`; the 1Password item path comes from `FLUNCLE_1PASSWORD_ENV_ITEM`.
- `apps/web/scripts/db-refresh.ts` — clone the snapshot into this worktree's `local.db` and point `.dev.vars` at a local port.
- `apps/web/scripts/db-pull-prod.ts` — dump production to `.dev/seed.sql` over libSQL HTTP, with prod creds read from 1Password at run time (no `turso` CLI login, no creds in `.dev.vars`). The dump skips `tracks_fts` and its FTS5 shadow tables — a derived artifact ([docs/search.md](./search.md)) the dev flow's own `db:migrate` rebuilds; dumping them double-creates the shadow tables on restore.
- `apps/web/.dev.vars.tpl` — committed 1Password reference template for local Worker secrets.
- `apps/web/.dev/` — local database + snapshot (gitignored).

## Local is not production — never trust `turso dev` for a performance claim

**Measured 2026-07-11** against both a local `turso dev` (sqld 0.24.31) and a scratch hosted Turso Cloud DB (server 2026.7.7), through `@libsql/client/web` — the exact HTTP driver the Worker uses. The two diverge on precisely the behaviours that decide whether a query survives the archive growing, and **the local one is misleading in the dangerous direction**: it makes slow code look fast and broken code look fine.

This is not a "local is a bit different" caveat. A developer can benchmark a change locally, see clean numbers, and ship a query that takes **27 seconds** in production. Treat every local performance number as meaningless.

### The four traps

**1. The probe-binding cliff — bind a query vector as a raw BLOB, never as text.**

| Path (100k rows, one round trip)    | Hosted p50    | Local (sqld) |
| ----------------------------------- | ------------- | ------------ |
| exact scan, probe bound as **text** | **26,700 ms** | 175 ms       |
| exact scan, probe bound as **blob** | **1,883 ms**  | 175 ms       |

A **14× cliff on hosted that does not exist locally.** The text version benchmarks identically in dev and is a catastrophe in prod. This single detail is the difference between a working vector search and an unusable one.

**2. `libsql_vector_idx` is a foot-gun — never build one on a populated table.**

- **Hosted:** `CREATE INDEX … libsql_vector_idx` against existing rows failed with `database is locked` and **wedged the database's write path for over 20 minutes.** On the production DB that is an outage.
- **Local:** the same statement **silently builds an EMPTY index.** The shadow table has 0 rows, `vector_top_k` returns nothing, and **no error is raised** — so the feature appears to work and quietly returns garbage.
- Index-first inserts collapse to **0.5 rows/s and degrading** (vs 217 rows/s without the index), and the only build-tractable config (`float1bit`) drops recall@20 to **21.6%** on clustered data — it returns the wrong neighbours four times out of five.

**The ratified shape is the boring one:** an exact `vector_distance_cos` scan with a **btree pre-filter** before it. Filtering by galaxy (11k candidates) or camelot+BPM (8.3k) takes 100k from 1,883 ms to **274 ms / 207 ms** — one round trip, no ANN index, nothing that can wedge the system of record.

**3. The response cap fails loudly in dev and silently in prod.**

`turso dev` enforces a **10 MiB response cap**; hosted does not. So a query that pulls a large column into the isolate to rank it in JS will **throw in local dev** (at ~460 rows of 21.8 KB embeddings) while in production it just keeps growing — toward **OOMing the 128 MB Worker isolate**, with no error until it dies. That is backwards from a safe failure mode, and it is exactly how `getSimilarFindings` shipped a latent time bomb. **Rank in SQL; never pull a growing column into the isolate.**

**4. A CTE fanned out by `union all` branches is re-executed once per branch — never fan a multi-probe scan out as branches.**

**Measured 2026-07-18** on the production DB, diagnosing the 45-second `/recommendations` page. A multi-probe max-similarity scan written as `with candidates as (…)` + one `union all` branch per probe is NOT materialized: the planner **flattens the CTE into the compound query as a co-routine and re-runs the candidate scan once per branch**. Twelve seed probes meant twelve full passes over `tracks` (23k rows, each dragging the 4 KB `F32_BLOB`) — **63 s hosted**. Locally the table is small, so the shape benchmarks fine and ships.

The ratified multi-probe shape is **one pass with the probes folded in the select list**: `min(vector_distance_cos(vec, ?), vector_distance_cos(vec, ?), …)` — same distance count, one scan, no temp table (an `as materialized` CTE works too, but it copies every candidate's 4 KB vector into a temp table, which becomes its own cliff as candidates grow). Two SQLite details that bite: single-argument `min()` is the **aggregate**, so a one-probe query binds the bare distance term; and when a tiny table should drive the join (74 `findings` vs 23k `tracks`), pin it with `cross join` — the planner picked the 23k-row table as the outer loop on its own. The fixed engine is `listRecommendations` (`apps/web/src/lib/server/recommendations.ts`): 63 s → well under a second.

### The rule

**Any query that scans a table which grows with the archive must be proven against hosted Turso before it is claimed to scale** — spin up a scratch Turso Cloud DB, load realistic volume, measure through `@libsql/client/web`, destroy it. Never `fluncle` or `fluncle-dev`. Local dev remains the right tool for correctness, schema, and everyday work; it is simply not evidence about performance.

### Also worth knowing

- Storing a 1024-d vector as JSON text costs **21.8 KB/row**; as `F32_BLOB(1024)` it is ~4 KB. At 100k that is **2,474 MB vs 440 MB — the JSON column alone would be 82% of the database.**
- Reading an `F32_BLOB` back through the driver yields an **`ArrayBuffer`**, not a `Uint8Array`. Handle it.
- Bulk writes are fine: **348 rows/s** on hosted with reads holding at 355 ms p50 during the burst. Writes were never the problem.

### The embed queue's `--count` at 100k — proven cheap (2026-07-12)

The one scale claim from the catalogue sprint left unproven against hosted Turso: the embed work-queue's backlog count (`fluncle admin tracks work --kind embed --count`, `countTrackWork` in `apps/web/src/lib/server/track-work.ts`), a `count(*)` over the partial index `tracks_embed_queue_idx` (`ON tracks(track_id) WHERE source_audio_key is not null and embedding_json is null`). Claim: cheap because the partial index holds only the un-embedded backlog, not the archive. Measured against a scratch hosted DB (100k `tracks` + 5k `findings`, the real DDL) through `@libsql/client/web`, p50 over 10 runs, one round trip from this Mac. The count query verbatim:

```sql
select count(*) as queued from tracks t
left join findings f on f.track_id = t.track_id
where 1 = 1 and t.source_audio_key is not null and t.embedding_json is null
```

| State (100k `tracks`)                             | `--count` (scope=all) | page read (200 rows) | plain `count(*)` ref |
| ------------------------------------------------- | --------------------- | -------------------- | -------------------- |
| **A — steady state** (~1k un-embedded backlog)    | **53.6 ms**           | 97.3 ms              | 47.1 ms              |
| **B — cold start** (100k un-embedded, index full) | **316.5 ms**          | 185.1 ms             | 141.1 ms             |

`explain query plan` in **both** states is `SCAN t USING INDEX tracks_embed_queue_idx` — the count is always served from the partial index, never a table scan. In steady state the index carries only the ~1k backlog, so the count returns in ~50 ms **regardless of the 100k archive behind it** — the claim holds exactly as stated. The pathological cold-start case (the whole archive un-embedded, so the partial index is at full 100k size) still stays sub-second at ~320 ms for the default `all` scope. The only latent cost worth naming: the count carries the `left join findings` in its FROM even though the join is a semantic no-op for a `count(*)` at `scope=all` (`findings.track_id` is unique, so it can neither filter nor fan out), and the planner probes it 100k times in State B — that join probe, not any table scan, is the whole gap between the 316 ms worst case and the 141 ms bare `count(*)`.

**Verdict:** ship it. The `--count` is cheap in the state that matters (~50 ms steady, reading only the backlog-sized partial index) and bounded sub-second even in the worst case a cold crawl can produce; it touches none of the three cliffs above. **Cold start shaved (2026-07-12):** `countTrackWork` (`apps/web/src/lib/server/track-work.ts`) now includes the `left join findings` only when its assembled predicate references `f` — a `findings`/`catalogue` scope, or the `capture` kind — so `embed`/`analyze` at `scope=all` count a bare `from tracks` and skip the per-row join probe (~175 ms of the 316 ms worst case). Inclusion is derived structurally from the predicate string, not a kind/scope table, and it changes no result (`findings.track_id` is unique, so an unreferenced left join can neither filter nor fan out); the `track-work.integration.test.ts` "dropping the un-read findings join changes no count" case proves the equality for every kind × scope.
