# Installed project skills

`npx skills` installs project skills here and records them in `skills-lock.json`. Claude Code reads the same copies through committed relative links at `.claude/skills/<name>`. Codex and OpenCode read this directory directly.

For a local skill, edit `packages/skills/<name>`, then run `npx skills add ./packages/skills/<name> --skill <name> --agent claude-code codex opencode --yes`. Commit the source, installed copy, lock, and Claude link together. For an upstream skill, use its GitHub source with the same named `add` command when refreshing it. `npx skills experimental_install` restores copies from the lock but does not recreate Claude links.

Local lock entries point at Fluncle-owned sources under `packages/skills`. GitHub entries are upstream work redistributed under their own licences; fix those at their source.
