# Repository Instructions

Concise rules for working in Fluncle. Use MUST/SHOULD/NEVER to guide decisions.

## Instruction Scope

- User instructions for the current task override this file.
- More specific instructions from tools, skills, or nested agent files override root guidance for their scope.
- If instructions conflict with system/tool safety rules, follow the higher-priority rule and mention the conflict.
- Prefer the smallest change that fully solves the task.

## Public Repo

- This repository is **open source and public** (`github.com/mauricekleine/fluncle`). Everything committed is world-readable forever, git history included — write every file for that audience.
- NEVER commit secret VALUES (tokens, keys, passwords). gitleaks guards this in CI; never rely on it alone.
- NEVER commit the secret-management MAP either: concrete `op://<vault>/<item>` 1Password paths, hostnames, IPs, identifying service ports, internal URLs, tailnet names, webhook URLs, or local `/Users/...` paths. They are references rather than secrets, but they hand out the topology. A port is forbidden only when it identifies THIS topology: a well-known default or a conventional alternate that any host could be running grants nothing and may be committed in runnable form (Tailscale's UDP 41641, the alt-SSH 2222 in the [fluncle-hetzner-ops](./packages/skills/fluncle-hetzner-ops) scripts). Use a PLACEHOLDER (`op://$FLUNCLE_1PASSWORD_ENV_ITEM/<field>` as in `apps/web/.dev.vars.tpl`, or `op://<vault>/<item>/<field>`); keep the concrete map in private operator documentation. A working-tree grep in CI (`.github/workflows/gitleaks.yml`) backstops the `op://` case.
- Public runtime IDENTIFIERS are fine (the R2 account id, the IndexNow token, the two Sentry DSNs, the Cloudflare cache-purge zone id — all allowlisted in `.gitleaks.toml`): they grant nothing without the matching secret.
- Keep committed docs and skills at the architecture/procedure level; keep secret-bearing operator commands in private operator documentation.

## Operator-only material

- **This repo is self-contained.** It builds, runs, tests, and deploys without private operator documentation.
- Keep exact runtime recipes, the concrete secret/topology map, and operator-only support out of this public repo. Consult the relevant operator skill before acting; ask the operator when private details are unavailable.
- The `mk-repos` skill maps how this repo relates to the others.
- A session never reads secrets through the sweep host's service account; when the Mac's 1Password is locked, use the M5 service account or wait.

## Which machine am I on?

- This repo is worked from two Macs; the machine determines what is SAFE, so detect it before large uploads or commits. Detect with `sysctl -n machdep.cpu.brand_string` and match loosely on the chip generation (the string is like `Apple M5 Pro` / `Apple M2` — key off `M5` / `M2`). The physical rig behind this split is [docs/live-show-setup.md](./docs/live-show-setup.md).
- **M5 (build/compose + capture/stream):** browser + prod `fluncle` CLI; OBS + the audio/video masters + the recording upload + `ffmpeg` + distribute + the live glass/bridge all live here. Orchestrate, dev, capture, and stream here. Heavy render batches run as a sliding window — 3 concurrent attended, 4 max overnight, never wider (this CPU is also the show rig).
- **M2 (mixing):** Rekordbox + the DDJ-FLX4 + `master.db` — the `fluncle-mixtapes` Rekordbox scripts and the `fluncle-rekordbox-sync` key/BPM sync run here (they read `master.db`), and during an unordered live set the `m2-sender` + `deckwatch` scripts (they need the controller's MIDI and Rekordbox on screen). No OBS, no browser.
- Large media uploads (`fluncle admin recordings create --video`, `fluncle admin mixtapes distribute`) run on the M5 and must be started by the operator in a direct Terminal session. Agent shell sessions do not reliably sustain multi-GB transfers. Use `dangerouslyDisableSandbox` for SSH-signed commits through the 1Password agent socket and moderate transfers; follow the [fluncle-mixtapes](./packages/skills/fluncle-mixtapes) skill for the upload workflow.

## Work Standard

- Deliver the finished implementation, relevant checks, and documentation. Prefer the durable fix when it is within reach and close directly related, low-risk follow-through.
- Search existing code, patterns, helpers, and dependencies before adding another.
- Automate repeatable work. A documented platform constraint may require an operator action; automate the surrounding workflow and capture its result.
- Support factual claims, numbers, and blockers with current command output or specific code. Verify the code and current Git state before attributing a failure.
- Reconcile every launched task, render, and background job before ending a session, and report anything still running.
- Ask before expanding into unrelated refactors, production changes, paid infrastructure, destructive operations, or product direction. Record adjacent work and stay on task; consult the repository before asking for a decision it can settle.

## Routing

Use the globally installed `mk-agent-orchestration` skill for provider, model, effort, delegation, and review. Work that must pass Fluncle's `copywriting-fluncle` or `canon-reviewer` house gates uses a Claude-capable executor; split mixed work where practical.

## Before Editing

- MUST: Inspect existing code patterns before changing implementation.
- MUST: Check `git status --short` and avoid reverting unrelated user changes.
- MUST: Read area docs before touching UI, API routes, database schema, publishing flows, Raycast integration, deployment, or CLI behavior.
- SHOULD: Prefer focused reads/searches over loading broad docs by default.

## Commands

- MUST: Use `bun` for repo scripts and package management unless a documented tool requires otherwise.
- MUST: Use `rg` for code search when available.
- NEVER: Use `npm`, `pnpm`, or `yarn` for installs unless the task targets tooling that explicitly requires them.
- NEVER: Run `prettier` or `bunx prettier` outside `apps/raycast`. Formatting is owned by `oxfmt` for the repo, except `apps/raycast` where Raycast's CLI is the source of truth and `ray lint` runs a Prettier check over `src/**`. Use `bunx oxfmt <files>` or `bun run check` for non-Raycast files; use `bun run --cwd apps/raycast lint -- --fix` only for Raycast formatting fixes.
- MUST: Quote shell variables and iterate with explicit arrays so expansions resolve to the intended targets. In DB scripts use parameterized SQL (or proper escaping), and confirm a table actually has a column before querying it.

## Quality Checks

- Before a commit or handoff, use `bun run quality:classify -- --base <sha> --head <sha>` to identify affected leaves and run their checks. Unknown paths, lockfiles, root configuration, workflow topology, and scheduled/manual runs select the full matrix; worktree setup selects static policy only.
- Edit hooks format the touched file. Quality Checks and `deploy:gate` own the full matrix. For docs-only changes, verify formatting, links, and readability.
- Read [docs/development.md#quality-checks](./docs/development.md#quality-checks) for package-specific commands; read [docs/quality-system.md](./docs/quality-system.md) before changing CI, the classifier, or deploy verification.
- Use guards, early returns, `??`, or `?.` instead of TypeScript non-null assertions, enforced by oxlint.
- For browser inspection use the global `agent-browser` skill; use Chrome DevTools MCP for performance traces.

## External Effects

- MUST: Ask before destructive operations, production deploys, paid infrastructure changes, bulk sends, credential rotations, or changes that publish to Spotify, Telegram, Discord, or Cloudflare.
- MUST: Report when required validation depends on external services and could not be run locally.
- NEVER: Invent secrets, credentials, listener data, analytics data, or production state.
- MUST: Treat a push to `main` as a production deploy. `scripts/quality/deploy-watch-paths.json` is the exact Cloudflare Workers Builds exclusion contract; `bun run quality:classify` and `node scripts/quality/deploy-watch.mjs verify <live-export>` fail closed around it and keep the post-deploy decision synchronized. Quality Checks always reports its stable protected context; public-web E2E runs only for its web/shared/migration closure and the full backstop. Space deploy-triggering merges and verify the Workers Build for the final commit. If the check is absent, classify the diff: an excluded-only change is an expected skip; any deployable path requires an operator-triggered rebuild. Compare `/api/v1/health` with the latest commit that touches a deployable path. The bounded polling probe is specified in [docs/quality-system.md](./docs/quality-system.md).
- After a merge, run `bun run deploy:verify <merged-sha>` to wait for the live Worker SHA or confirm an excluded-path skip.
- The prod deploy is gated by `bun run deploy:gate` (repository format check + the Go apps' `gofmt` and `go vet` checks + type-aware lint + typecheck + every package's tests, the Go apps' `go test` included) in the Cloudflare Build command — a failing gate aborts the build before `cf deploy`. Outside it, caught by the `quality-checks` GitHub Action on the PR but never by the deploy gate: `apps/sonar` entirely (no `package.json`, so turbo cannot see its Rust `cargo fmt`/`clippy`/`test`), and the Hermes box-script suite (`test:scripts:box`, the `docs/agents/hermes/scripts` tests): those scripts are baked into the rave-02 image by the pin-watch pipeline, not shipped by the Workers Build, and their process-level tests take minutes of real time, so they gate the PR through `check`, never the Worker deploy.
- MUST: After pushing to `main`, monitor GitHub Actions and Cloudflare Workers Build through completion and resolve any failed check. Extend `deploy:gate` in `package.json` (not the dashboard) to add checks to the deploy boundary.

## Library and API Docs

- MUST: When current library, framework, SDK, API, CLI, or cloud-service docs would help, fetch them through Context7 if it is connected: `resolve-library-id` (skip it when given an exact `/org/project` ID), then `query-docs` with the full question. When Context7 is unavailable or cannot resolve the source, use the vendor's official docs.

## Docs

- MUST: Keep `AGENTS.md` principle-level. Put repeatable workflows in scripts, high-risk operator flows in runbooks, and task-specific routing in skills.
- MUST: Keep code and config free of comments. The `no-comments` oxlint rule enforces JS/TS; the JSON, shell, and YAML gates enforce tracked files outside their carve-outs. Go, Rust, systemd units, CSS, TOML, and SQL migrations are out of scope. Tool directives are the only exception. Put a reason in a name, test, error message, or owning doc. Test names state standing constraints, never change history; history belongs in Git and dated ledgers.
- MUST: Keep Markdown prose paragraphs on single logical lines; do not add hard line breaks mid-sentence or reflow text just to wrap at a fixed column.
- SHOULD: Prefer deleting, merging, or linking stale docs over adding another parallel explanation.
- MUST: Treat everything under `docs/planning/` (roadmaps, e.g. `docs/planning/ROADMAP.md`) and `docs/rfcs/`, plus any `docs/*-brief.md`, as non-canonical brainstorms and planning, never specification — these are never listed in the canon list below. Where such a doc deviates from the codebase or from canon (`LORE.md`, `DESIGN.md`, `PRODUCT.md`, `VOICE.md`), the codebase and canon win; translate the idea into Fluncle's terms when picking it up.
- MUST: PRUNE (delete) an RFC once its work has shipped — a built RFC is removed, never flipped to a "done/Final" status or kept as reference. Shipped work is documented in the code and the canon docs, never in a completed RFC; `docs/rfcs/` (and any `docs/*-rfc.md`) holds only in-flight or not-yet-built plans. Git history preserves a deleted RFC.
- Read [docs/README.md](./docs/README.md) before editing an area: it maps catalogue entities, search, APIs, surfaces, media, runtime agents, rig operation, and release workflows to their owning docs and skills.
- [README.md](./README.md) maps packages and local development. [LORE.md](./LORE.md) owns story, [PRODUCT.md](./PRODUCT.md) purpose and product direction, [DESIGN.md](./DESIGN.md) visuals, and [VOICE.md](./VOICE.md) language. LORE wins over the other canons on story.

## Architecture

- `apps/web` owns public/admin APIs, integrations, and data mutations. Keep the CLI a thin HTTP client, Raycast a CLI consumer, and publishing authority behind authenticated admin APIs.
- Read [docs/development.md#architecture](./docs/development.md#architecture) before adding HTTP surfaces or changing route data loading: oRPC ownership, file-route carve-outs, TanStack option order, loader-seeded query patterns, and sweep scheduling.

## Effect

- Keep Effect within modules already using it; broader adoption needs Maurice's approval. Contracts, mobile, extensions, and client chunks remain Effect-free.
- Before editing Effect, read [docs/development.md#effect](./docs/development.md#effect): installed v4 docs, Promise exports, typed errors, cancellation, background work, and the cross-request fiber boundary.

## UI Components

- Read [PRODUCT.md](./PRODUCT.md) and [docs/development.md#ui-components](./docs/development.md#ui-components) before UI changes: shared Shadcn ownership, generated exports, icon sources, tokens, and installation.
- Keep the public app dark-only, cover-led, centered, quiet, fast, and music-first. Preserve WCAG AA contrast, keyboard access, and reduced motion.

## Public Copy

- MUST: Write every public-facing string through the `copywriting-fluncle` skill — load it BEFORE drafting and run its final checks before committing. Public-facing means anything a non-operator reads: web pages outside `/admin`, mobile, meta/OG/link-preview text, feeds, SSH/CLI human-facing text, and social. This applies to one-line edits and empty states; small strings count.
- MUST: Treat the operator tier as the other side of that boundary — the `fluncle admin …` CLI and every `/admin` route are not public copy, and their register carve-out (the em-dash clause join and terse ALL-CAPS status words, nothing else) is written into [packages/skills/copywriting-fluncle/references/voice.md](./packages/skills/copywriting-fluncle/references/voice.md) §5.
- MUST: Run `canon-reviewer` after every public-copy change, including delegated work, and treat its Flat Copy Test as blocking: copy that describes the page's mechanism (the query window, the sort order, a data-model distinction) instead of speaking from Fluncle's body is off-voice even when mechanically clean. Name both the `copywriting-fluncle` drafting gate and the `canon-reviewer` acceptance gate in each public-surface brief.

## Database

- MUST: Generate SQL migrations via `bun run --cwd apps/web db:generate`.
- MUST: Keep generated migration metadata with the schema change that caused it.
- NEVER: Write SQL migrations by hand. The one exception is a DATA MOVE the generator cannot express (backfilling rows a schema change is about to strand, e.g. `drizzle/0022` and `drizzle/0068`): add that statement to the generated file and say in a comment above it that it is authored and why it must run inside the migration. The DDL stays generated.
- SHOULD: Treat Turso/libSQL as the source of persisted app data. Everyday local dev runs against a per-worktree local libSQL server (see [docs/local-database.md](./docs/local-database.md)); never commit database files or ad hoc database state (the local db lives under the gitignored `apps/web/.dev/`).
- MUST: Validate performance and scale claims against hosted Turso. Read [docs/local-database.md](./docs/local-database.md), especially "Local is not production", before query or vector work: it defines raw-BLOB vector binding, populated-index write locks, SQL-side ranking, and single-pass multi-probe scans. Local sqld behavior is not evidence of hosted performance.

## Dependencies

- Keep lockfile changes with their dependency change; follow the workspace catalog and range style. Prefer existing packages or platform APIs.
- Use `mk-dependency-upgrades` for upgrades and read [docs/development.md#dependencies](./docs/development.md#dependencies) for coupled groups, holds, and smoke checks. Sweep-host pins and `.deepsec/pnpm-lock.yaml` follow `fluncle-maintenance`.

## Git

- MUST: Keep the main checkout read-only apart from `git pull`, and do every change in a Worktrunk worktree (`wt switch -c <branch>`, or `EnterWorktree` in Claude Code) branched from a freshly pulled `main`. Deliver it as a PR: the `hyperspeed-ci` reviewer approves and auto-merges it, and the `mk-pr-shepherd` skill carries it through merge and `deploy:verify`. A merge to `main` auto-deploys (mind the coalescing note under External Effects). Delegated sub-agents follow the same path; see the `mk-agent-orchestration` skill.
- For draft-guarded CI, keep the PR draft through edits, local checks, and local review; mark it ready once for protected contexts, then follow the normal reviewed PR path after they succeed on that head.
- MUST: If `git commit` fails because Git cannot write commit metadata or access signing helpers, retry the commit with elevated permissions before changing Git config.
- On headless/automation runs the 1Password SSH agent can be unavailable — signing and SSH push fail even with the sandbox off; fetch/push over HTTPS with `git -c credential.helper='!gh auth git-credential'` instead (`gh` itself is keyring-backed, so it also needs the sandbox off).
- NEVER: Disable commit signing with `commit.gpgsign=false` unless the user explicitly asks for an unsigned commit.

## Agent Skills

- Put local skills in `packages/skills`. Before creating or editing one, read [docs/development.md#agent-skills](./docs/development.md#agent-skills) for validation, reinstallation, and the source/copy/link files to commit.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
