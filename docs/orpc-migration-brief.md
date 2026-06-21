# oRPC migration — scope brief

**Status:** Scoped, **queued** — run as the SOLE active slice once the in-flight work (square backfill, open PRs) lands. It cuts across `packages/contracts`, `apps/web` routing + many route handlers, the OpenAPI / Scalar / Postman surfaces, and (optionally) the CLI / MCP naming — so parallel work would conflict. Run it alone, nothing racing it.

**Decision basis:** the design + go/no-go live in [docs/rfcs/openapi-generation.md](./rfcs/openapi-generation.md) (chose oRPC over the Zod-registry option); the integration was proven on workerd by the **spike, PR #58**; the cross-surface names come from the ratified Convention B in [docs/naming-conventions.md](./naming-conventions.md). This brief is the execution plan, refined at kickoff — treat it as planning, not spec (canon + the codebase win on any conflict).

## Goal

Make the HTTP API **contract-first**: one oRPC contract per operation in a shared package, the API _implements_ it, clients `import type { Router }`, and the **OpenAPI spec is generated from the contracts** — no hand-maintained spec, no drift. The contract registry is where Convention B's `verb_noun` names live and get enforced: a route with no contract becomes a build/coverage failure instead of a code-review hope.

**Admin is in scope.** This brief now brings the admin surface (`/api/admin/*`) into the migration; only the named carve-outs below stay on TanStack. This supersedes the earlier "admin stays on TanStack by design" framing. Why: admin auth today is per-handler boilerplate — `requireAdmin` / `requireOperator` sit atop ~30 handlers, and the operator/agent field-level checks are inlined per handler (e.g. the track-update "agent role may write only analysis fields" guard, the social-draft route's youtube-is-operator-only branch). oRPC middleware collapses that to one typed-`context` auth tier and extends the migration's "no contract ⇒ build failure" coverage to admin — otherwise admin is the one part of the surface the new enforcement wouldn't reach, and it is exactly the part the queued [Hermes-automation work](./hermes-automation-brief.md) is about to add commands to.

## Proven foundation (spike, PR #58)

- oRPC runs clean on workerd. `handleOrpc(request)` returns the response on match or **`null` on `matched:false`**, falling through to the existing TanStack Start handler — the native, route-by-route incremental path, in one Worker, indefinitely.
- Contract in `packages/contracts` on a new `./orpc` subpath (keeps the pure-types `index.ts` that the CLI/Raycast consume free of zod/@orpc at runtime); served via `@orpc/openapi/fetch`'s `OpenAPIHandler`; OpenAPI 3.1 generated via `OpenAPIGenerator` + `@orpc/zod`.
- Cost: ~33 KB gzipped added to the Worker; `zod` becomes a new `apps/web` dependency.

## The admin auth middleware (the shared spine — design up front)

The admin wave's value is getting the auth tier right **once**, so design it as a first-class item before converting any admin route. It is a direct port of the existing role model in `apps/web/src/lib/server/env.ts` — no new auth semantics, just relocated into oRPC middleware:

- **`adminAuth` middleware** resolves the principal once via the existing `adminRole(request)` (bearer `FLUNCLE_API_TOKEN` _or_ the signed admin grant cookie ⇒ `operator`; bearer `FLUNCLE_AGENT_TOKEN` ⇒ `agent`; else `null`) and injects a typed `context.role: "operator" | "agent"` for the handler to read.
- **`adminProcedure = base.use(adminAuth)`** → 401 when the principal is `null`. Any admin principal (operator _or_ agent) passes. This is the oRPC equivalent of `requireAdmin`.
- **`operatorProcedure = adminProcedure`** plus an operator-only guard → 403 for the `agent` role (it authenticated fine, it just lacks the role), 401 for a non-admin. The oRPC equivalent of `requireOperator`.
- **Field-level role checks read `context.role` in-handler**, porting the current inline checks verbatim — e.g. the track-update guard that lets the `agent` role write only analysis fields (rejecting an operator-only field with a 403, not silently dropping it), and the social-draft route's branch where `tiktok` is agent-allowed but `youtube` requires the operator role.

These three (`adminAuth`, `adminProcedure`, `operatorProcedure`) are the spine the whole admin wave builds on; land them before the first admin conversion.

## The plan (route by route)

1. **Land the rails.** Add `@orpc/*` + `zod` (align versions to the workspace catalog — the spike used `@orpc` 1.14.6 / `zod` 4.4.3), the `./orpc` contract subpath in `packages/contracts`, and mount `handleOrpc` in `apps/web/src/server.ts` ahead of the existing handler (matched:false fall-through). Dual-mount under `/api/v1` and `/api` to preserve the permanent alias.
2. **Encode Convention B.** Each operation's canonical `verb_noun` → a contract op; `operationId` = the camelCase projection. Encode the **admin** op-names in the same registry alongside the public ones — admin names follow Convention B's `group noun-verb` shape (plural groups, e.g. `tracks track-update`, `backfills backfill-discogs`). Add a coverage test that fails if a route lacks a contract/operationId (public _and_ admin — see Definition of done).
3. **Convert a public read first as the proof**, one at a time — tracks list/get, search, the feed-adjacent reads. Lift each handler's logic into an oRPC `.handler`, I/O as Zod schemas (derive from the existing `packages/contracts` DTO types where possible). Each converted route is owned by oRPC; everything else keeps falling through to TanStack. **But design the `adminAuth` / `adminProcedure` / `operatorProcedure` spine up front (above) so it is ready before the admin wave** — don't bolt auth on later.
4. **Flip the spec to generated.** Point `/api/v1/openapi.json` at `generateOpenApiDocument()`, delete the hand-maintained `apps/web/public/openapi.json`, and retarget the Postman route (PR #52) from the static file to the generated module (one line). Scalar (`/docs/api`) + Postman consume the generated spec unchanged.
5. **Convert admin as a second wave, inside the same slice.** With the auth spine landed, port the admin handlers to `adminProcedure` / `operatorProcedure` contracts — reads and enrich-sweep on `adminProcedure`; publish-/irreversible-class routes on `operatorProcedure`; field-level role checks read `context.role` in-handler. Only the named carve-outs (below) stay on TanStack. No big-bang — admin routes still fall through to TanStack until each is converted.
6. **(Optional, follow-up) Unify CLI / MCP off the registry.** Derive CLI command names + MCP tool names from the same `verb_noun` registry so one operation reads identically on every surface — Convention B's full payoff. Decide at kickoff whether this rides in the slice or trails it.

## Carve-outs (stay on TanStack)

- **OAuth callbacks** — the Spotify / YouTube / Mixcloud / Last.fm `auth/*` routes return browser redirects, not RPC responses. Permanent carve-out.
- **`preview-archive`** — the one admin route that takes a multipart file body (`request.formData()`) through the Worker. Verify oRPC's file-input ergonomics on workerd at kickoff; if they don't land cleanly, leave it on TanStack (it is a single irregular route, not the model for the wave).

**Not a carve-out — the video upload path converts.** `…/video/uploads` (presign) and `…/video/finalize` are **JSON control-plane calls** — the bytes go direct to R2 via the presigned URL the Worker signs, so the request/response bodies oRPC sees are plain JSON. They fit oRPC cleanly and are in scope.

## Scope / cost note

Bringing admin in roughly **doubles the route count** and lengthens the sole-active-slice window — a deliberate trade for a uniform end state with enforcement everywhere (no admin-shaped gap in the "no contract ⇒ build failure" net). It remains the **sole active slice**; nothing races it.

## Definition of done

API operations — **public and admin** — are oRPC contracts on the right auth tier (`adminProcedure` / `operatorProcedure`), with field-level role checks reading `context.role`; the OpenAPI spec is generated (no `public/openapi.json`); Scalar + Postman + a typed `Router` client all derive from it; the coverage test fails on **any** route without a contract/auth tier — admin _and_ public, not just public. Only the named carve-outs (OAuth callbacks; `preview-archive` if file-input doesn't land) remain on TanStack intentionally.

## Open decisions (settle at kickoff)

- **zod 3 vs 4** — the spike used 4; check the repo's existing zod usage and the catalog before pinning.
- **`@orpc` version** — pin to the catalog/range style.
- **Collapse `packages/contracts` pure types into `z.infer`** of the schemas (removes a duplicate definition), or keep the type layer separate.
- **The pilot route** — the first conversion (likely `GET /tracks` or `GET /tracks/{idOrLogId}`).
- **oRPC file-input on workerd for `preview-archive`** — convert it (if oRPC's multipart file-body ergonomics land cleanly on workerd) or carve it out. Verify at kickoff.
- **CLI/MCP unification (step 6)** — in-slice or follow-up.
