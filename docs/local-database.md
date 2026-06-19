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

## Keeping dev in sync with prod

The snapshot comes straight from production, so it is as fresh as the last `db:pull-prod`. Everyday local work needs no credentials at all — it only reads the already-dumped `seed.sql`. When you want newer data, unlock 1Password and run `db:pull-prod` in the main checkout, then `db:refresh-dev` in each worktree to adopt it. The pull is read-only (`SELECT`s); production credentials are read from the `Turso Production Credentials` item in the Fluncle 1Password vault and never touch `.dev.vars`.

## Production deploy & migrations

Cloudflare deploys via Workers Builds, and migrations run as part of the **deploy step**, captured in a committed script so it is not hidden in the dashboard:

```jsonc
// apps/web/package.json
"deploy:cf": "bun run db:migrate && wrangler deploy"
```

The Cloudflare **Deploy command** is `bun run --cwd apps/web deploy:cf` (build still runs separately as the Build command). Prod `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` come from the Cloudflare build/deploy environment, so the same `db:migrate` runs against prod there.

## Files

- `apps/web/scripts/dev.ts` — local dev orchestrator (server + migrate + Vite).
- `apps/web/scripts/render-dev-vars.ts` — render `apps/web/.dev.vars` from `apps/web/.dev.vars.tpl` via `op inject --account "$FLUNCLE_1PASSWORD_ACCOUNT"`; the 1Password item path comes from `FLUNCLE_1PASSWORD_ENV_ITEM`.
- `apps/web/scripts/db-refresh.ts` — clone the snapshot into this worktree's `local.db` and point `.dev.vars` at a local port.
- `apps/web/scripts/db-pull-prod.ts` — dump production to `.dev/seed.sql` over libSQL HTTP, with prod creds read from 1Password at run time (no `turso` CLI login, no creds in `.dev.vars`).
- `apps/web/.dev.vars.tpl` — committed 1Password reference template for local Worker secrets.
- `apps/web/.dev/` — local database + snapshot (gitignored).
