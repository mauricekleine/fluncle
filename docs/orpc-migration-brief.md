# oRPC migration — scope brief

**Status:** Scoped, **queued** — run as the SOLE active slice once the in-flight work (square backfill, open PRs) lands. It cuts across `packages/contracts`, `apps/web` routing + many route handlers, the OpenAPI / Scalar / Postman surfaces, and (optionally) the CLI / MCP naming — so parallel work would conflict. Run it alone, nothing racing it.

**Decision basis:** the design + go/no-go live in [docs/rfcs/openapi-generation.md](./rfcs/openapi-generation.md) (chose oRPC over the Zod-registry option); the integration was proven on workerd by the **spike, PR #58**; the cross-surface names come from the ratified Convention B in [docs/naming-conventions.md](./naming-conventions.md). This brief is the execution plan, refined at kickoff — treat it as planning, not spec (canon + the codebase win on any conflict).

## Goal

Make the public HTTP API **contract-first**: one oRPC contract per operation in a shared package, the API _implements_ it, clients `import type { Router }`, and the **OpenAPI spec is generated from the contracts** — no hand-maintained spec, no drift. The contract registry is where Convention B's `verb_noun` names live and get enforced: a public route with no contract becomes a build/coverage failure instead of a code-review hope.

## Proven foundation (spike, PR #58)

- oRPC runs clean on workerd. `handleOrpc(request)` returns the response on match or **`null` on `matched:false`**, falling through to the existing TanStack Start handler — the native, route-by-route incremental path, in one Worker, indefinitely.
- Contract in `packages/contracts` on a new `./orpc` subpath (keeps the pure-types `index.ts` that the CLI/Raycast consume free of zod/@orpc at runtime); served via `@orpc/openapi/fetch`'s `OpenAPIHandler`; OpenAPI 3.1 generated via `OpenAPIGenerator` + `@orpc/zod`.
- Cost: ~33 KB gzipped added to the Worker; `zod` becomes a new `apps/web` dependency.

## The plan (route by route)

1. **Land the rails.** Add `@orpc/*` + `zod` (align versions to the workspace catalog — the spike used `@orpc` 1.14.6 / `zod` 4.4.3), the `./orpc` contract subpath in `packages/contracts`, and mount `handleOrpc` in `apps/web/src/server.ts` ahead of the existing handler (matched:false fall-through). Dual-mount under `/api/v1` and `/api` to preserve the permanent alias.
2. **Encode Convention B.** Each operation's canonical `verb_noun` → a contract op; `operationId` = the camelCase projection. Add a coverage test that fails if a public route lacks a contract/operationId.
3. **Convert the public reads first**, one at a time — tracks list/get, search, the feed-adjacent reads. Lift each handler's logic into an oRPC `.handler`, I/O as Zod schemas (derive from the existing `packages/contracts` DTO types where possible). Each converted route is owned by oRPC; everything else keeps falling through to TanStack.
4. **Flip the spec to generated.** Point `/api/v1/openapi.json` at `generateOpenApiDocument()`, delete the hand-maintained `apps/web/public/openapi.json`, and retarget the Postman route (PR #52) from the static file to the generated module (one line). Scalar (`/docs/api`) + Postman consume the generated spec unchanged.
5. **Leave the rest on TanStack by design.** Admin, OAuth-callback, and other non-public / irregular routes stay as-is — oRPC owns only what has a contract. No big-bang.
6. **(Optional, follow-up) Unify CLI / MCP off the registry.** Derive CLI command names + MCP tool names from the same `verb_noun` registry so one operation reads identically on every surface — Convention B's full payoff. Decide at kickoff whether this rides in the slice or trails it.

## Definition of done

Public API operations are oRPC contracts; the OpenAPI spec is generated (no `public/openapi.json`); Scalar + Postman + a typed `Router` client all derive from it; a coverage test fails on any public route without a contract. Admin/OAuth remain on TanStack intentionally.

## Open decisions (settle at kickoff)

- **zod 3 vs 4** — the spike used 4; check the repo's existing zod usage and the catalog before pinning.
- **`@orpc` version** — pin to the catalog/range style.
- **Collapse `packages/contracts` pure types into `z.infer`** of the schemas (removes a duplicate definition), or keep the type layer separate.
- **The pilot route** — the first conversion (likely `GET /tracks` or `GET /tracks/{idOrLogId}`).
- **CLI/MCP unification (step 6)** — in-slice or follow-up.
