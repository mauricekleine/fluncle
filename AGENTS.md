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
- NEVER commit the secret-management MAP either: concrete `op://<vault>/<item>` 1Password paths, hostnames, IPs, ports, internal URLs, tailnet names, webhook URLs, or local `/Users/...` paths. They are references rather than secrets, but they hand out the topology. Use a PLACEHOLDER (`op://$FLUNCLE_1PASSWORD_ENV_ITEM/<field>` as in `apps/web/.dev.vars.tpl`, or `op://<vault>/<item>/<field>`); the concrete map lives in the private companion repo (see _Private companion_ below). A working-tree grep in CI (`.github/workflows/gitleaks.yml`) backstops the `op://` case.
- Public runtime IDENTIFIERS are fine (the R2 account id, the IndexNow token — both allowlisted in `.gitleaks.toml`): they grant nothing without the matching secret.
- Keep committed docs and skills at the architecture/procedure level; secret-bearing operator commands stay in the private companion repo + the relevant operator skill.

## Private companion

- Some material is **operator-only and deliberately not in this repo**: exact runtime recipes, the concrete secret/topology map, local-dev support, and work that is not part of the product. It lives in a **private companion repo, `fluncle-labs`** (`~/Projects/fluncle-labs` on an operator machine; `gh repo view mauricekleine/fluncle-labs` if you have access).
- **This repo is self-contained.** Nothing here needs the companion to build, run, test, or deploy — the split is about what should be world-readable, not about hiding a dependency.
- **If you have access:** look there before asking the operator for an exact recipe, a vault path, or a hostname — it is where that detail lives, and it is version-controlled. Its README states the boundary rule.
- **If you do not have access:** nothing in this repo requires it. Do not attempt to reconstruct its contents here, and do not move material from it into this repo — the boundary is deliberate. Ask the operator.
- **Adding something new?** Ask the boundary question: _would I be happy for a stranger, a competitor, or a lawyer to read this?_ If no, it belongs in the companion, not here.

## Which machine am I on?

