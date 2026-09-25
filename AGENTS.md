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
- NEVER commit the secret-management MAP either: concrete `op://<vault>/<item>` 1Password paths, hostnames, IPs, identifying service ports, internal URLs, tailnet names, webhook URLs, or local `/Users/...` paths. They are references rather than secrets, but they hand out the topology. A port is forbidden only when it identifies THIS topology: a well-known default or a conventional alternate that any host could be running grants nothing and may be committed in runnable form (Tailscale's UDP 41641, the alt-SSH 2222 in the [hetzner-devbox](./packages/skills/hetzner-devbox) scripts). Use a PLACEHOLDER (`op://$FLUNCLE_1PASSWORD_ENV_ITEM/<field>` as in `apps/web/.dev.vars.tpl`, or `op://<vault>/<item>/<field>`); the concrete map lives in the private companion repo (see _Private companion_ below). A working-tree grep in CI (`.github/workflows/gitleaks.yml`) backstops the `op://` case.
- Public runtime IDENTIFIERS are fine (the R2 account id, the IndexNow token, the two Sentry DSNs, the Cloudflare cache-purge zone id — all allowlisted in `.gitleaks.toml`): they grant nothing without the matching secret.
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
- Large media uploads (`fluncle admin recordings create --video`, `fluncle admin mixtapes distribute`) run on the M5 and must be started by the operator in a direct Terminal session. Agent shell sessions do not reliably sustain multi-GB transfers. Use `dangerouslyDisableSandbox` for SSH-signed commits through the 1Password agent socket and moderate transfers; follow the [fluncle-mixtapes](./packages/skills/fluncle-mixtapes) skill for the upload workflow.

## Work Standard

- MUST: If it can be automated, it should be automated. When the choice is "automation is possible but it will require work" versus "do it manually," choose automation every time — with AI the marginal cost of completeness is near zero. The point of this project is reach: how far Fluncle's tentacles stretch across the web (search engines, AI crawlers, and ultimately real humans — DnB fans, artists). A manual step is reach that does not scale. The ONLY exception is a genuine, documented platform constraint with no automatable path (e.g. TikTok licensed audio must be attached in the app) — and even then, automate everything up to and after the irreducible manual step, and capture its result automatically.
- MUST: When asked for something, deliver the finished product — implementation + tests + documentation — not a plan to build it and not a workaround, whenever the permanent solve is within reach. Close a dangling thread when tying it off takes five more minutes.
- MUST: Prefer a complete, durable fix over a workaround when the full fix is reasonably reachable in the current task.
- MUST: Build the real implementation instead of papering over behavior when the implementation path is small and well-scoped.
- MUST: Search the codebase before adding new patterns, helpers, dependencies, or abstractions.
- MUST: Carry implementation work through verification: update focused tests/docs when behavior changes, run the relevant checks, and report any checks that could not be run.
- MUST: Back factual claims, numbers, and named blockers with evidence gathered in the current turn: command or query output, or specific code lines. Verify the relevant code and current Git state before attributing a failure.
- MUST: Close obvious follow-through items discovered during the task when they are directly related and low-risk.
- MUST: Never silently drop queued or delegated work: before ending a session, reconcile everything launched (sub-agents, renders, box crons, background jobs) and report anything still in flight.
- SHOULD: Ask before expanding scope into unrelated refactors, production changes, paid infrastructure, destructive operations, or work that changes product direction.
- SHOULD: When an adjacent risk or opportunity surfaces mid-task (a migration hazard, another consumer, a production concern), record it as a one-line follow-up note and stay on the asked task rather than silently widening the change. Answer from the repo before reaching for `AskUserQuestion`. Use `AskUserQuestion` only for decisions the repository cannot settle.
- NEVER: Stop at a plan when the user asked for implementation and the implementation is feasible.
- NEVER: Present a workaround as complete when a known real fix remains.

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

- Every change uses the dependency-closure contract in `scripts/quality/classifier.mjs`; unknown paths, lockfiles, root configuration, workflow topology, and scheduled/manual runs fail closed to the full matrix. `bun run quality:classify -- --base <sha> --head <sha>` explains the selected leaves.
- Edit hooks start the fingerprinted affected preflight without blocking. Run `bun run quality:preflight -- status` while working and `bun run quality:preflight -- join` before a commit or handoff; a content or configuration change rejects stale results and queues the new fingerprint. Targeted browser tests are early feedback only; the selected web closure still gates on the full deterministic E2E suite.
- TypeScript: `bun run typecheck` from the repo root, or the nearest package `typecheck` for focused changes.
- Lint and format: `bun run check` from the repo root for broad validation.
- Web changes: `bun run --cwd apps/web typecheck`, `bun run --cwd apps/web build`, and `bun run --cwd apps/web lint` when relevant.
- CLI changes: `bun run --cwd apps/cli typecheck` and focused CLI commands such as `bun run --cwd apps/cli fluncle recent --limit 1 --json` when behavior changes.
- Raycast changes: `bun run --cwd apps/raycast build` and `bun run --cwd apps/raycast lint`. If lint fails only on Raycast formatting, run `bun run --cwd apps/raycast lint -- --fix` and keep the resulting changes scoped to `apps/raycast`.
- Go app changes (`apps/ssh` the rave terminal, `apps/dns` the DNS server): `go build -C apps/<app> ./...`, `gofmt -l apps/<app>` (must list nothing), and `go vet -C apps/<app> ./...`.
- Rust app changes (`apps/sonar` the vector engine): `cargo fmt --manifest-path apps/sonar/Cargo.toml --check`, `cargo clippy --manifest-path apps/sonar/Cargo.toml --all-targets -- -D warnings`, and `cargo test --manifest-path apps/sonar/Cargo.toml`.
- Video package changes: `bun run --cwd packages/video typecheck`.
- NEVER: Use the TypeScript non-null assertion operator (`!`). Narrow with a guard, early return, `??`, or `?.`. Enforced as an error by oxlint (`typescript/no-non-null-assertion`).
- SHOULD: Run focused checks first, then broader root checks when the change has cross-package or user-facing risk.
- SHOULD: For docs-only changes, verify formatting/readability instead of running full test suites unless docs generation is affected.

## External Effects

- MUST: Ask before destructive operations, production deploys, paid infrastructure changes, bulk sends, credential rotations, or changes that publish to Spotify, Telegram, Discord, or Cloudflare.
- MUST: Report when required validation depends on external services and could not be run locally.
- NEVER: Invent secrets, credentials, listener data, analytics data, or production state.
- MUST: Treat a push to `main` as a production deploy. `scripts/quality/deploy-watch-paths.json` is the exact Cloudflare Workers Builds exclusion contract; `bun run quality:classify` and `node scripts/quality/deploy-watch.mjs verify <live-export>` fail closed around it and keep the post-deploy decision synchronized. Quality Checks always reports its stable protected context; public-web E2E runs only for its web/shared/migration closure and the full backstop. Space deploy-triggering merges and verify the Workers Build for the final commit. If the check is absent, classify the diff: an excluded-only change is an expected skip; any deployable path requires an operator-triggered rebuild. Compare `/api/v1/health` with the latest commit that touches a deployable path. The event-driven probe and its bounded polling fallback are specified in [docs/quality-system.md](./docs/quality-system.md).
- The prod deploy is gated by `bun run deploy:gate` (repository format check + the Go apps' `gofmt` and `go vet` checks + type-aware lint + typecheck + every package's tests, the Go apps' `go test` included) in the Cloudflare Build command — a failing gate aborts the build before `wrangler deploy`. Outside it, caught by the `quality-checks` GitHub Action on the PR but never by the deploy gate: `apps/sonar` entirely (no `package.json`, so turbo cannot see its Rust `cargo fmt`/`clippy`/`test`), and the Hermes box-script suite (`test:scripts:box`, the `docs/agents/hermes/scripts` tests): those scripts are baked into the rave-02 image by the pin-watch pipeline, not shipped by the Workers Build, and their process-level tests take minutes of real time, so they gate the PR through `check`, never the Worker deploy.
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
- [README.md](./README.md) - repo overview: package layout, local dev, deployment, CLI, Raycast, publish flow.
- [LORE.md](./LORE.md) - the story canon; wins on story over the other three canons.
- [PRODUCT.md](./PRODUCT.md) - product purpose, brand direction, design principles, accessibility.
- [DESIGN.md](./DESIGN.md) - the visual canon (the Nostalgic Cosmos) and its named visual rules.
- [VOICE.md](./VOICE.md) - the language canon: persona, vocabulary, voice rules, surface registers.
- [docs/local-database.md](./docs/local-database.md) - read before touching databases, dev/worktree DB setup, or the migrate step; holds the hosted-vs-local query shapes.
- [docs/quality-system.md](./docs/quality-system.md) - read when changing CI, the classifier, preflight, or deploy verification.
- [docs/database-performance.md](./docs/database-performance.md) - read before any database performance or scale claim, budget, or fixture change.
- [docs/track-lifecycle.md](./docs/track-lifecycle.md) - read when changing how a track is added, enriched, updated, or tagged.
- [docs/admin-shell.md](./docs/admin-shell.md) - read before building or changing any `/admin` surface, admin auth, or the admin browser fixtures.
- [docs/client-bundle.md](./docs/client-bundle.md) - read before importing server code or CSS into an `apps/web` route; the `fluncle-client-chunk-purity` build gate enforces it.
- [docs/error-tracking.md](./docs/error-tracking.md) - read when touching Sentry, tracing, source maps, or the sentry-triage cron.
- [docs/search.md](./docs/search.md) - read when changing search: the resolver tiers, the sonic tier, degradation.
- [docs/artist-relationship.md](./docs/artist-relationship.md) - read when changing the artist entity, artist resolution, or `/artist` pages.
- [docs/catalogue-crawler.md](./docs/catalogue-crawler.md) - read when changing the catalogue crawler, its boundary gate, or the crawl frontier.
- [docs/label-entity.md](./docs/label-entity.md) - read when changing the label entity, crawl-seed rulings, or `/admin/labels`.
- [docs/album-entity.md](./docs/album-entity.md) - read when changing albums or the graph pages (log, artist, label, album) and their hub indexes, including the unnamed tier.
- [docs/track-destination.md](./docs/track-destination.md) - read when changing `/track/<trackId>`, its indexing predicates, or its sitemap.
- [docs/album-artwork.md](./docs/album-artwork.md) - read when changing cover masters, image serving, or artwork sources.
- [docs/the-ear.md](./docs/the-ear.md) - read when changing catalogue ranking or capture priority.
- [docs/gpu-batch-embed.md](./docs/gpu-batch-embed.md) - read when changing audio work queues, the certification rail on `updateTrack`, or the batch embed.
- [docs/vector-serving.md](./docs/vector-serving.md) - read before touching `apps/sonar`, `POST /search`, its fallback, or the sonar feature flags.
- [docs/artifact-change-protocol.md](./docs/artifact-change-protocol.md) - read when producing or consuming a derived artifact stream (Sonar, device mirror).
- [docs/agents/newsletter-agent.md](./docs/agents/newsletter-agent.md) - read when changing the weekly newsletter sweep or its send flow.
- [packages/video/README.md](./packages/video/README.md) - read when changing the Remotion video machinery or the video output contract.
- [docs/video-variants.md](./docs/video-variants.md) - read when changing video masters or their derived variants.
- [docs/live-show-setup.md](./docs/live-show-setup.md) - operator runbook for the live show rig and its pre-show checklist.
- [docs/set-video.md](./docs/set-video.md) - runbook for rendering a mixtape's hour-long set video.
- [docs/fluncle-studio.md](./docs/fluncle-studio.md) - read when changing recordings, the recording upload, or set → clip cutting.
- [docs/mixtape-recording-setup.md](./docs/mixtape-recording-setup.md) - operator runbook for wiring the mixtape recording rig.
- [packages/live/README.md](./packages/live/README.md) - read when changing the live runtime (the glass and the bridge) or RANDOM-VJ mode.
- [docs/live-deck-identity.md](./docs/live-deck-identity.md) - read when changing live deck identification (MIDI + OCR) for unordered sets.
- [packages/media/README.md](./packages/media/README.md) - read when changing rendered stills: OG cards, banners, app icon, covers.
- [docs/galaxy.md](./docs/galaxy.md) - read when changing the Galaxy game.
- [docs/galaxy-sprites.md](./docs/galaxy-sprites.md) - read when making Galaxy sprite or audio assets.
- [docs/agents/prompt-registry.md](./docs/agents/prompt-registry.md) - read before changing any runtime model prompt; a DB row overrides the baked default.
- [docs/agents/enrichment-agent.md](./docs/agents/enrichment-agent.md) - bootstrap for the async track agent (enrich → video → publish).
- [docs/agents/render-conductor.md](./docs/agents/render-conductor.md) - read when changing the per-finding video render pipeline or its conductor.
- [packages/skills/fluncle-box-restore](./packages/skills/fluncle-box-restore) - read when rebuilding rave-02 or checking restore readiness.
- [docs/agents/hermes-agent.md](./docs/agents/hermes-agent.md) - read when changing the Hermes sweep box, its agent-token role model, or its secrets.
- [docs/agents/observation-agent.md](./docs/agents/observation-agent.md) - read when changing the audio observation or its voice gate.
- [docs/agents/note-agent.md](./docs/agents/note-agent.md) - read when changing the auto-authored finding note.
- [docs/agents/bio-agent.md](./docs/agents/bio-agent.md) - read when changing artist, label, or album bios.
- [docs/agents/triage-agent.md](./docs/agents/triage-agent.md) - read when changing submission triage verdicts.
- [docs/agents/logbook-agent.md](./docs/agents/logbook-agent.md) - read when changing the Logbook or its `[[<logId>]]` token contract.
- [docs/agents/cluster-engine.md](./docs/agents/cluster-engine.md) - read when changing sonic-galaxy clustering or its cron.
- [docs/agents/smoke-routine.md](./docs/agents/smoke-routine.md) - read when changing or diagnosing the nightly admin-smoke routine.
- [docs/socials/](./docs/socials/) - the social accounts, profile assets, and bio conventions.
- [packages/skills/fluncle-mixtapes](./packages/skills/fluncle-mixtapes) - read when publishing a mixtape or changing the mixtape model.
- [docs/naming-conventions.md](./docs/naming-conventions.md) - read before naming a new CLI / API / MCP / SSH operation.
- [docs/surfaces-doctrine.md](./docs/surfaces-doctrine.md) - the registry-driven map of every surface and its per-context weights.
- [docs/dig.md](./docs/dig.md) - read when changing findings over DNS (`apps/dns`).
- [docs/tor.md](./docs/tor.md) - read when changing the Tor onion mirror.
- [packages/skills/fluncle-surfaces](./packages/skills/fluncle-surfaces) - read when registering or changing a surface.
- `mk-agent-orchestration` (installed globally, not vendored) - routing, delegation, worktrees, and review.
- [docs/mobile-release.md](./docs/mobile-release.md) - runbook from simulator to TestFlight to App Store review.
- [docs/app-store-review.md](./docs/app-store-review.md) - read before any store submission.
- [docs/reach-tier2-activation.md](./docs/reach-tier2-activation.md) - runbook for the `/reach` page's platform numbers.
- [docs/audit-backlog.md](./docs/audit-backlog.md) - the nightly audit's findings ledger; a worklist, never specification.
- [docs/db-scale-backlog.md](./docs/db-scale-backlog.md) - the DB query-shape scale ledger; a worklist, never specification.

## Architecture

- MUST: Keep `apps/web` as the owner of public and admin API routes, including Spotify, Telegram, Discord, and Turso mutation behavior.
- MUST: Put public/admin HTTP surfaces on oRPC contract ops by default (`packages/contracts/src/orpc/**`, registered in the `apps/web/src/lib/server/orpc/**` router); `handleOrpc` is mounted ahead of the TanStack router in `server.ts`, so a contract op shadows any file-route at the same method+path. New surfaces go on oRPC. The only `apps/web/src/routes/api/**` file-route carve-outs are: auth/OAuth redirects (Spotify/YouTube/Mixcloud/Discord starts+callbacks, admin login/logout); large-body/streaming/direct-upload routes (multipart uploads, media proxies/presigns); non-JSON emitters (feeds/sitemap/robots/`llms.txt`/`.well-known`/the CLI install script/OG + cover images/the generated OpenAPI+Postman specs); and the `/status` resource-read. The build-fail coverage tests enforce this: `orpc-coverage` / `orpc-admin-coverage` (any non-carve-out route without a contract fails the build), `orpc-auth-coverage` (each op carries the right auth tier), and `orpc-naming` (the `verb_noun` convention).
- MUST: Keep the CLI as a thin HTTP client for public reads/submissions and authenticated admin commands.
- MUST: Keep Raycast commands calling the `fluncle` CLI rather than reimplementing Spotify, Telegram, Turso, or HTTP API behavior.
- MUST: Keep publishing authority behind the authenticated admin API.
- SHOULD: Run recurring agent work as deterministic `--no-agent` sweeps on rave-02 host systemd timers, baked to `/opt/hermes-scripts` and scheduled by the units under `docs/agents/hermes/<job>-timer/` plus `install-host-timers.sh`. The box holds only an `agent`-scoped token. Treat these as fixed pollers behind the server boundary, not live agents. See [docs/agents/hermes-agent.md](./docs/agents/hermes-agent.md) and the fluncle-hermes-operator skill (its "add/change a cron" fan-out checklist).
- SHOULD: Preserve existing server module boundaries under `apps/web/src/lib/server` and API route handlers under `apps/web/src/routes/api`.
- SHOULD: Name new public surfaces (CLI / API / MCP / SSH) per the cross-surface `verb_noun` convention in [docs/naming-conventions.md](./docs/naming-conventions.md), so one operation reads the same everywhere.
- MUST: Order options in `createFileRoute(...)({...})` and `createRootRoute({...})` by TanStack's canonical sequence (params → validateSearch → loaderDeps → context → beforeLoad → loader → head → scripts), since each step feeds the next step's type inference.
- MUST: Put `// oxlint-disable-next-line sort-keys` directly above any such route definition whose canonical order breaks alphabetical key order (e.g. `loader` before `head`); `eslint/sort-keys` stays on and auto-fixed everywhere else.
- MUST: Fetch a route's data through one primitive — a `createServerFn({ method: "GET" })` handler that the route's `loader:` calls, read in the component via `Route.useLoaderData()`. `createServerFn` is never a data-fetching pattern that competes with the loader; it is what the loader calls. A **public** route stops there — loader + `useLoaderData`, no react-query — exemplar `apps/web/src/routes/artist.$slug.tsx`.
- MUST: Give an **admin** route the loader-seeded react-query hybrid — the loader seeds a `useQuery`/`useInfiniteQuery` whose `initialData` is the loaded value, so the live board hydrates from SSR yet can refetch, paired with `useMutation` for writes — and set `refetchOnWindowFocus: true` on those admin queries; exemplar `apps/web/src/routes/admin/labels.tsx`. The axis is signed-in live surface vs anonymous cached read: an admin board or a signed-in listener's own door refetches on focus, an anonymous public read does not. A route may deviate either way when the owning doc explains why — a settings pane that has nothing live to catch, or an expensive board whose data is a nightly artifact. The single `QueryClient` lives in `__root.tsx`; there are no client-wide `defaultOptions`, so each query states its own focus-refetch.
- MUST: Reach for the hybrid (react-query over loader-seeded SSR data) only when a route genuinely needs client-side liveness — focus refetch, infinite pagination, or optimistic mutations — and then the seed is mandatory: `initialData` from `useLoaderData`, never a second unseeded fetch of the same data the loader already returned. Public infinite-scroll seeds the same way (exemplar `apps/web/src/routes/index.tsx`, a `useInfiniteQuery` seeded from the loader's first page). A secondary on-demand panel (search, a lazily-opened detail) may add its own unseeded `useQuery` for data the loader does not carry — that is not a duplicate fetch.

## UI Components

- MUST: Lead with the Shadcn design system for web UI.
- MUST: Read [PRODUCT.md](./PRODUCT.md) before UI or copy edits.
- MUST: Keep the public app dark-only, cover-led, centered, quiet, fast, and aligned with Fluncle's music-first product direction.
- MUST: Target WCAG AA contrast for text and controls, preserve keyboard access for interactive rows and links, and respect reduced-motion preferences.
- MUST: Use the Shadcn-managed components from `packages/ui` for shared UI patterns, imported as `@fluncle/ui/components/<name>`. There is no per-app `ui/` directory; every primitive lives in the shared package.
- MUST: Use Shadcn components by their canonical generated exports; do not add local aliases or wrappers when an exact Shadcn component exists.
- NEVER: Import headless primitives such as `@base-ui/react/*` directly in app code.
- MUST: Draw interface icons from Phosphor and third-party platform logos (Spotify, YouTube, TikTok, …) from `simple-icons` — via `BrandIcon` or `@/components/platform-icons`; never a Phosphor logo glyph for a brand mark (DESIGN.md "Iconography").
- SHOULD: Avoid SaaS dashboards, bright streaming-app clones, generic landing-page hero sections, oversized marketing copy, glassy card stacks, and decorative gradients that ignore the cover art.
- When a Shadcn component is missing, add it through the Shadcn CLI from `packages/ui` (its `components.json` is the one that maps the aliases) before using it, for example:

```bash
cd packages/ui && bunx --bun shadcn@latest add dialog
```

- Keep generated Shadcn components aligned with the existing design tokens and local component conventions before using them in feature code.

## Public Copy

- MUST: Write every public-facing string through the `copywriting-fluncle` skill — load it BEFORE drafting and run its final checks before committing. Public-facing means anything a non-operator reads: web pages outside `/admin`, mobile, meta/OG/link-preview text, feeds, SSH/CLI human-facing text, and social. This applies to one-line edits and empty states; small strings count.
- MUST: Treat the operator tier as the other side of that boundary — the `fluncle admin …` CLI and every `/admin` route are not public copy, and their register carve-out (the em-dash clause join and terse ALL-CAPS status words, nothing else) is written into [packages/skills/copywriting-fluncle/references/voice.md](./packages/skills/copywriting-fluncle/references/voice.md) §5.
- MUST: Run `canon-reviewer` after every public-copy change, including delegated work, and treat its Flat Copy Test as blocking: copy that describes the page's mechanism (the query window, the sort order, a data-model distinction) instead of speaking from Fluncle's body is off-voice even when mechanically clean. Name both the `copywriting-fluncle` drafting gate and the `canon-reviewer` acceptance gate in each public-surface brief.

## Database

- MUST: Generate SQL migrations via `bun run --cwd apps/web db:generate`.
- MUST: Keep generated migration metadata with the schema change that caused it.
- NEVER: Write SQL migrations by hand. The one exception is a DATA MOVE the generator cannot express (backfilling rows a schema change is about to strand, e.g. `drizzle/0022` and `drizzle/0068`): add that statement to the generated file and say in a comment above it that it is authored and why it must run inside the migration. The DDL stays generated.
- SHOULD: Treat Turso/libSQL as the source of persisted app data. Everyday local dev runs against a per-worktree local libSQL server (see [docs/local-database.md](./docs/local-database.md)); never commit database files or ad hoc database state (the local db lives under the gitignored `apps/web/.dev/`).
- MUST: Validate performance and scale claims against hosted Turso. `turso dev` (sqld) and hosted Turso differ in query-planner, response-size, and vector behavior; use the hosted query shapes documented in [docs/local-database.md](./docs/local-database.md) ("Local is not production"). The four constraints are:
  - **Bind a query vector as a raw BLOB, never as text.** Hosted: 1,883 ms (blob) vs 26,700 ms (text) at 100k — a 14× cliff. Locally: identical either way, so the slow version looks fine in dev.
  - **NEVER create a `libsql_vector_idx` on a populated table.** Hosted Turso can lock writes for 20+ minutes, while local sqld can produce an empty index. Use an exact `vector_distance_cos` scan with a btree pre-filter on key/BPM or galaxy.
  - **NEVER pull a whole column into the isolate to rank it.** Local sqld caps a response at 10 MiB (so it throws); hosted has no cap (so it silently grows toward OOMing the 128 MB Worker). Rank in SQL.
  - **NEVER express a multi-probe scan as `union all` branches over a CTE.** The planner flattens the CTE and repeats the candidate scan once per branch, so 12 probes cause 12 scans (63 s hosted on `/recommendations`). Fold probes into one pass with `min(vector_distance_cos(vec, ?), …)` in the select list; one-argument `min()` is the aggregate, so a single probe binds bare.

## Dependencies

- MUST: Keep lockfile changes with the dependency change that caused them.
- MUST: Follow the existing workspace catalog and version-range style when adding dependencies.
- SHOULD: Avoid new dependencies when an existing repo package or platform API is sufficient.

## Git

- SHOULD: Two git modes, decided by **where the work runs**, not by who is running it. Work in the **main checkout** commits straight on `main` — no feature branch, no PR. Work running in a **delegated sub-agent's isolated worktree is delivered as a PR**: a worktree sub-agent opens a PR and does **not** push to `main` (unless its brief says otherwise); the orchestrating session reviews the diff and merges it (`gh pr merge --squash --admin --delete-branch`). See the `mk-agent-orchestration` skill. Either way, a push to `main` auto-deploys (mind the coalescing note under External Effects).
- For draft-guarded CI, keep the PR draft through edits, local preflight, and local review; mark it ready once for protected contexts, then follow the normal reviewed PR path after they succeed on that head.
- MUST: If `git commit` fails because Git cannot write commit metadata or access signing helpers, retry the commit with elevated permissions before changing Git config.
- On headless/automation runs the 1Password SSH agent can be unavailable — signing and SSH push fail even with the sandbox off; fetch/push over HTTPS with `git -c credential.helper='!gh auth git-credential'` instead (`gh` itself is keyring-backed, so it also needs the sandbox off).
- NEVER: Disable commit signing with `commit.gpgsign=false` unless the user explicitly asks for an unsigned commit.

## Agent Skills

- Applies to skills created via `/skill-creator`, `Skill Creator`, or `$skill-creator`
- MUST: Put new skills in `packages/skills`
- MUST: Verify skills with `UV_CACHE_DIR=/tmp/uv-cache uv run --with pyyaml python "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" packages/skills/<skill-path>`
- MUST: Run `bun run skills:install` after editing any skill. It refreshes `.agents/skills/**` and normalizes `skills-lock.json` sources to repository-relative paths. Use `bun run skills:install --dry-run` to preview.
