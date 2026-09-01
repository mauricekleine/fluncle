# Codex hooks

Codex mirror of the Claude Code automation in `../.claude/`. The same hooks (and the same four subagents, mirrored under `agents/` as TOML) are adapted to Codex's model (see https://developers.openai.com/codex/hooks.md). Defined in `hooks.json`; scripts in `hooks/`.

- **`format-on-edit.sh`** — PostToolUse(`apply_patch`). Formats touched files with `oxfmt`/`gofmt` + `oxlint --fix`. Best-effort; always exits 0.
- **Affected preflight** — PostToolUse(`apply_patch`). Queues the fingerprinted dependency closure in the background; `bun run quality:preflight -- join` is the explicit commit/handoff gate.
- **`guard-protected-files.sh`** — PreToolUse(`apply_patch`). Exit 2 (block) on hand-edits to generated Drizzle migrations under `apps/web/drizzle/` (use `db:generate`) or to `.env`/secret files.

## Codex specifics

- File edits run through the **`apply_patch`** tool, so the edit hooks match `apply_patch` (not `Edit|Write`) and parse touched paths from the patch envelope's `*** … File:` markers.
- Codex `PreToolUse` supports only `allow`/`deny`, with no soft "ask".
- Hook commands run with the session cwd (repo root) as their working directory, so the script paths are repo-relative.
- Codex requires you to **review and trust** these hooks before they run — run `/hooks` once to trust them.

`config.toml` holds unrelated Codex config (`approvals_reviewer`); hooks live in `hooks.json` so the two stay separate.