- This repo is worked from two Macs; the machine determines what is SAFE, so detect it before large uploads or commits. Detect with `sysctl -n machdep.cpu.brand_string` and match loosely on the chip generation (the string is like `Apple M5 Pro` / `Apple M2` — key off `M5` / `M2`). The physical rig behind this split is [docs/live-show-setup.md](./docs/live-show-setup.md).
- **M5 (build/compose + capture/stream):** browser + prod `fluncle` CLI; OBS + the audio/video masters + the recording upload + `ffmpeg` + distribute + the live glass/bridge all live here. Orchestrate, dev, capture, and stream here. Heavy render batches run as a sliding window — 3 concurrent attended, 4 max overnight, never wider (this CPU is also the show rig).
- **M2 (mixing):** Rekordbox + the DDJ-FLX4 + `master.db` — the `fluncle-mixtapes` Rekordbox scripts and the `fluncle-rekordbox-sync` key/BPM sync run here (they read `master.db`), and during an unordered live set the `m2-sender` + `deckwatch` scripts (they need the controller's MIDI and Rekordbox on screen). No OBS, no browser.
- **THE LOAD-BEARING RULE — large media uploads (`fluncle admin recordings create --video`, `fluncle admin mixtapes distribute`) run on the M5 and must be operator-run directly in their own Terminal:** an agent's Bash session throttles sustained _multi-GB_ transfers even with `dangerouslyDisableSandbox: true` — a small upload works, a multi-GB one drops partway with `socket closed`. `dangerouslyDisableSandbox` is still required for git commits (SSH-signed via the 1Password agent socket) and moderate transfers, but it does NOT make a multi-GB upload reliable through the harness — those are operator-direct. Full operator workflow is the [fluncle-mixtapes](./packages/skills/fluncle-mixtapes) skill.

## Work Standard

- MUST: If it can be automated, it should be automated. When the choice is "automation is possible but it will require work" versus "do it manually," choose automation every time — with AI the marginal cost of completeness is near zero. The point of this project is reach: how far Fluncle's tentacles stretch across the web (search engines, AI crawlers, and ultimately real humans — DnB fans, artists). A manual step is reach that does not scale. The ONLY exception is a genuine, documented platform constraint with no automatable path (e.g. TikTok licensed audio must be attached in the app) — and even then, automate everything up to and after the irreducible manual step, and capture its result automatically.
- MUST: Hold the bar at "holy shit, that's done," not "good enough." When asked for something, deliver the finished product — implementation + tests + documentation — not a plan to build it and not a workaround. Never table a permanent solve that is within reach; never leave a dangling thread when tying it off takes five more minutes. Time, fatigue, and complexity are not excuses. Search before building, test before shipping, ship the complete thing.
- MUST: Prefer a complete, durable fix over a workaround when the full fix is reasonably reachable in the current task.
- MUST: Build the real implementation instead of papering over behavior when the implementation path is small and well-scoped.
- MUST: Search the codebase before adding new patterns, helpers, dependencies, or abstractions.
- MUST: Carry implementation work through verification: update focused tests/docs when behavior changes, run the relevant checks, and report any checks that could not be run.
- MUST: Close obvious follow-through items discovered during the task when they are directly related and low-risk.
- MUST: Never silently drop queued or delegated work: before ending a session, reconcile everything launched (sub-agents, renders, box crons, background jobs) and report anything still in flight.
- SHOULD: Ask before expanding scope into unrelated refactors, production changes, paid infrastructure, destructive operations, or work that changes product direction.
- NEVER: Stop at a plan when the user asked for implementation and the implementation is feasible.
- NEVER: Present a workaround as complete when a known real fix remains.

## Picking the right models and effort for workflows and subagents

**Opus 4.8 across the board** — the orchestrator/reviewer AND every sub-agent and workflow stage run on Opus 4.8. Fable 5 is no longer available on the plan, and Sonnet has proven unreliable in practice (it passes its own checks but under-delivers or ships subtle bugs — e.g. a "surfaces" slice that silently omitted its core deliverable). So there is no model-tier tradeoff left to manage: hold the quality bar with Opus 4.8 everywhere.

- Orchestration, delegation, brainstorm, and review — the "decide" and hold-the-overview work — run on Opus 4.8. The [agent-orchestration](./packages/skills/agent-orchestration) skill is driven by Opus 4.8 and offloads execution to Opus 4.8 sub-agents.
- Do NOT downgrade an execution slice to a cheaper tier to save cost — judge the output, not the price tag; a cheap agent that under-delivers costs more than it saves.
- Mechanics: Opus 4.8 runs via the Agent/Workflow `model` parameter (`opus`).

**Reasoning effort is the token dial — the model tier is fixed, so effort is where you save.** Effort is adaptive: a lower level still thinks hard when the problem genuinely demands it and skips deep thinking on the easy ones, so stepping DOWN on low-stakes work is a Pareto move, not a quality cut. **Unspecified = `high` (the default); step down for cheap/mechanical work, up only for the highest-stakes review.**

| Effort             | Price | Intelligence | When to use                                                                                                                                          |
| ------------------ | ----- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `low`              | 2     | 4            | Read-only recon / `Explore` fan-out, pure lookups/classification, deterministic `--no-agent` box sweeps (note/observe)                               |
| `medium`           | 4     | 6            | Bounded mechanical execution — doc/header rewrites, list/format transforms, mechanical migrations, the naming linter (~25–40% cheaper than `high`)   |
| `high` _(default)_ | 6     | 8            | Orchestration, decompose/merge judgment, RFC synthesis, canon/taste calls, creative divergence, general review — the judgment work                   |
| `xhigh`            | 9     | 9            | Adversarial review of prod/auth/SQL/paid-action diffs and the gnarliest RFC synthesis — the one place to raise, where a miss fans out (~2–3× `high`) |
| `max`              | 10    | 10           | Frontier problems only; never routine (large cost for small quality gains)                                                                           |

_(Price/intelligence are relative 1–10 guides, not measured costs.)_

- Mechanics: unspecified runs at `high`. Sub-agents spawned via the **Agent** tool INHERIT the session's effort — that tool sets each sub-agent's `model` but has no effort knob — as do the `.claude/agents/*.md` reviewer defs. To dial effort PER sub-agent (a fan-out where each slice wants a different level), use the **Workflow** tool's `agent(prompt, {effort})` or headless `claude -p --effort <level>`. The on-box crons expose `OBSERVE_CLAUDE_EFFORT` / `NOTE_CLAUDE_EFFORT` hooks — set them in the box env to lower those sweeps.

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

## Quality Checks

- TypeScript: `bun run typecheck` from the repo root, or the nearest package `typecheck` for focused changes.
- Lint and format: `bun run check` from the repo root for broad validation.
- Web changes: `bun run --cwd apps/web typecheck`, `bun run --cwd apps/web build`, and `bun run --cwd apps/web lint` when relevant.
- CLI changes: `bun run --cwd apps/cli typecheck` and focused CLI commands such as `bun run --cwd apps/cli fluncle recent --limit 1 --json` when behavior changes.
- Raycast changes: `bun run --cwd apps/raycast build` and `bun run --cwd apps/raycast lint`. If lint fails only on Raycast formatting, run `bun run --cwd apps/raycast lint -- --fix` and keep the resulting changes scoped to `apps/raycast`.
- Go app changes (`apps/ssh` the rave terminal, `apps/dns` the DNS server): `go build -C apps/<app> ./...`, `gofmt -l apps/<app>` (must list nothing), and `go vet -C apps/<app> ./...`.
- Video package changes: `bun run --cwd packages/video typecheck`.
- NEVER: Use the TypeScript non-null assertion operator (`!`). Narrow with a guard, early return, `??`, or `?.`. Enforced as an error by oxlint (`typescript/no-non-null-assertion`).
- SHOULD: Run focused checks first, then broader root checks when the change has cross-package or user-facing risk.
- SHOULD: For docs-only changes, verify formatting/readability instead of running full test suites unless docs generation is affected.

## External Effects

- MUST: Ask before destructive operations, production deploys, paid infrastructure changes, bulk sends, credential rotations, or changes that publish to Spotify, Telegram, Discord, or Cloudflare.
- MUST: Report when required validation depends on external services and could not be run locally.
- NEVER: Invent secrets, credentials, listener data, analytics data, or production state.
- MUST: Treat a push to `main` as a production deploy — Cloudflare Workers Builds rebuilds `apps/web` on every push; rapid successive pushes/merges coalesce and can drop an intermediate build, so space deploy-triggering merges and confirm a build ran on the final commit.
- The prod deploy is gated by `bun run deploy:gate` (format check + type-aware lint + typecheck + every package's tests) in the Cloudflare Build command — a failing gate aborts the build before `wrangler deploy`.
- MUST: After any push to `main`, watch GitHub Actions and the Cloudflare Workers Build through to green before moving on — a red check is your work item, not background noise. Extend `deploy:gate` in `package.json` (not the dashboard) to add checks to the deploy boundary.

## Library and API Docs

- MUST: Use Context7 MCP to fetch current documentation whenever library, framework, SDK, API, CLI tool, or cloud service documentation would help with code generation, setup, configuration, migration, or library-specific debugging.
- MUST: Start with Context7 `resolve-library-id` unless the user provides an exact `/org/project` library ID, then call `query-docs` with the selected library ID and the full question.
- SHOULD: Prefer Context7 MCP over web search for current library/API docs unless Context7 is unavailable or cannot resolve the needed source.

## Docs

- MUST: Keep `AGENTS.md` principle-level. Put repeatable workflows in scripts, high-risk operator flows in runbooks, and task-specific routing in skills.
- MUST: Keep Markdown prose paragraphs on single logical lines; do not add hard line breaks mid-sentence or reflow text just to wrap at a fixed column.
- SHOULD: Prefer deleting, merging, or linking stale docs over adding another parallel explanation.
- MUST: Treat everything under `docs/planning/` (roadmaps, e.g. `docs/planning/ROADMAP.md`) and `docs/rfcs/`, plus any `docs/*-brief.md`, as non-canonical brainstorms and planning, never specification — these are never listed in the canon list below. Where such a doc deviates from the codebase or from canon (`LORE.md`, `DESIGN.md`, `PRODUCT.md`, `VOICE.md`), the codebase and canon win; translate the idea into Fluncle's terms when picking it up.
- MUST: PRUNE (delete) an RFC once its work has shipped — a built RFC is removed, never flipped to a "done/Final" status or kept as reference. Shipped work is documented in the code and the canon docs, never in a completed RFC; `docs/rfcs/` (and any `docs/*-rfc.md`) holds only in-flight or not-yet-built plans. Git history preserves a deleted RFC.
- [README.md](./README.md) - repo overview, package layout, local dev, deployment, CLI, Raycast, and publish flow.
- [LORE.md](./LORE.md) - the story canon: the narrative loop every surface draws from (a banger is an experience, the video relives it, the crew shares it, the star is a waypoint, the mixtape is a dream), the Galaxy, and the crew. Wins on story; the other three canons defer to it there.
- [PRODUCT.md](./PRODUCT.md) - product purpose, brand direction, design principles, and accessibility.
- [DESIGN.md](./DESIGN.md) - the visual canon (the Nostalgic Cosmos): palette, typography, elevation, components, named visual rules.
- [VOICE.md](./VOICE.md) - the language canon: persona, vocabulary, named voice rules, surface registers, and copy mechanics.
- [docs/local-database.md](./docs/local-database.md) - how databases work across prod, dev, and worktrees: prod/dev both Turso, everyday dev on a per-worktree local libSQL server (`turso dev` + `.dev/local.db`) seeded from `fluncle-dev`, the `dev`/`db:refresh-dev`/`db:pull-prod` scripts, Superset worktree provisioning, and the committed `deploy:cf` migrate step.
- [docs/track-lifecycle.md](./docs/track-lifecycle.md) - canonical architecture for a track's life: fast synchronous add (Worker) + async agent enrichment (audio analysis, video, R2), the generic admin update path, tag provenance, and the enrichment data model.
- [docs/admin-shell.md](./docs/admin-shell.md) - the contract for every `/admin` surface: the AdminShell workspace chrome, the placement contract (where each kind of control goes), the flat object nav + attention-queue dashboard, web admin auth (one identity, two carriers; Login with Spotify), and the browser-verification fixtures (`loginAsAdmin`, the shell/queue smokes).
- [docs/artist-relationship.md](./docs/artist-relationship.md) - the canonical artist entity: the Spotify-keyed `artists` table + `track↔artist` graph, resolution (MusicBrainz + Firecrawl) into `artist_socials`, the `/artist/<slug>` public page + `MusicGroup` schema, and the `/admin/artists` operator queue.
- [docs/agents/newsletter-agent.md](./docs/agents/newsletter-agent.md) - the weekly newsletter authoring doctrine for the on-box `fluncle-newsletter` Hermes cron (Friday 15:00 Amsterdam): the self-healing discovery window off the last sent edition, the voice rails, the persist-draft-then-`clarify`-Send-button flow (Resend Broadcast, operator-gated send), and its `/api/tracks` contract.
- [packages/video/README.md](./packages/video/README.md) - Remotion video machinery + the dated, self-contained archive under `src/remotion/tracks/`: the core surface, the archive contract, and the pipeline.
- [docs/video-variants.md](./docs/video-variants.md) - the two-master video model: a clean square `footage.mp4` source + a portrait baked-text `footage.social.mp4`, with Cloudflare Media Transformations deriving every other orientation/audio variant on the fly; the surface map and the one-time migration.
- [docs/live-show-setup.md](./docs/live-show-setup.md) - the live-show runbook (macOS): the two-machine rig (mixing machine + streaming machine), the M-Track analog splitter, `bun run --cwd packages/live show` as the orchestrator, the pinned-Chromium setup, the ordered pre-show checklist, and the dress-rehearsal acceptance gate.
- [docs/set-video.md](./docs/set-video.md) - the hour-long set-video render runbook (Unit O): `bun run set:render <mixtapeLogId>` turns a published mixtape into one long-form artwork — chapters from the archived compositions, travel transitions, the dreamer's-continuity driver, chunked/resumable render, and the per-chapter QA gates.
- [packages/live/README.md](./packages/live/README.md) - the live runtime package (`@fluncle/live`): the glass (the WebGL renderer on `:4173`) + the bridge (plan + fingerprint identity + supervisor + phone remote on `:4180`), bound by `src/contract.ts`, LAN-local by design; plus RANDOM-VJ mode (`--plan all`, the whole archive as a shuffle-bag pool driven by UDP transition datagrams).
- [docs/live-deck-identity.md](./docs/live-deck-identity.md) - how the live show knows what is playing when the set is unordered: the mixer's MIDI answers WHEN a transition happened and WHICH deck went live, OCR of Rekordbox's deck header answers WHAT is on it, and the two meet in one datagram — resolve on the flip, fall back to a random VJ scene when nothing matches (the never-show-the-wrong-finding rail). Covers the Camelot map and why bpm/key are coarse guards, never the identity.
- [packages/media/README.md](./packages/media/README.md) - Remotion image-asset rendering; the Galaxy gate-screen OG card is the first asset, with room to grow.
- [docs/galaxy-sprites.md](./docs/galaxy-sprites.md) - how the Galaxy game's 8-bit sprite + audio assets are made: the canon ramp, the Nano-Banana (Gemini) workflow, the procedural-fallback contract, and the amen placeholder.
- [docs/agents/enrichment-agent.md](./docs/agents/enrichment-agent.md) - thin bootstrap for the async track agent (the enrich → video → publish chain; enrichment runs as the on-box Hermes `fluncle-enrich` `--no-agent` cron; tools + safety rails); its full constitution is the fluncle-track-enrichment skill at [packages/skills/fluncle-track-enrichment](./packages/skills/fluncle-track-enrichment). Video render is a separate capability whose doctrine is the fluncle-video skill at [packages/skills/fluncle-video](./packages/skills/fluncle-video); publishing rendered videos to social platforms as drafts is the fluncle-publish skill at [packages/skills/fluncle-publish](./packages/skills/fluncle-publish).
- [docs/agents/hermes-agent.md](./docs/agents/hermes-agent.md) - the chat-presence agent (self-hosted Nous Hermes gateway, Discord-first): the server-side operator/agent role model (the box holds an `agent`-scoped token; the Worker is the publish boundary), secrets via `op`, model/voice gates, and the build/run/verify runbook. Build context (Dockerfile) lives at [docs/agents/hermes/](./docs/agents/hermes/); the operator runbook for changing it is the [fluncle-hermes-operator](./packages/skills/fluncle-hermes-operator) skill.
- [docs/agents/observation-agent.md](./docs/agents/observation-agent.md) - the audio observation, the third per-finding enrichment artifact: the `context_note` (firecrawl facts) ⊥ observation-script split, the agent-authored recovered-audio voice and its server-side voice gate, the one `observe` CLI command, and the `/log` + `radio.fluncle.com` surfaces.
- [docs/agents/note-agent.md](./docs/agents/note-agent.md) - the auto-note, the written-note sibling of the observation: auto-authoring a finding's public editorial `note` from the `context_note` fuel, the AGENT-tier `note` CLI command + `note_track` route, the written-note voice gate, the fill-empty-only safety guarantee (an operator note is never clobbered), the `context --refresh` backfill flag, and the `fluncle-note` box cron.
- [docs/agents/triage-agent.md](./docs/agents/triage-agent.md) - the submission pre-chew, the queue-legwork sibling of the auto-note: an AGENT-tier `triage_submission` route + `admin submissions triage` CLI command that writes an advisory one-line verdict ("looks like a find / already logged / not our lane") onto a PENDING submission so it lands in the `/admin` attention queue already assessed; the deterministic dedupe + DnB-plausibility heuristic feeding one `claude -p` phrasing, the length gate, and the `fluncle-triage` box cron (repo half shipped, box enable operator-gated). Approve/reject stays operator tier.
- [docs/agents/logbook-agent.md](./docs/agents/logbook-agent.md) - Fluncle's Logbook, the voyage as a first-person travelogue, one entry per sector-day: the `/logbook` + `/logbook/<sector>` surfaces, the `[[<logId>]]` poster-figure token contract (its canonical home), the AGENT-tier fill-empty-only `create_logbook_entry` author + the operator `update_logbook_entry` overwrite, the shared written-voice gate, the self-healing gap window (backfills history oldest-first), and the `fluncle-logbook` box cron.
- [docs/agents/cluster-engine.md](./docs/agents/cluster-engine.md) - the sonic-galaxy cluster engine (browse-by-feel): the assignment-only nightly `fluncle-cluster` box cron (k-means over the MuQ space; a full fit is an operator act — cold-start/remint/split-consumption), the fixed-point-by-construction design, the map-first write-order contract, the server-minted handle vs operator-authored name split, and the operator runbook (the cold-start pilot + box activation).
- [docs/socials/](./docs/socials/) - the map of social accounts, owned channels, profile assets, bio conventions, and the generated banners.
- [packages/skills/fluncle-mixtapes](./packages/skills/fluncle-mixtapes) - the skill for publishing Fluncle's own DJ mixtapes: the repeatable per-mixtape runbook (build draft + tracklist, distribute video→YouTube + audio→Mixcloud, flip public, announce), a Rekordbox ordered-tracklist extraction script, and the spine model in `references/spine-model.md` (the mixtape as a spine-native object — Fluncle dreaming, a checkpoint; its `F`-marked Log ID, the `/log` + `/mixtapes` surfaces, mixtape-aware schema/RSS/llms.txt, the hosting/MusicBrainz/Wikidata map, surface fan-out).
- [docs/naming-conventions.md](./docs/naming-conventions.md) - the ratified cross-surface `verb_noun` naming convention (Convention B): one operation, one name across CLI / API / MCP / SSH, with the registry as the source of truth for new features.
- [docs/surfaces-doctrine.md](./docs/surfaces-doctrine.md) - the registry-driven map of every Fluncle surface (web routes, subdomains, API, feeds, discovery, DNS, SSH, MCP, CLI, crons), grouped by `SurfaceKind` with the per-context `SurfaceWeight` matrix (rows=surfaces, columns=display contexts web/ssh/cli/status), and the "add a registry entry → it lights up /status, the homepage dev-row, llms.txt, the sitemap, this doc" checklist; `@fluncle/registry` (`packages/registry/src/index.ts`) is the single source of truth.
- [packages/skills/fluncle-surfaces](./packages/skills/fluncle-surfaces) - the agent-facing add-a-surface runbook (companion to the doctrine doc): what `@fluncle/registry` is (the `Surface` type + the per-context `weights` matrix), how it is consumed across the app (the /status probe, the homepage dev-row/nav, the SSH menu, the MCP `get_status` tool, llms.txt, the sitemap, the doctrine doc — with the real files), and the runbook + fan-out checklist for registering a new surface so no consumer is forgotten.
- [packages/skills/agent-orchestration](./packages/skills/agent-orchestration) - the orchestrator-and-reviewer workflow doctrine: decompose into independent slices, delegate to sub-agents in git worktrees that open PRs, review the diffs, ping-pong to clean, merge one at a time; plus pilot-before-fan-out, sliding-window pools, de-risk spikes, and resume-memory for long ops.

## Architecture

- MUST: Keep `apps/web` as the owner of public and admin API routes, including Spotify, Telegram, Discord, and Turso mutation behavior.
- MUST: Put public/admin HTTP surfaces on oRPC contract ops by default (`packages/contracts/src/orpc/**`, registered in the `apps/web/src/lib/server/orpc/**` router); `handleOrpc` is mounted ahead of the TanStack router in `server.ts`, so a contract op shadows any file-route at the same method+path. New surfaces go on oRPC. The only `apps/web/src/routes/api/**` file-route carve-outs are: auth/OAuth redirects (Spotify/YouTube/Mixcloud/Discord starts+callbacks, admin login/logout); large-body/streaming/direct-upload routes (multipart uploads, media proxies/presigns); non-JSON emitters (feeds/sitemap/robots/`llms.txt`/`.well-known`/the CLI install script/OG + cover images/the generated OpenAPI+Postman specs); and the `/status`+`/health` resource-reads. The build-fail coverage tests enforce this: `orpc-coverage` / `orpc-admin-coverage` (any non-carve-out route without a contract fails the build), `orpc-auth-coverage` (each op carries the right auth tier), and `orpc-naming` (the `verb_noun` convention).
- MUST: Keep the CLI as a thin HTTP client for public reads/submissions and authenticated admin commands.
- MUST: Keep Raycast commands calling the `fluncle` CLI rather than reimplementing Spotify, Telegram, Turso, or HTTP API behavior.
- MUST: Keep publishing authority behind the authenticated admin API.
- SHOULD: Fluncle's recurring agent work runs as deterministic `--no-agent` sweeps on rave-02 HOST systemd timers (baked to `/opt/hermes-scripts`, scheduled by the `docs/agents/hermes/<job>-timer/` units + `install-host-timers.sh` — NOT the retired Hermes gateway cron scheduler); the box holds only an `agent`-scoped token. Treat these as fixed pollers behind the server boundary, not live agents. See [docs/agents/hermes-agent.md](./docs/agents/hermes-agent.md) and the fluncle-hermes-operator skill (its "add/change a cron" fan-out checklist).
- SHOULD: Preserve existing server module boundaries under `apps/web/src/lib/server` and API route handlers under `apps/web/src/routes/api`.
- SHOULD: Name new public surfaces (CLI / API / MCP / SSH) per the cross-surface `verb_noun` convention in [docs/naming-conventions.md](./docs/naming-conventions.md), so one operation reads the same everywhere.
- MUST: Order options in `createFileRoute(...)({...})` and `createRootRoute({...})` by TanStack's canonical sequence (params → validateSearch → loaderDeps → context → beforeLoad → loader → head → scripts), since each step feeds the next step's type inference.
- MUST: Put `// oxlint-disable-next-line sort-keys` directly above any such route definition whose canonical order breaks alphabetical key order (e.g. `loader` before `head`); `eslint/sort-keys` stays on and auto-fixed everywhere else.

## UI Components

- MUST: Lead with the Shadcn design system for web UI.
- MUST: Read [PRODUCT.md](./PRODUCT.md) before UI or copy edits.
- MUST: Keep the public app dark-only, cover-led, centered, quiet, fast, and aligned with Fluncle's music-first product direction.
- MUST: Target WCAG AA contrast for text and controls, preserve keyboard access for interactive rows and links, and respect reduced-motion preferences.
- MUST: Use Shadcn-managed components from `apps/web/src/components/ui/` for shared UI patterns.
- MUST: Use Shadcn components by their canonical generated exports; do not add local aliases or wrappers when an exact Shadcn component exists.
- NEVER: Import headless primitives such as `@base-ui/react/*` directly in app code.
- NEVER: Bypass the design system with ad hoc headless primitive usage in feature code.
- MUST: Draw interface icons from Phosphor and third-party platform logos (Spotify, YouTube, TikTok, …) from `simple-icons` — via `BrandIcon` or `@/components/platform-icons`; never a Phosphor logo glyph for a brand mark (DESIGN.md "Iconography").
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

- SHOULD: Two git modes, decided by **where the work runs**, not by who is running it. Work in the **main checkout** commits straight on `main` — no feature branch, no PR. Work running in a **delegated sub-agent's isolated worktree is delivered as a PR**: a worktree sub-agent opens a PR and does **not** push to `main` (unless its brief says otherwise); the orchestrating session reviews the diff and merges it (`gh pr merge --squash --admin --delete-branch`). See the `agent-orchestration` skill. Either way, a push to `main` auto-deploys (mind the coalescing note under External Effects).
- MUST: If `git commit` fails because Git cannot write commit metadata or access signing helpers, retry the commit with elevated permissions before changing Git config.
- On headless/automation runs the 1Password SSH agent can be unavailable — signing and SSH push fail even with the sandbox off; fetch/push over HTTPS with `git -c credential.helper='!gh auth git-credential'` instead (`gh` itself is keyring-backed, so it also needs the sandbox off).
- NEVER: Disable commit signing with `commit.gpgsign=false` unless the user explicitly asks for an unsigned commit.

## Agent Skills

- Applies to skills created via `/skill-creator`, `Skill Creator`, or `$skill-creator`
- MUST: Put new skills in `packages/skills`
- MUST: Verify skills with `UV_CACHE_DIR=/tmp/uv-cache uv run --with pyyaml python "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" packages/skills/<skill-path>`
- MUST: Install/refresh local skills with `bun run skills:install` (it runs `npx skills add … -a claude-code -a codex` for every skill sequentially AND normalizes `skills-lock.json` sources from machine-absolute to repo-relative — running the raw `npx skills add` directly bakes a `/Users/…` path into the committed lockfile, a topology leak). `bun run skills:install --dry-run` previews. Re-run it after editing ANY skill: the installed `.agents/skills/**` copy is what actually loads, and it goes stale (and ships stale publicly) until re-synced.
