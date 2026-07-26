---
name: fluncle-operator
description: Use when working in the Fluncle repository on the Bun/Turborepo monorepo, CLI, Turso-backed publishing flow, Spotify/Telegram integration, Raycast extension, TanStack Start web app, local standalone binary setup, or VPS deployment. Triggers include changes to `apps/cli/src/`, `apps/raycast/`, `apps/web/`, CLI JSON output, `fluncle recent`, Raycast command behavior, local config and CLI env profiles, or standalone binary deployment.
---

# Fluncle Operator

`AGENTS.md` at the repo root is the standing law and this skill does not restate it: its **Architecture** section owns the module boundaries (`apps/web` owns the public and admin API surfaces, the CLI is a thin HTTP client, Raycast calls `fluncle` rather than reimplementing Spotify/Telegram/Turso, publishing authority stays behind the authenticated admin API), and its **Quality Checks** section owns which commands to run for the surface you touched. Read them there — a second copy here only rots.

What this skill adds is the per-surface routing below and the gotchas AGENTS.md is too high-level to carry.

## Route by task

- CLI behavior or JSON contracts: read `references/cli-contract.md`.
- Raycast commands, local install, or stale-command issues: read `references/raycast.md`.
- VPS install or standalone binary deployment: read `references/vps-deploy.md`.
- Public web app or admin surfaces: `AGENTS.md` → Architecture. New HTTP surfaces go on oRPC contract ops (`packages/contracts/src/orpc/**`, registered in the `apps/web/src/lib/server/orpc/**` router); the `apps/web/src/routes/api` file routes are only the documented carve-outs.
- Local config and env profiles, all of it uncommitted: `apps/web/.dev.vars` is the web app's local env (template at `apps/web/.dev.vars.tpl`), `apps/web/.dev/` holds the per-worktree libSQL database (see [docs/local-database.md](../../../docs/local-database.md)), and the CLI reads its own operator profiles from `~/.config/fluncle/.env.<profile>` outside the repo (`--env local` / `--env production`).

## Known Gotchas

- Raycast runs with a minimal shell environment. Do not point Raycast at a Bun-linked `#!/usr/bin/env bun` script; install a standalone macOS binary at the configured CLI path.
- After changing Raycast command manifests, `bun run build` may compile while Raycast keeps stale command indexing. Run `bun run dev` briefly to refresh, then stop it.
- `fluncle admin tracks publish` intentionally treats Spotify track IDs as case-sensitive.
- `fluncle recent` and the Raycast recent-bangers command must read through the CLI, never directly through Turso.
