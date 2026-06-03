---
name: fluncle-operator
description: Use when working in the Fluncle repository on the Bun/TypeScript CLI, Turso-backed publishing flow, Spotify/Telegram integration, Raycast extension, local standalone binary setup, or VPS deployment. Triggers include changes to `src/`, `raycast/`, CLI JSON output, `fluncle recent`, Raycast command behavior, `.env.local` handling, or standalone binary deployment.
---

# Fluncle Operator

Use this skill to preserve the core Fluncle architecture: the CLI is the source of truth. Raycast and deployment surfaces should call `fluncle`; they should not reimplement Spotify, Telegram, or Turso behavior.

## Start Here

1. Inspect the current state first:

```bash
git status -sb
rg --files -g '!node_modules' -g '!dist'
```

2. Route by task:

- CLI behavior or JSON contracts: read `references/cli-contract.md`.
- Raycast commands, local install, or command refresh issues: read `references/raycast.md`.
- VPS install or standalone binary deployment: read `references/vps-deploy.md`.

3. Keep `.env.local`, `node_modules`, `dist`, and generated temporary assets out of commits.

## Validation Checklist

Run checks matching the touched surface:

```bash
bun run typecheck
fluncle recent --limit 1 --json
```

For Raycast changes:

```bash
cd raycast
bun run build
bun run lint
```

For CLI changes that affect deployment, rebuild and verify the local or VPS standalone binary. See the deployment references.

## Known Gotchas

- Raycast runs with a minimal shell environment. Do not point Raycast at a Bun-linked `#!/usr/bin/env bun` script; install a standalone macOS binary at the configured CLI path.
- After changing Raycast command manifests, `bun run build` may compile but Raycast may keep stale command indexing. Run `bun run dev` briefly to refresh, then stop it.
- `fluncle add` intentionally treats Spotify track IDs as case-sensitive.
- `fluncle recent` and Raycast recent transmissions must read through the CLI, not directly through Turso.
