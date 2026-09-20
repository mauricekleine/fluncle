# Claude Code automation

Checked-in Claude Code config for this repo. Personal overrides go in `settings.local.json` (gitignored).

## Hooks (`settings.json` → `hooks/`)

- **`format-on-edit.sh`** — PostToolUse(Edit|Write). Formats the touched file with `oxfmt` (JS/TS) or `gofmt` (Go) and runs `oxlint --fix`. Best-effort; never blocks an edit.
- **`preflight-on-edit.sh`** — PostToolUse(Edit|Write). Queues the fingerprinted dependency closure in the background (`bun run quality:preflight -- start --quiet`); `bun run quality:preflight -- join` is the explicit commit/handoff gate.
- **Unattended box sweeps skip both PostToolUse hooks.** `FLUNCLE_UNATTENDED=1` (exported by the agentic sweeps, the same marker that promotes the guard to its strict tier) makes `format-on-edit.sh` and `preflight-on-edit.sh` exit at once: `.oxlintrc.json` is type-aware, so even a one-file `oxlint --fix` loads the TypeScript program through tsgolint (2.5–3 GB), and the preflight lanes run it whole — both are killed by the Hermes container's memory cap, and a headless `claude -p` inherits the hooks on every edit it makes. The box's scoped verification is `docs/agents/hermes/scripts/audit/verify.sh`; the PR's CI runs the full lanes. `unattended-skip.test.ts` asserts both halves (attended: invoked; unattended: nothing spawned).
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
