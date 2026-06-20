# Repository Instructions

Concise rules for working in Fluncle. Use MUST/SHOULD/NEVER to guide decisions.

## Instruction Scope

- User instructions for the current task override this file.
- More specific instructions from tools, skills, or nested agent files override root guidance for their scope.
- If instructions conflict with system/tool safety rules, follow the higher-priority rule and mention the conflict.
- Prefer the smallest change that fully solves the task.

## Work Standard

- MUST: Prefer a complete, durable fix over a workaround when the full fix is reasonably reachable in the current task.
- MUST: Build the real implementation instead of papering over behavior when the implementation path is small and well-scoped.
- MUST: Search the codebase before adding new patterns, helpers, dependencies, or abstractions.
- MUST: Carry implementation work through verification: update focused tests/docs when behavior changes, run the relevant checks, and report any checks that could not be run.
- MUST: Close obvious follow-through items discovered during the task when they are directly related and low-risk.
- SHOULD: Ask before expanding scope into unrelated refactors, production changes, paid infrastructure, destructive operations, or work that changes product direction.
- NEVER: Stop at a plan when the user asked for implementation and the implementation is feasible.
- NEVER: Present a workaround as complete when a known real fix remains.

## Before Editing

- MUST: Inspect existing code patterns before changing implementation.
- MUST: Check `git status --short` and avoid reverting unrelated user changes.
- MUST: Read area docs before touching UI, API routes, database schema, publishing flows, Raycast integration, deployment, or CLI behavior.
- SHOULD: Prefer focused reads/searches over loading broad docs by default.

## Commands

- MUST: Use `bun` for repo scripts and package management unless a documented tool requires otherwise.
- MUST: Use `rg` for code search when available.
- NEVER: Use `npm`, `pnpm`, or `yarn` for installs unless the task targets tooling that explicitly requires them.
- NEVER: Run `prettier` or `bunx prettier` in this repo. Formatting is owned by `oxfmt`; use `bunx oxfmt <files>` or `bun run check`.

## Quality Checks

- TypeScript: `bun run typecheck` from the repo root, or the nearest package `typecheck` for focused changes.
- Lint and format: `bun run check` from the repo root for broad validation.
- Web changes: `bun run --cwd apps/web typecheck`, `bun run --cwd apps/web build`, and `bun run --cwd apps/web lint` when relevant.
- CLI changes: `bun run --cwd apps/cli typecheck` and focused CLI commands such as `bun run --cwd apps/cli fluncle recent --limit 1 --json` when behavior changes.
- Raycast changes: `bun run --cwd apps/raycast build` and `bun run --cwd apps/raycast lint`.
- SSH app changes: `go build -C apps/ssh ./...`, `gofmt -l apps/ssh` (must list nothing), and `go vet -C apps/ssh ./...`.
- Video package changes: `bun run --cwd packages/video typecheck`.
- SHOULD: Run focused checks first, then broader root checks when the change has cross-package or user-facing risk.
- SHOULD: For docs-only changes, verify formatting/readability instead of running full test suites unless docs generation is affected.

## External Effects

- MUST: Ask before destructive operations, production deploys, paid infrastructure changes, bulk sends, credential rotations, or changes that publish to Spotify, Telegram, Discord, or Cloudflare.
- MUST: Report when required validation depends on external services and could not be run locally.
- NEVER: Invent secrets, credentials, listener data, analytics data, or production state.

## Library and API Docs

- MUST: Use Context7 MCP to fetch current documentation whenever library, framework, SDK, API, CLI tool, or cloud service documentation would help with code generation, setup, configuration, migration, or library-specific debugging.
- MUST: Start with Context7 `resolve-library-id` unless the user provides an exact `/org/project` library ID, then call `query-docs` with the selected library ID and the full question.
- SHOULD: Prefer Context7 MCP over web search for current library/API docs unless Context7 is unavailable or cannot resolve the needed source.

## Docs

