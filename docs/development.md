# Development conventions

Read the relevant section before changing HTTP routes, route data loading, Effect modules, shared UI, package checks, dependencies, or local agent skills. [AGENTS.md](../AGENTS.md) holds repository-wide workflow and public-repository rules; [the documentation map](./README.md) routes to area-specific contracts.

## Architecture

- MUST: Keep `apps/web` as the owner of public and admin API routes, including Spotify, Telegram, Discord, and Turso mutation behavior.
- MUST: Put public/admin HTTP surfaces on oRPC contract ops by default (`packages/contracts/src/orpc/**`, registered in the `apps/web/src/lib/server/orpc/**` router); `handleOrpc` is mounted ahead of the TanStack router in `server.ts`, so a contract op shadows any file-route at the same method+path. New surfaces go on oRPC. The only `apps/web/src/routes/api/**` file-route carve-outs are: auth/OAuth redirects (Spotify/YouTube/Mixcloud/Discord starts+callbacks, admin login/logout, and the follows email's unsubscribe link opened in a browser, which 303s to `/follows`); large-body/streaming/direct-upload routes (multipart uploads, media proxies/presigns); non-JSON emitters (feeds/sitemap/robots/`llms.txt`/`.well-known`/the CLI install script/OG + cover images/the generated OpenAPI+Postman specs); and the `/status` resource-read. `POST /api/v1/monitoring`, the Sentry envelope relay, is a transport handled in `server.ts` ahead of `withSentry` (like MCP and agent discovery) and stays off oRPC. The build-fail coverage tests enforce this: `orpc-coverage` / `orpc-admin-coverage` (any non-carve-out route without a contract fails the build), `orpc-auth-coverage` (each op carries the right auth tier), and `orpc-naming` (the `verb_noun` convention).
- MUST: Keep the CLI as a thin HTTP client for public reads/submissions and authenticated admin commands.
- MUST: Keep Raycast commands calling the `fluncle` CLI rather than reimplementing Spotify, Telegram, Turso, or HTTP API behavior.
- MUST: Keep publishing authority behind the authenticated admin API.
- SHOULD: Run recurring agent work as deterministic `--no-agent` sweeps on the sweep host's systemd timers, baked to `/opt/hermes-scripts` and scheduled by the units under `docs/agents/hermes/<job>-timer/` plus `install-host-timers.sh`. The box holds only an `agent`-scoped token. Treat these as fixed pollers behind the server boundary, not live agents. See [docs/agents/hermes-agent.md](../docs/agents/hermes-agent.md) and the fluncle-hermes-operator skill (its "add/change a cron" fan-out checklist).
- SHOULD: Preserve existing server module boundaries under `apps/web/src/lib/server` and API route handlers under `apps/web/src/routes/api`.
- SHOULD: Name new public surfaces (CLI / API / MCP / SSH) per the cross-surface `verb_noun` convention in [docs/naming-conventions.md](../docs/naming-conventions.md), so one operation reads the same everywhere.
- MUST: Order options in `createFileRoute(...)({...})` and `createRootRoute({...})` by TanStack's canonical sequence (params → validateSearch → loaderDeps → context → beforeLoad → loader → head → scripts), since each step feeds the next step's type inference.
- MUST: Put `// oxlint-disable-next-line sort-keys` directly above any such route definition whose canonical order breaks alphabetical key order (e.g. `loader` before `head`); `eslint/sort-keys` stays on and auto-fixed everywhere else.
- MUST: Fetch a route's data through one primitive — a `createServerFn({ method: "GET" })` handler that the route's `loader:` calls, read in the component via `Route.useLoaderData()`. `createServerFn` is never a data-fetching pattern that competes with the loader; it is what the loader calls. A **public** route stops there — loader + `useLoaderData`, no react-query — exemplar `apps/web/src/routes/artist.$slug.tsx`.
- MUST: Give an **admin** route the loader-seeded react-query hybrid — the loader seeds a `useQuery`/`useInfiniteQuery` whose `initialData` is the loaded value, so the live board hydrates from SSR yet can refetch, paired with `useMutation` for writes — and set `refetchOnWindowFocus: true` on those admin queries; exemplar `apps/web/src/routes/admin/labels.tsx`. The axis is signed-in live surface vs anonymous cached read: an admin board or a signed-in listener's own door refetches on focus, an anonymous public read does not. A route may deviate either way when the owning doc explains why — a settings pane that has nothing live to catch, or an expensive board whose data is a nightly artifact. The single `QueryClient` lives in `__root.tsx`; there are no client-wide `defaultOptions`, so each query states its own focus-refetch.
- MUST: Reach for the hybrid (react-query over loader-seeded SSR data) only when a route genuinely needs client-side liveness — focus refetch, infinite pagination, or optimistic mutations — and then the seed is mandatory: `initialData` from `useLoaderData`, never a second unseeded fetch of the same data the loader already returned. Public infinite-scroll seeds the same way (exemplar `apps/web/src/routes/index.tsx`, a `useInfiniteQuery` seeded from the loader's first page). A secondary on-demand panel (search, a lazily-opened detail) may add its own unseeded `useQuery` for data the loader does not carry — that is not a duplicate fetch.

## Effect

- MUST: Keep Effect to the modules that already use it (`rg -l 'from "effect"' apps/web/src apps/cli/src`). The adoption stopped after its first wave because it grew the code instead of shrinking it, so moving another module, the oRPC handlers or the database layer onto Effect needs Maurice's go-ahead first. `packages/contracts` stays on zod, and mobile, the extensions and every client chunk stay Effect-free; the `fluncle-client-chunk-purity` gate fails the build when `effect` reaches a client chunk.
- MUST: Write Effect 4 from `node_modules/effect/AGENTS.md`, `node_modules/effect/ai-docs` and the package's `.d.ts` files, never from memory: v3 idioms (`Context.Tag`, `Effect.Service`, `@effect/schema`, `@effect/platform`) are wrong here. `apps/web`'s `typecheck` runs `effect-tsgo diagnostics --strict`, which flags them.
- MUST: Never let one request's fiber wake another's. In workerd that hangs the woken request, so state shared across requests (a module-level queue, gate or cache) hands off through Promises, never a shared `Deferred`, `Semaphore`, `Queue`, `Pool` or `Latch`. See `lib/server/effect/spaced-queue.ts`. Layers in the isolate runtime build synchronously.
- MUST: Keep a migrated module's exports Promise-based until its callers are Effect, and cross that edge with `runServerEffect` (`lib/server/effect/runtime.ts`); it rejects with the typed failure itself, so `instanceof ApiError` and `apiFault` keep working. Define errors with `Data.TaggedError` (`Schema.TaggedError` pulls the whole `Schema` module into the Worker), use `Effect.tryPromise` with its abort signal plus `Effect.timeout` for outbound calls, and `keepAlive` (`lib/server/effect/wait-until.ts`) for background work.

## UI Components

- MUST: Lead with the Shadcn design system for web UI.
- MUST: Read [PRODUCT.md](../PRODUCT.md) before UI or copy edits.
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

## Quality Checks

- Every change uses the dependency-closure contract in `scripts/quality/classifier.mjs`; unknown paths, lockfiles, root configuration, workflow topology, and scheduled/manual runs fail closed to the full matrix. Worktrunk's local worktree setup (`.config/wt.toml`, `.worktreeinclude`) is the one root-configuration exception: no check or deploy reads it, so it selects static policy only. `bun run quality:classify -- --base <sha> --head <sha>` explains the selected leaves.
- Edit hooks only format the touched file. Before a commit or handoff, run the checks for the packages you changed; `bun run quality:classify` names the affected leaves. Quality Checks and `deploy:gate` run the full matrix.
- To inspect or verify a running UI, use the global `agent-browser` skill (the pinned `agent-browser` CLI); use Chrome DevTools MCP only for performance traces.
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

## Dependencies

- MUST: Keep lockfile changes with the dependency change that caused them.
- MUST: Follow the existing workspace catalog and version-range style when adding dependencies.
- SHOULD: Avoid new dependencies when an existing repo package or platform API is sufficient.
- MUST: Record a hold as a `renovate.json` package rule with its reason in `description`. `taze.config.ts` reads the gate from `bunfig.toml` and the holds from `renovate.json`. Outright holds become excludes, and `allowedVersions: "<x"` becomes a range exclude. Major-only holds are left out of the excludes, so check them before taking any major from `bunx taze major`.
- Upgrades follow the `mk-dependency-upgrades` skill. The Hermes box pins and `.deepsec/pnpm-lock.yaml` follow `fluncle-maintenance`.
- Checks: `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test`, `bun run test:scripts`, `bun run audit`, `bun run build`.
- Groups: `ai` with `@ai-sdk/react`, which pins `ai` exactly. `better-auth` with `@better-auth/expo`, at one version in web and mobile. All `@orpc/*` packages through the catalog. Every `remotion` and `@remotion/*` package together with the bundler patch re-key. Mobile's exact `react` with the catalog `react` and `react-dom` (`scripts/react-version.test.ts`). The Expo set moves only with an Expo SDK bump, via `npx expo install --fix`.
- Smoke test: run the Playwright specs for what moved, with `bun run --cwd apps/web test:e2e tests/e2e/<spec>`. Routing and the masked story dialog: `findings`, `front-door`. Auth: `account`, `follow`, `follow-digest`, `save-share`. Chat streaming: `src/lib/server/chat-stream.test.ts`.

## Agent Skills

- Applies to skills created via `/skill-creator`, `Skill Creator`, or `$skill-creator`
- MUST: Put new skills in `packages/skills`
- MUST: Verify skills with `UV_CACHE_DIR=/tmp/uv-cache uv run --with pyyaml python "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" packages/skills/<skill-path>`
- MUST: After editing a local skill, re-add it with `npx skills add ./packages/skills/NAME --skill NAME --agent claude-code codex opencode --yes`, then commit the source, installed `.agents/skills/NAME` copy, `skills-lock.json`, and relative `.claude/skills/NAME` link. Project skill drift detection is managed centrally.
