# Installed project skills

`bunx skills@latest` installs project skills here and records them in `skills-lock.json`, lock format version 2. Claude Code reads the same copies through committed relative links at `.claude/skills/<name>`. Codex and OpenCode read this directory directly. Run the CLI through `bunx`: `npx` rejects the root `package.json` overrides with `Override without name`.

For a local skill, edit `packages/skills/<name>`, then run `bunx skills@latest add ./packages/skills/<name> --skill <name> --agent claude-code codex opencode --yes`. Commit the source, installed copy, lock, and Claude link together. For an upstream skill, use its GitHub source with the same named `add` command when refreshing it. Pin an upstream skill whose source keeps moving by appending the commit, as in `owner/repo#<commit>`, which records a `ref` in the lock. `bunx skills@latest experimental_install --frozen-lockfile --agent claude-code codex opencode` restores every copy and Claude link from the lock, and fails when a source no longer matches its locked content hash.

Local lock entries point at Fluncle-owned sources under `packages/skills`. GitHub entries are upstream work redistributed under their own licences; fix those at their source.