- MUST: Keep `AGENTS.md` principle-level. Put repeatable workflows in scripts, high-risk operator flows in runbooks, and task-specific routing in skills.
- MUST: Keep Markdown prose paragraphs on single logical lines; do not add hard line breaks mid-sentence or reflow text just to wrap at a fixed column.
- SHOULD: Prefer deleting, merging, or linking stale docs over adding another parallel explanation.
- MUST: Treat `docs/*-brief.md` and `docs/ROADMAP.md` as non-canonical brainstorms and planning, never specification. Where a brief deviates from the codebase or from canon (`DESIGN.md`, `PRODUCT.md`, `VOICE.md`), the codebase and canon win; translate the idea into Fluncle's terms when picking it up.
- [README.md](./README.md) - repo overview, package layout, local dev, deployment, CLI, Raycast, and publish flow.
- [PRODUCT.md](./PRODUCT.md) - product purpose, brand direction, design principles, and accessibility.
- [DESIGN.md](./DESIGN.md) - the visual canon (the Nostalgic Cosmos): palette, typography, elevation, components, named visual rules.
- [VOICE.md](./VOICE.md) - the language canon: persona, vocabulary, named voice rules, surface registers, and copy mechanics.
- [docs/local-database.md](./docs/local-database.md) - how databases work across prod, dev, and worktrees: prod/dev both Turso, everyday dev on a per-worktree local libSQL server (`turso dev` + `.dev/local.db`) seeded from `fluncle-dev`, the `dev`/`db:refresh-dev`/`db:pull-remote` scripts, Superset worktree provisioning, and the committed `deploy:cf` migrate step.
- [docs/track-lifecycle.md](./docs/track-lifecycle.md) - canonical architecture for a track's life: fast synchronous add (Worker) + async agent enrichment (audio analysis, video, R2), the generic admin update path, tag provenance, and the enrichment data model.
- [docs/admin-tagging.md](./docs/admin-tagging.md) - the admin-gated `/admin/tag` vibe-map tagging tool: place each finding by energy×mood (the four galaxies), web admin auth (one identity, two carriers; Login with Spotify), the queue, the keyboard loop, and the `vibe_x`/`vibe_y` data model.
- [docs/agents/newsletter-agent.md](./docs/agents/newsletter-agent.md) - instructions for the external Friday newsletter agent and its discovery-window contract with `/api/tracks`.
- [packages/video/README.md](./packages/video/README.md) - Remotion video machinery + the dated, self-contained archive under `src/remotion/tracks/`: the core surface, the archive contract, and the pipeline.
- [packages/media/README.md](./packages/media/README.md) - Remotion image-asset rendering; the Galaxy gate-screen OG card is the first asset, with room to grow.
- [docs/galaxy-sprites.md](./docs/galaxy-sprites.md) - how the Galaxy game's 8-bit sprite + audio assets are made: the canon ramp, the Nano-Banana (Gemini) workflow, the procedural-fallback contract, and the amen placeholder.
- [docs/agents/enrichment-agent.md](./docs/agents/enrichment-agent.md) - thin bootstrap for the async track agent (the enrich → video → publish chain; runs locally or on Spinup; tools + safety rails); its full constitution is the fluncle-track-enrichment skill at [packages/skills/fluncle-track-enrichment](./packages/skills/fluncle-track-enrichment). Video render is a separate capability whose doctrine is the fluncle-video skill at [packages/skills/fluncle-video](./packages/skills/fluncle-video); publishing rendered videos to social platforms as drafts is the fluncle-publish skill at [packages/skills/fluncle-publish](./packages/skills/fluncle-publish).
- [docs/agents/hermes-agent.md](./docs/agents/hermes-agent.md) - the chat-presence agent (self-hosted Nous Hermes gateway, Discord-first): the CLI-is-the-trust-boundary model, the `fluncle` command gate (deny-by-default `admin` allow-list) and how to change it, secrets via `op`, model/voice gates, and the build/run/verify runbook. Build context (Dockerfile + gate wrapper) lives at [docs/agents/hermes/](./docs/agents/hermes/).
- [docs/socials/](./docs/socials/) - the map of social accounts, owned channels, profile assets, bio conventions, and the generated banners.
- [packages/skills/fluncle-mixtapes](./packages/skills/fluncle-mixtapes) - the skill for publishing Fluncle's own DJ mixtapes: the repeatable per-mixtape runbook (build draft + tracklist, distribute video→YouTube + audio→Mixcloud, flip public, announce), a Rekordbox ordered-tracklist extraction script, and the spine model in `references/spine-model.md` (the mixtape as a spine-native object — Fluncle dreaming, a checkpoint; its `F`-marked Log ID, the `/log` + `/mixtapes` surfaces, mixtape-aware schema/RSS/llms.txt, the hosting/MusicBrainz/Wikidata map, surface fan-out).

