# Raycast Workflow

Raycast extension lives in `apps/raycast/`.

## Architecture

Raycast is a thin client over the CLI:

```text
Raycast -> fluncle CLI -> Spotify / Telegram / Turso
```

Do not import Turso/libSQL, Spotify clients, or Telegram APIs inside `apps/raycast/src`.

## Commands

Current commands:

- `quick-add`: no-view command; reads clipboard and runs `fluncle add <url> --json`.
- `add-track`: form command; Spotify URL plus optional note.
- `recent-transmissions`: list command; runs `fluncle recent --json`.

Do not re-add a separate note command unless there is a materially different workflow. `Add Track` already includes an optional note field and clipboard-prefills the URL.

## Local CLI Path

Raycast preferences should point to:

```text
/Users/maurice/.local/bin/fluncle
```

This must be a standalone binary, not a Bun-linked script. Raycast may fail with `env: bun: No such file or directory` if the path resolves to `#!/usr/bin/env bun`.

Build/install the local standalone binary:

```bash
bun run --cwd apps/cli build:local
mkdir -p ~/.config/fluncle
install -m 600 ./.env.local ~/.config/fluncle/.env.local
install -m 755 ./apps/cli/dist/fluncle-darwin-arm64 ~/.local/bin/fluncle
```

Verify from outside the repo:

```bash
cd /tmp
fluncle recent --limit 1 --json
```

## Raycast Checks

```bash
bun install
bun run --cwd apps/raycast build
bun run --cwd apps/raycast lint
```

After manifest command changes, refresh Raycast command indexing:

```bash
bun run --cwd apps/raycast dev
```

Wait until it says the entry points are built, then stop the watcher. This is often needed after adding/removing commands.

## Non-Mutating Launch Checks

Use Recent Transmissions for a safe Raycast UI check. Quick Add publishes on success, so use it only with a track the user agrees to publish, or with a known duplicate for a non-mutating error-path check.
