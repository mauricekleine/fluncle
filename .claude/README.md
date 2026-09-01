# Claude Code automation

Checked-in Claude Code config for this repo. Personal overrides go in `settings.local.json` (gitignored).

## Hooks (`settings.json` → `hooks/`)

- **`format-on-edit.sh`** — PostToolUse(Edit|Write). Formats the touched file with `oxfmt` (JS/TS) or `gofmt` (Go) and runs `oxlint --fix`. Best-effort; never blocks an edit.
- **Affected preflight** — PostToolUse(Edit|Write). Queues the fingerprinted dependency closure in the background; `bun run quality:preflight -- join` is the explicit commit/handoff gate.
- **`guard-protected-files.sh`** — PreToolUse(Edit|Write). Blocks hand-edits to generated Drizzle migrations under `apps/web/drizzle/` (use `bun run --cwd apps/web db:generate`) and to `.env`/secret files.

## Subagents (`agents/`)

- **`contract-coverage-reviewer`** — checks API diffs for oRPC contract coverage and correct admin / private-user auth tiers.
- **`canon-reviewer`** — checks `apps/web` UI and copy diffs against `DESIGN.md`, `VOICE.md`, and `PRODUCT.md`.
- **`naming-convention-linter`** — checks new/renamed public surfaces (CLI/API/MCP/SSH/admin) against the `verb_noun` convention in `docs/naming-conventions.md`.
- **`secret-hygiene-reviewer`** — reviews a diff for public-repo secret & topology leaks (committed values, concrete `op://` paths, hostnames, local paths) ahead of the gitleaks CI backstop.

## MCP (`../.mcp.json`)

The GitHub MCP server (remote HTTP) needs a token in the environment:

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...   # least-privilege scopes; never commit
```

## Codex

The same guard, formatter, and affected-preflight hooks are mirrored for Codex in `../.codex/` (`hooks.json` + `hooks/`), adapted to Codex's `apply_patch` edit tool and allow/deny model. See `../.codex/README.md`.
