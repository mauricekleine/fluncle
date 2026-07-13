---
name: fluncle-operator
description: Use when working in the Fluncle repository on the Bun/Turborepo monorepo, CLI, Turso-backed publishing flow, Spotify/Telegram integration, Raycast extension, TanStack Start web app, local standalone binary setup, or VPS deployment. Triggers include changes to `apps/cli/src/`, `apps/raycast/`, `apps/web/`, CLI JSON output, `fluncle recent`, Raycast command behavior, `.env.local` handling, or standalone binary deployment.
---

# Fluncle Operator

Use this skill to preserve the core Fluncle architecture: `apps/web` owns public and admin API routes, including Spotify, Telegram, and Turso mutation behavior. The CLI is a thin HTTP client for public reads and authenticated admin commands. Raycast and deployment surfaces should call `fluncle`; they should not reimplement Spotify, Telegram, Turso, or HTTP API behavior.

## Start Here

1. Inspect the current state first:

```bash
git status -sb
rg --files -g '!node_modules' -g '!dist'
```

2. Route by task:

- CLI behavior or JSON contracts: read `references/cli-contract.md`.
- Raycast commands, local install, or command refresh issues: read `references/raycast.md`.
- Public web app or fluncle.com changes: put public/admin HTTP surfaces on oRPC contract ops (`packages/contracts/src/orpc/**`, registered in the `apps/web/src/lib/server/orpc/**` router) with server modules under `apps/web/src/lib/server`; `apps/web/src/routes/api` file routes are only the documented carve-outs (auth redirects, uploads/streaming, non-JSON emitters, `/status`+`/health`) — see `AGENTS.md` Architecture.
- VPS install or standalone binary deployment: read `references/vps-deploy.md`.

3. Keep `.env.local`, `.dev.vars`, `node_modules`, `dist`, and generated temporary assets out of commits.

## Validation Checklist

Run checks matching the touched surface:

```bash
bun run typecheck
bun run --cwd apps/cli fluncle recent --limit 1 --json
```

For Raycast changes:

```bash
bun run --cwd apps/raycast build
bun run --cwd apps/raycast lint
```

For web changes:

```bash
bun run --cwd apps/web typecheck
bun run --cwd apps/web build
bun run --cwd apps/web lint
```

For CLI changes that affect deployment, rebuild and verify the local or VPS standalone binary. See the deployment references.

## Known Gotchas

- Raycast runs with a minimal shell environment. Do not point Raycast at a Bun-linked `#!/usr/bin/env bun` script; install a standalone macOS binary at the configured CLI path.
- After changing Raycast command manifests, `bun run build` may compile but Raycast may keep stale command indexing. Run `bun run dev` briefly to refresh, then stop it.
- `fluncle admin tracks publish` intentionally treats Spotify track IDs as case-sensitive.
- `fluncle recent` and the Raycast recent bangers command must read through the CLI, not directly through Turso.
- `apps/web` owns server-side API behavior. Public routes can read Turso; authenticated admin routes can publish to Spotify and Telegram.
