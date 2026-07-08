# Tonight's domain: Architecture & code-quality integrity

Fluncle moves fast because its invariants hold: one contract-first HTTP surface, clean server-module
boundaries, one name per operation, and a small set of lint rails the whole team leans on. This
domain audits that those invariants are still intact — a drifted boundary or a smuggled-in pattern is
a tax every future change pays. Keep the checks green, keep the structure legible, and velocity holds;
this is a code-health hunt, not a feature hunt.

## The hunt

**1. The oRPC-default invariant (highest value — this is the load-bearing contract).** Every public
and admin HTTP surface is served by an oRPC contract op (`packages/contracts/src/orpc/*.ts`, one file
per domain, aggregated in `index.ts`; the router mirrors it under `apps/web/src/lib/server/orpc/*.ts`).
The only sanctioned file-route carve-outs under `apps/web/src/routes/api/**` are: auth/OAuth
redirects, large-body/streaming/direct-upload routes, non-JSON emitters (feeds, sitemap, robots,
`llms.txt`, `.well-known`, OG/cover images, the OpenAPI+Postman specs), and the `/status`+`/health`
resource-reads. The coverage tests are the enforcement and **must stay green**:
`orpc-coverage.test.ts` (public), `orpc-admin-coverage.test.ts` (admin), `orpc-auth-coverage.test.ts`
(auth tiers). Hunt for a new route with no contract, a `PENDING` allow-list entry that should have
shrunk, a contract whose input/output Zod schema drifted from what the handler actually reads/returns,
or a carve-out that isn't one of the sanctioned classes. A contract fix is often a safe direct fix; an
auth-tier change is a hard rail — file it.

**2. Server module boundaries under `lib/server`.** `apps/web` is the sole owner of API behavior; the
CLI, Raycast, SSH, and mobile are thin clients that call it, never reimplement it. Within
`apps/web/src/lib/server/`, keep the existing per-domain module split intact (e.g. `spotify.ts`,
`telegram.ts`, `mixtapes.ts`, `observation.ts`) — watch for a route handler growing business logic that
belongs in a server module, a domain module reaching into another's internals, or client-side code
(CLI/Raycast) that has started to duplicate server logic.

**3. Cross-surface `verb_noun` naming (Convention B).** `docs/naming-conventions.md` is ratified law:
one canonical `verb_noun` op, each surface's name derived by a fixed rule (MCP snake_case verbatim,
`operationId` camelCase, REST path plural resources + single-word action segments, plural admin CLI
groups). `orpc-naming.test.ts` guards the contract side. Hunt for an invented name, a route with no
`operationId`, MCP server↔browser drift (`mcp.ts` vs `webmcp.ts` must be identical), a dash-compound
command/path segment, or a voice noun (`finding`, `banger`) leaked into a machine identifier.

**4. No TypeScript non-null `!`.** `typescript/no-non-null-assertion` is an oxlint **error**
(`.oxlintrc.json`). Any `!` assertion is a finding — replace it with a guard, early return, `??`, or
`?.`. This is a safe, mechanical direct fix. Never introduce one yourself.

**5. Dead code, duplication, unused exports.** Exported symbols nobody imports, orphaned modules,
copy-pasted logic that should be one helper, commented-out blocks. Prefer deleting over keeping.
Confirm a symbol is truly unused across `apps/`, `packages/`, and tests before removing it.

**6. TanStack route option-ordering.** `createFileRoute(...)({...})` / `createRootRoute({...})`
options MUST follow the canonical sequence (params → validateSearch → loaderDeps → context →
beforeLoad → loader → head → scripts) because each step feeds the next's type inference. Where that
order breaks alphabetical keys, a `// oxlint-disable-next-line sort-keys` sits directly above the
definition. Hunt for a route out of canonical order, or a missing/misplaced disable comment.

**7. Complexity & TODO/FIXME rot.** Oversized functions, deeply nested branching that a guard clause
would flatten, and stale `TODO`/`FIXME`/`HACK` markers. Resolve the trivially-fixable; file the ones
that need a judgment call or carry real scope.

**8. Migrations only via `db:generate`.** SQL migrations under `apps/web/drizzle/` are generated from
`apps/web/src/db/schema.ts` via `bun run --cwd apps/web db:generate` — **never** hand-written, and a
hard rail (never edit them). If a schema change landed without its generated migration (or vice
versa), that's a finding to **file**, not fix — regenerating touches the migration dir.

**9. Dependency & abstraction hygiene.** Search the codebase before a new pattern, helper, dependency,
or abstraction earns its place — a second helper that does what an existing one already does is the
rot to catch. Flag a new dependency where a repo package or platform API would do, a lockfile change
detached from its dependency change, or a version range that breaks the workspace catalog style.

## Where to look first

`packages/contracts/src/orpc/index.ts` · `apps/web/src/lib/server/orpc/` ·
`apps/web/src/lib/server/orpc-coverage.test.ts` · `apps/web/src/lib/server/orpc-admin-coverage.test.ts`
· `apps/web/src/lib/server/orpc-naming.test.ts` · `apps/web/src/routes/api/` (the carve-outs) ·
`apps/web/src/lib/server/` (the module boundaries) · `docs/naming-conventions.md` ·
`apps/web/src/lib/server/mcp.ts` + `apps/web/src/lib/webmcp.ts` · `.oxlintrc.json` ·
`apps/web/src/db/schema.ts` · `.claude/agents/contract-coverage-reviewer.md` +
`.claude/agents/naming-convention-linter.md` (the standing reviewers whose checks you are pre-running).