## Architecture

- MUST: Keep `apps/web` as the owner of public and admin API routes, including Spotify, Telegram, Discord, and Turso mutation behavior.
- MUST: Keep the CLI as a thin HTTP client for public reads/submissions and authenticated admin commands.
- MUST: Keep Raycast commands calling the `fluncle` CLI rather than reimplementing Spotify, Telegram, Turso, or HTTP API behavior.
- MUST: Keep publishing authority behind the authenticated admin API.
- SHOULD: Preserve existing server module boundaries under `apps/web/src/lib/server` and API route handlers under `apps/web/src/routes/api`.

## UI Components

- MUST: Lead with the Shadcn design system for web UI.
- MUST: Read [PRODUCT.md](./PRODUCT.md) before UI or copy edits.
- MUST: Keep the public app dark-only, cover-led, centered, quiet, fast, and aligned with Fluncle's music-first product direction.
- MUST: Target WCAG AA contrast for text and controls, preserve keyboard access for interactive rows and links, and respect reduced-motion preferences.
- MUST: Use Shadcn-managed components from `apps/web/src/components/ui/` for shared UI patterns.
- MUST: Use Shadcn components by their canonical generated exports; do not add local aliases or wrappers when an exact Shadcn component exists.
- NEVER: Import headless primitives such as `@base-ui/react/*` directly in app code.
- NEVER: Bypass the design system with ad hoc headless primitive usage in feature code.
- SHOULD: Avoid SaaS dashboards, bright streaming-app clones, generic landing-page hero sections, oversized marketing copy, glassy card stacks, and decorative gradients that ignore the cover art.
- When a Shadcn component is missing, add it through the Shadcn CLI before using it, for example:

```bash
bunx --bun shadcn@latest add dialog
```

- Keep generated Shadcn components aligned with the existing design tokens and local component conventions before using them in feature code.

## Database

- MUST: Generate SQL migrations via `bun run --cwd apps/web db:generate`.
- MUST: Keep generated migration metadata with the schema change that caused it.
- NEVER: Write SQL migrations by hand.
- SHOULD: Treat Turso/libSQL as the source of persisted app data. Everyday local dev runs against a per-worktree local libSQL server (see [docs/local-database.md](./docs/local-database.md)); never commit database files or ad hoc database state (the local db lives under the gitignored `apps/web/.dev/`).

## Dependencies

- MUST: Keep lockfile changes with the dependency change that caused them.
- MUST: Follow the existing workspace catalog and version-range style when adding dependencies.
- SHOULD: Avoid new dependencies when an existing repo package or platform API is sufficient.

## Git

- MUST: If `git commit` fails because Git cannot write commit metadata or access signing helpers, retry the commit with elevated permissions before changing Git config.
- NEVER: Disable commit signing with `commit.gpgsign=false` unless the user explicitly asks for an unsigned commit.

## Agent Skills

- Applies to skills created via `/skill-creator`, `Skill Creator`, or `$skill-creator`
- MUST: Put new skills in `packages/skills`
- MUST: Prefix Spinup-specific skills with `spinup-`
- MUST: Verify skills with `UV_CACHE_DIR=/tmp/uv-cache uv run --with pyyaml python "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" packages/skills/<skill-path>`
- MUST: Install local skills with `npx skills add ./packages/skills/<skill-path> -y -a claude-code -a codex`
