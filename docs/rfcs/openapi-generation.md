# RFC: Generate the OpenAPI spec from a contract registry — one source, every name, no drift

**Status:** Final (research → /taste → adversarial review synthesized, 2026-06-21) — completeness standard applied.
**For:** a fresh build session (or a small team of agents) standing up the contract registry + the generated spec, once the owner decisions below are resolved. This is research + design, **not** the migration itself.
**Canon/authority:** the codebase arbitrates — `apps/web/src/routes/api/v1/**` (the live handlers), `apps/web/public/openapi.json` (the hand-maintained spec), `packages/contracts/src/index.ts` (the typed DTOs), and `apps/web/src/routes/api/-alias.ts` (the `/api/v1` ↔ `/api` dual-mount). `AGENTS.md` arbitrates process. `docs/naming-conventions.md` (PR #50, proposal) is the naming half of this story; this RFC is the _enforcement mechanism_ for it. This is planning under `docs/`, not spec.

> Process note: research across four threads (the current spec/handler/validation reality; the generator-library landscape pulled from current Context7 docs for oRPC, `@asteasolutions/zod-to-openapi`, `@hono/zod-openapi`, and `@samchungy/zod-openapi`; the workerd + TanStack-Start runtime constraints; and the naming-registry tie-in to PR #50), a /taste pass, and an adversarial review (staff engineer, API-platform specialist, product-scope). Their corrections are baked in — including the single most load-bearing finding: **the hand-maintained spec has already drifted from the DTOs it claims to describe** (the spec's `Track` schema carries 10 properties; the `TrackListItem` contract carries ~40). Live verifications and sources are in the appendix.

---

## The standard (definition of done)

This RFC describes a complete delivery, not a menu. When the chosen unit is built:

- **The spec is _generated_, never hand-edited.** `apps/web/public/openapi.json` stops being a source file. The OpenAPI document is produced from typed route definitions, and `GET /api/v1/openapi.json` serves the generated document. A reviewer who edits the JSON by hand is doing it wrong — the build (or the route) regenerates it.
- **The payoff loop is closed end to end.** Generated spec → `/api/v1/openapi.json` → the `/docs/api` Scalar reference _and_ the Postman route (#52) all derive from the one generated artifact, so the three machine surfaces can never drift from the API or from each other. This is the same sync guarantee #52 already gives Postman, lifted up one level so the _spec itself_ can't drift from the _handlers_.
- **Validation and the spec come from one definition.** The schema that validates an inbound request body or query _is_ the schema in the spec. We do not keep a hand-rolled validator and a hand-written schema that can disagree (today they can, and do).
- **Tests + docs are part of done.** A test asserts the generated document is well-formed OpenAPI 3.1, covers every migrated operation, and round-trips through the existing `openapi-to-postman` converter (#52). A short `docs/api-contracts.md` (or a section in an existing doc) records the registry-is-the-source rule and the "how to add a route" recipe. Per `AGENTS.md`, behavior-changing routes ship with focused tests in the existing `apps/web` route-test shape (`*.test.ts` beside the route).
- **The `/api/v1` ↔ `/api` permanent alias survives.** Whatever carries the new routes must still serve them at both `/api/v1/*` (canonical) and `/api/*` (permanent back-compat alias), as `-alias.ts` does today — not a redirect (POST bodies must survive).
- **Migration is incremental and reversible.** Old hand-written TanStack routes and new generated routes coexist for the whole transition. There is a named **first route to convert** (a pilot) and a rule for how an un-migrated route keeps working untouched. No big-bang rewrite is required to ship value.
- **The only sanctioned "not now"** is genuine dependency chaining: the _naming registry_ (PR #50, Convention B) should be **ratified before** the spec generator hard-codes `operationId`s, because the generator is exactly where that convention gets _enforced_ — but the generator can ship against today's names and adopt the registry's names as #50 lands, route by route. That is sequencing, not deferral.

A note on altitude, because it shapes the whole RFC: the public API is **small** — ~15 documented public operations, plus a much larger _undocumented_ admin surface (~30 routes the hand-spec never described). The win is not "adopt a big framework." The win is **delete a hand-maintained artifact that has already drifted, and make three downstream surfaces (spec, Scalar, Postman) plus request-validation fall out of one typed definition.** Size the effort to that.

---

## 0. Summary / the reframe

**The unifying simplification: the spec is an _output_, not a _source_. Today it is a source file that nothing checks against the code — so it drifts, silently. Make it a build artifact derived from typed route definitions, and the drift class disappears by construction.**

- **The spec has already drifted — this is not hypothetical.** The hand-maintained `public/openapi.json` describes a `Track` schema with **10 properties** (`trackId`, `spotifyUrl`, `title`, `artists`, `album`, `albumImageUrl`, `note`, `addedAt`, `addedToSpotify`, `postedToTelegram`). The actual emitted DTO — `TrackListItem` in `packages/contracts` — has **~40** (`bpm`, `key`, `galaxy`, `vibeX/Y`, `observationAudioUrl`, `videoUrl`, `logId`, `enrichmentStatus`, `discogsReleaseUrl`, …). An agent reading the spec to consume the API gets a _wrong, truncated_ picture of every track. The spec is supposed to be the contract; it is a stale subset. (Verified — Appendix.)
- **Drift is structural, not a discipline failure.** There is no build step, no test, and no type relationship binding `public/openapi.json` to the handlers or to `packages/contracts`. The spec is JSON that a human edits by hand and hopes stays in sync. PR #52 (Postman) and the `/docs/api` Scalar reference both _import that one file_, so they faithfully reproduce whatever drift it carries. The single static file is the single point of drift; everything downstream inherits it.
- **PR #50's naming convention has nowhere to live until this exists.** #50 proposes one canonical `verb_noun` op per operation, with each surface's name _derived by rule_ (operationId = `verbNoun`, MCP tool = `verb_noun`, …). A _registry_ is the natural home for that — and a registry that _also generates the spec_ is where the rule stops being a doc and becomes **enforced**: an operation that isn't in the registry has no `operationId`, no spec entry, and (if it carries the handler) no route. #50's own checklist says "a route with no `operationId` is a bug" — generation makes that a _compile/build_ fact, not a code-review hope.
- **The runtime is the real constraint, and it's friendlier than it looks.** The app is TanStack Start file-based routes on Cloudflare Workers (workerd), `nodejs_compat` **on** (verified `wrangler.jsonc`). That rules out anything assuming a Node server or filesystem at runtime, but it does **not** rule out the candidates: spec _generation_ is pure data-structure work (runs at build time, or once per cold start), and the leading request-time options (oRPC's `OpenAPIHandler`, Hono) are Web-Standard `fetch` handlers that run on workerd natively.
- **There is a low-risk option that touches almost no code.** Generate the spec from Zod schemas via `@asteasolutions/zod-to-openapi` (or `@samchungy/zod-openapi`) while **keeping every existing TanStack handler exactly as is.** The route files keep handling requests; a new `openapi.ts` _builds_ the document from a registry of Zod schemas + path metadata. This kills the drift on the _spec/Scalar/Postman_ side and gives us reusable validators, without re-architecting the API. It's the recommended starting point.
- **There is a higher-ceiling option that also kills hand-written validation and unifies the clients.** Adopt **oRPC**: define each operation once as a contract (`.route({method, path}).input(zod).output(zod)`), implement it, and mount an `OpenAPIHandler` that _serves the routes and generates the spec from the same definitions_. This is the contract-first model Maurice already likes — the spec is generated "on the fly," validation is automatic, and a typed client + the MCP tool shapes can derive from the same contracts. The cost is real (a new framework mounted beside TanStack's router, a route-by-route rewrite of handlers), so it's the _destination_, not the _first step_.
- **Decomposition (truly-coupled vs falsely-coupled):**
  - **Unit A — the generated spec (the drift fix).** Replace the static `public/openapi.json` with a generated document built from a typed schema registry; point `/api/v1/openapi.json` at it; keep Scalar + Postman importing the _generated_ output. **Ships standalone, kills the drift class, touches no handler.** This is the headline and the recommended v1.
  - **Unit B — shared validation off the same schemas.** The registry's Zod schemas become the request validators the handlers call (replacing the per-route hand-rolled `parseLimit`/`parseTimestamp`/`as SubmissionInput` narrowing). Independent of A's _delivery_ but _uses_ A's schemas — natural fast-follow.
  - **Unit C — the registry as the naming-convention enforcer (the #50 tie-in).** The registry is the single `verb_noun` op list from which `operationId`s (and, optionally, MCP tool names + CLI aliases) derive. Depends on #50 being ratified for the _names_; the _mechanism_ is built in A.
  - **Unit D — full contract-first (oRPC).** Routes move onto oRPC contracts; the spec, validation, and clients all generate from them. The destination. **Depends on nothing in A/B/C technically** (it subsumes them), but is far larger; do it _only_ if the ceiling is wanted, and even then incrementally.
  - **Falsely-coupled — "we must pick a framework to fix the drift."** We don't. Unit A fixes the drift with zero framework. oRPC (Unit D) is a _separate, optional_ ambition.

---

## 1. Context & goals

**Why now.** Two PRs just made the drift expensive. #52 (Postman) and the existing Scalar reference both derive from `public/openapi.json`, so that one stale file now feeds _three_ machine surfaces. And #50 (naming conventions) proposes a one-name-per-operation registry that has no enforcement home. Both pressures point at the same fix: make the spec a generated artifact off a typed registry. The cost of _not_ doing it is a public contract that lies about every track (the `Track`-schema drift) and a naming convention that stays a PDF.

**Goals, honestly calibrated:**

- **In reach, fully (Unit A):** delete the hand-maintained `public/openapi.json` as a _source_; generate the OpenAPI 3.1 document from typed schemas; serve it at `/api/v1/openapi.json`; Scalar + Postman consume the generated output. The drift class is gone. Buildable now with current libraries on workerd.
- **In reach, fast-follow (Unit B):** the same schemas validate inbound requests, replacing scattered hand validation. Fewer bugs, less code, and the validator can't disagree with the spec.
- **In reach, gated on #50 (Unit C):** the registry enforces Convention B's naming — `operationId`s (and optionally MCP/CLI names) derive from one `verb_noun` list. Generation makes "no operationId" a build failure.
- **In reach, larger (Unit D, optional):** oRPC contract-first — spec, validation, and a typed client all generate from one contract per route. The destination if Maurice wants the ceiling; not required to capture the headline value.
- **What it is NOT:** not a rewrite of the app's data layer, the Turso schema, or the public DTO _shapes_ (those stay; the contract just _describes_ them honestly). Not a change to the `/api/v1` ↔ `/api` alias contract. Not a forced migration of all ~30 admin routes at once — most aren't even in the public spec today, and several never should be (auth-callback routes, OAuth flows). Not a new public surface.

**The honest worth-it read (baked in up front):** the highest-leverage move is **Unit A alone** — it's a few hundred lines of schema-registry code that _deletes_ a drift-prone file and makes three surfaces self-syncing, with **zero handler churn**. Unit B is a clear, incremental win that pays down real hand-validation debt. Unit C is "free" once A exists, _gated only on #50 ratification_. Unit D (oRPC) is a genuine architectural choice with a real ceiling (validation + typed clients + MCP all off one contract) but a real cost (a second router framework, a route-by-route rewrite) — it's a _destination Maurice opts into_, not a prerequisite for the win. We recommend shipping A (and B close behind), wiring C to #50, and treating D as an explicit, separately-owned decision.

---

## 2. Current state — how the API, spec, and validation work today

### 2.1 The API: file-based TanStack Start routes, dual-mounted

Every API route is a file under `apps/web/src/routes/api/**`. The canonical path is `/api/v1/*`; the bare `/api/*` path is a **permanent back-compat alias** — the _same_ handler object mounted at both paths (not a redirect, so POST bodies survive). The mechanism is `apps/web/src/routes/api/-alias.ts`: each `/api/*` route file exports a typed `serverHandlers: ApiHandlers`, and the `/api/v1/*` mirror re-mounts the very same object via `aliasHandlers()` (a documented path-phantom-erasing cast). Verified: 62 route files under `api/v1`, mirrored from `api/*`.

Handlers are plain `(context: { request, params }) => Response` functions. They read `request`/`params`, do work, and return `Response.json(...)`. There is no shared input-validation layer and no schema attached to a route.

### 2.2 The spec: one hand-maintained static file, imported in three places

`apps/web/public/openapi.json` is a **hand-written** OpenAPI 3.1 document (716 lines, 13 paths, 15 operations, 8 component schemas). No codegen, no build step, no test binds it to the code. It is served three ways, all importing that one file so the _copies_ never drift from _each other_:

1. **`GET /api/v1/openapi.json`** (`routes/api/v1/openapi[.]json.ts`) — `import openapi from ".../public/openapi.json"` and returns it as `application/openapi+json`.
2. **`/docs/api`** (`routes/docs.api.tsx`) — the embedded Scalar reference, `url: "/api/v1/openapi.json"`.
3. **`GET /api/v1/postman.json`** (PR #52, open) — imports the same file and converts it to a Postman v2.1 collection at request time.

So all three are _consistent with the file_ — and all three inherit whatever the file gets wrong. **The file is the single point of drift.** Nothing checks it against the handlers or against `packages/contracts`.

### 2.3 Validation: hand-rolled, per-route, untyped at the boundary

Each route narrows untrusted input itself. `routes/api/tracks.ts` hand-writes `parseLimit` (clamp 1–48, fall back to default) and `parseTimestamp` (ISO-or-ignore). `routes/api/submissions.ts` does `(await request.json()) as SubmissionInput` — a _cast_, not a validation — then trusts `createSubmission` to narrow. `lib/server/http-errors.ts` provides `parseJsonBody` (malformed-JSON → 400) and `parseEditorialNote` (length gate → 422), but these are ad-hoc helpers, not a schema layer. There is **no** runtime schema that both validates _and_ documents an endpoint. The spec's parameter constraints (`minimum: 1, maximum: 48`) are typed _by hand in the JSON_ and _separately_ enforced by hand in `parseLimit` — two truths that can disagree.

### 2.4 `packages/contracts`: typed DTOs, no runtime, already the near-source-of-truth

`packages/contracts/src/index.ts` is a **pure-types** package (no runtime values): the response envelopes (`Ok<T>`, `ApiFailure`), the DTOs (`TrackListItem`, `MixtapeDTO`, `Submission`, …), and the request bodies (`AddTrackRequest`, `SubmissionRequest`, …). Web routes import these to type `Response.json<…>()` (48 route files reference the contracts or `ApiHandlers`); the CLI imports them for `publicApiGet<T>`/`adminApiPost<T>`; Raycast parses CLI stdout against them. Its own header comment states the intent: _"this package is the single place the public DTOs + response envelopes are defined, so the CLI/Raycast mirrors can't drift."_ It is the spiritual source of truth for _shapes_ — but it's **types only**, so it can't _generate_ a spec (no runtime schema to introspect) and it doesn't _validate_ anything. **This is the foundation the registry builds on:** the registry is `packages/contracts` with _runtime_ schemas (Zod) instead of (or alongside) the pure types.

### 2.5 Where drift bites (the #50 audit, grounded here)

PR #50's audit found, and this RFC verifies, the concrete failures generation would close:

- **The `Track` schema is a stale subset** (10 of ~40 fields). The spec under-describes the real payload — the most damaging drift, because it's silent and the consumer is _misled_, not _errored_.
- **Coverage gaps — live routes with no `operationId`.** `GET /tracks/{idOrLogId}`, `DELETE /me/saved-findings/{trackId}`, `PATCH /me/profile`, `/mixtapes`, `/stories` are live but absent from the spec — invisible to an agent reading it (#50 §2.8). The entire `/admin/**` surface (~30 routes) is undocumented.
- **operationId ≠ path noun, undocumented.** `POST /submissions` → `submitTrack`; `GET /me/csrf` → `getPrivateMutationToken` (#50 §2.5). Sometimes intentional (the _action_ noun ≠ the _resource_ noun), but there's no rule and no registry recording which mismatches are deliberate.
- **No one-name-per-operation rule.** "List recent" is `recent` (CLI) / `latest` (SSH) / `listTracks` (operationId) / `get_recent_tracks` (MCP), with nothing mapping them (#50 §2.1). The spec's `operationId` is one of four hand-chosen names with no derivation.

Generation fixes the first three _mechanically_ (the schema is the emitted shape; every generated op has an id; the registry records intentional mismatches). The fourth is #50's job — but the registry is _where #50 gets enforced_ (Unit C).

---

## 3. Options — contract-first generators against Fluncle's real constraints

The constraints every option is judged against: **(1)** runs on workerd (`nodejs_compat` on, no Node http server, no runtime FS); **(2)** coexists with — or cleanly replaces — TanStack Start's file-based routing; **(3)** reuses/extends `packages/contracts`; **(4)** preserves the `/api/v1` ↔ `/api` permanent alias; **(5)** supports incremental, route-by-route migration (no big-bang).

### 3.1 Option 1 — Zod schema registry → generated doc (`@asteasolutions/zod-to-openapi` or `@samchungy/zod-openapi`). **Recommended for v1.**

**What it is.** A library that turns Zod schemas + path metadata into an OpenAPI document. You register schemas (`registry.register("Track", TrackSchema)` → `$ref: #/components/schemas/Track`) and paths (`registry.registerPath({ method, path, operationId, request, responses })`), then `new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: "3.1.0", info, servers })` returns a plain JS object — the OpenAPI doc. (`@samchungy/zod-openapi` is the same idea with Zod-4-native `.meta()` metadata and 3.1 output; either works — see Decisions.)

**What it'd take.**

- Add `zod` + the generator to `apps/web` (workerd-safe: pure JS, no Node built-ins at runtime; generation can even run at _build_ time and be emitted to `public/`, or once per cold start in the route).
- Build a `lib/server/openapi/registry.ts`: port the `packages/contracts` types into Zod schemas (`TrackSchema`, `TrackListPageSchema`, `SubmissionSchema`, …) and register one `registerPath` per public operation, carrying the `operationId`, params, and response `$ref`s.
- Rewrite `routes/api/v1/openapi[.]json.ts` to serve `generateDocument(...)` instead of importing the static file. **Delete `public/openapi.json`.**
- Scalar (`/docs/api`) and Postman (#52) need **no change** — they already read `/api/v1/openapi.json`, which now serves the generated doc.

**What it buys.** Kills the drift class on the spec/Scalar/Postman side with **zero handler churn**. The schemas become reusable runtime validators (Unit B falls out: `TrackSchema.parse(...)` in a handler). The registry is the natural home for #50's `operationId`s (Unit C). Generation is the whole win; nothing about request handling changes.

**What it costs.** You _hand-author the path metadata_ (method/path/params/responses) once per operation — it's not auto-derived from the file-based routes (the library doesn't know your routes exist). So the registry is a _parallel_ description of the routes that you keep in sync with the handlers _manually_ — **the drift moves from "spec vs DTO" to "registry vs handler."** Mitigation: (a) the registry's response schemas are the _same_ Zod schemas the handlers validate against (Unit B), so the _shape_ drift is gone even if a path is forgotten; (b) a test enumerates the live `api/v1` route files and asserts each has a registry entry (closes the _coverage_ gap mechanically). This is materially less drift than today (today _nothing_ binds spec to code), but it's not _zero_ — only Option 3 makes the route _be_ the spec.

**Constraints check.** (1) workerd: ✅ pure JS. (2) coexists with TanStack: ✅ — it doesn't touch routing at all. (3) reuses contracts: ✅ — it's the Zod-runtime version of `packages/contracts` (and the pure types can be _derived_ from the Zod schemas via `z.infer`, collapsing two definitions into one — see Decisions). (4) alias: ✅ untouched. (5) incremental: ✅ — register operations one at a time; an unregistered route just isn't in the spec yet (same as today).

### 3.2 Option 2 — Hono + `@hono/zod-openapi`. Honest evaluation: **not the fit.**

**What it is.** Hono is a Web-Standard `fetch` framework that runs natively on workerd; `@hono/zod-openapi`'s `OpenAPIHono` + `createRoute` define routes whose Zod schemas _both_ validate requests _and_ generate `/doc`. Route _is_ the spec, like oRPC.

**Why it's not the fit here.** It's a _router_, and Fluncle already has one (TanStack Start). Adopting Hono means either (a) mounting a Hono app _inside_ a TanStack catch-all route to own `/api/*` (a router-in-a-router, with the `/api/v1` ↔ `/api` alias re-implemented inside Hono), or (b) migrating the app's routing off TanStack — a much bigger move than the problem warrants. Hono is an excellent choice _if you're starting an API_ or already Hono-based; here it's a second framework to fix a spec-generation problem that Option 1 solves with no framework, and whose contract-first ceiling Option 3 (oRPC) reaches with a model Maurice already knows. **Acknowledged as strong tech, declined on fit.** (If the app were _not_ on TanStack Start, this would rank above oRPC for simplicity.)

### 3.3 Option 3 — oRPC contract-first (`@orpc/contract` + `@orpc/server` + `@orpc/openapi`). The destination; **Maurice's leading candidate, evaluated honestly.**

**What it is.** Define each operation as a contract: `oc.route({ method: 'GET', path: '/tracks' }).input(QuerySchema).output(TrackListPageSchema)`. Implement it (`implement(contract).handler(...)`). Generate the spec from the _router_ with `OpenAPIGenerator` + `ZodToJsonSchemaConverter` — **the spec is generated from the exact same contracts that serve the requests.** Serve the routes with `OpenAPIHandler` from `@orpc/openapi/fetch`, a Web-Standard `fetch` handler that runs on workerd. Validation is automatic (input/output schemas enforced). A typed client (`ContractRouterClient<typeof contract>`) derives from the contract alone — the CLI/Raycast mirrors could consume _that_ instead of hand-written `publicApiGet<T>`.

**What it'd take.**

- Add the oRPC packages to `apps/web`.
- Define contracts (one per operation) in `packages/contracts` as _runtime_ contracts (this is the package's natural evolution — from pure types to typed contracts). `z.infer` on the contract I/O reproduces the existing pure-type DTOs, so the CLI/Raycast keep their types _derived from the contract_.
- Mount an `OpenAPIHandler` under a prefix. **Crucially, this is the incremental seam:** `handler.handle(request, { prefix: '/api/v1' })` returns `{ matched, response }`; when `matched` is `false`, the request falls through to the existing TanStack routes. So oRPC owns the _migrated_ operations and TanStack owns the rest, in the same Worker, indefinitely. (Verified — Appendix.)
- The `/api/v1` ↔ `/api` alias: mount the same `OpenAPIHandler` (or run `.handle` with both prefixes) so migrated routes keep both paths.
- `/api/v1/openapi.json` serves `OpenAPIGenerator.generate(router, { info, servers })`. Scalar + Postman unchanged.

**What it buys.** The **full** contract-first model: one contract per operation generates the spec, enforces validation (in _and_ out), and types a client — the thing Maurice likes about oRPC. Drift is _structurally impossible_ for migrated routes: the route _is_ the contract, so the spec, the validator, and the client can't disagree with the handler (unlike Option 1, where the registry is a parallel description). The MCP tool `inputSchema`s (today hand-written `Record<string, unknown>` JSON Schema in `mcp.ts`) could derive from the same contracts (Unit C extended).

**What it costs.** A **second routing framework** mounted beside TanStack Start, owning a growing slice of `/api`. Every migrated route is a _rewrite_ (handler logic re-expressed as an oRPC `.handler`, input/output as Zod). The mid-migration mental model is "two routers, one Worker" — a real, if bounded, complexity. oRPC's bundle + cold-start cost on workerd must be measured (it's `fetch`-native and tree-shakeable, but it's not free). And it's the biggest blast radius of the three. **This is a destination you opt into for the ceiling — not the cheapest path to killing the drift.**

**Constraints check.** (1) workerd: ✅ — `@orpc/server/fetch` + `@orpc/openapi/fetch` are documented Cloudflare-Workers adapters. (2) coexists with TanStack: ✅ via the `matched:false` fall-through (the _defining_ feature for incremental adoption). (3) reuses contracts: ✅✅ — it _is_ `packages/contracts` grown into runtime contracts; the pure types derive via `z.infer`. (4) alias: ✅ — mount under both prefixes. (5) incremental: ✅✅ — the fall-through means route-by-route is the _native_ migration mode, not a workaround.

### 3.4 The recommendation

**Ship Option 1 (Zod registry → generated doc) as Unit A now.** It deletes the drift-prone file, makes Scalar + Postman self-syncing, costs zero handler churn, and gives reusable validators (Unit B) and the #50 enforcement home (Unit C) for nearly free. It is the smallest change that fully solves the stated problem (the spec lies; stop it lying).

**Hold Option 3 (oRPC) as the named destination (Unit D) — an explicit owner decision, not a default.** If Maurice wants the ceiling (validation + typed clients + MCP all off one contract, drift _structurally_ impossible), oRPC is the right tool and its `matched:false` fall-through makes a _route-by-route_ migration genuinely incremental — you can start with the pilot route and convert at leisure, TanStack handling the rest forever if you stop. The honest caveat: **don't pay for a second router unless the ceiling is wanted.** Option 1 captures ~80% of the value (no drift on the three machine surfaces, reusable validators) at ~20% of the cost.

**Decline Option 2 (Hono)** on fit — it's a second router with neither Option 1's zero-churn nor oRPC's contract-first ceiling, given the app is already on TanStack Start.

**One subtlety the registry vs route distinction forces (state it plainly):** Option 1's registry is a _parallel_ description (drift moves from "spec vs DTO" to "registry vs handler", reduced by sharing the Zod schemas + a coverage test, but non-zero). Option 3's route _is_ the description (drift impossible for migrated routes). That difference is the entire case for ever paying oRPC's cost. If "the registry could still drift from the handler" is unacceptable to Maurice, that's the signal to go straight to Unit D for the routes that matter.

---

## 4. The payoff chain — close the loop end to end

The point of generation is that _one_ edit propagates to _every_ machine surface, with no second artifact to update.

### 4.1 Spec → Scalar → Postman, all auto-synced

Today: hand-edit `public/openapi.json` → Scalar and Postman reflect the edit (good — they import the file) _but the file can be wrong vs the code_ (bad — nothing checks it).

After Unit A: the OpenAPI document is _generated_ from the typed registry/contracts. `/api/v1/openapi.json` serves the generated doc. `/docs/api` (Scalar) reads `/api/v1/openapi.json` → reflects the generated doc. The Postman route (#52) imports the generated doc → reflects it. **So the chain is: typed schema → generated spec → Scalar + Postman, with no hand-maintained link anywhere.** #52's converter is already pure (`openapi-to-postman.ts`, dependency-free, scoped to the constructs the Fluncle spec uses) — it converts _whatever_ the spec route serves, so it inherits the sync automatically. The loop closes: edit a schema, and the spec, the human reference, and the Postman collection all move together, provably (a test round-trips generated-spec → Postman, asserting coverage).

The one wrinkle worth recording: #52 imports `public/openapi.json` as a _static import_. When the spec becomes generated, the Postman route must import the **generated document** (the same function/module the `/api/v1/openapi.json` route calls), not the deleted file. That's a one-line source change in #52's route, called out so the two PRs compose cleanly. (Sequencing: if #52 lands first, this RFC's Unit A updates that import; if Unit A lands first, #52 targets the generated module from the start.)

### 4.2 The registry is where naming conventions get enforced (the #50 tie-in)

This is the deeper payoff. PR #50 (Convention B) wants **one canonical `verb_noun` op per operation**, with each surface's name derived by a fixed rule:

- MCP/WebMCP tool = `verb_noun` (snake_case), verbatim.
- OpenAPI `operationId` = `verbNoun` (camelCase) — same words, re-cased.
- API path = REST resource; non-CRUD = single-word action sub-resource.
- Public CLI = bare verb (spoken register), registered as an alias of the canonical op.

Today that rule is a doc with no teeth — a reviewer has to _notice_ that a new route's `operationId` is off-convention. **With generation, the registry is the rule.** One `verb_noun` entry produces the `operationId` (mechanically `verbNoun`); the same entry can produce the MCP tool name (`verb_noun`) and record the CLI/SSH aliases. An operation _not in the registry_ generates _no spec entry and no operationId_ — so #50's "a route with no operationId is a bug" becomes a **build/test failure**, not a code-review hope. The coverage test (every live `api/v1` route has a registry entry) _is_ the enforcement of #50's §6 checklist item 6 ("every public API route gets an operationId and lands in the spec").

So the dependency is clean and worth stating: **#50 decides the _names_; this RFC builds the _registry that enforces them_.** Unit C is "register the canonical op once, derive the rest" — but it needs #50 ratified first so the registry encodes the _agreed_ names (otherwise we hard-code today's accidental ones and re-churn later). Recommended order: ratify #50 (Convention B) → build Unit A's registry against the _ratified_ names → optionally extend the registry to emit MCP tool names + CLI aliases (Unit C full).

### 4.3 Optional further reach: validation + clients + MCP off the same definitions

- **Validation (Unit B):** the registry's request schemas _are_ the validators. `parseLimit`/`parseTimestamp`/`as SubmissionInput` collapse into `QuerySchema.parse(...)` / `SubmissionSchema.parse(...)`. The validator can't disagree with the spec because it _is_ the spec's schema.
- **Clients (Unit D, oRPC only):** `ContractRouterClient<typeof contract>` types the CLI/Raycast off the contract — `publicApiGet<T>` keeps its hand-passed `T` no longer; the type is the contract's output.
- **MCP (Unit C extended):** the five MCP tools' hand-written `inputSchema` (`mcp.ts`, `Record<string, unknown>` JSON Schema) derive from the same Zod schemas (`zodToJsonSchema(SubmissionSchema)`), so the MCP tool contract can't drift from the API contract — and #50's MCP↔API name parity becomes generated, not maintained.

These are the _reasons_ to climb from A toward D. None are required for the headline drift fix.

---

## 5. Migration path — incremental, with a named pilot

The whole point is that **old hand-written routes and new generated description coexist for the entire transition.** Nothing forces a big-bang.

### 5.1 For Unit A (Zod registry — recommended): there's no route migration at all

Unit A doesn't migrate _routes_ — it migrates the _spec source_. The handlers are untouched. "Incremental" here means **register operations into the spec one at a time**:

1. **Stand up the registry + generator + the generated `/api/v1/openapi.json`**, seeded with exactly the operations the static file already documents (so the served spec is byte-equivalent-or-better on day one). Delete `public/openapi.json`. Scalar + Postman keep working unchanged.
2. **First operation to (re)model: `GET /tracks` → the `Track`/`TrackListPage` schemas.** This is the pilot because it's where the _worst_ drift lives (the 10-vs-40 `Track` field gap) — modeling it correctly off the real `TrackListItem` shape immediately _fixes_ the headline bug and proves the registry reproduces the real payload. Derive `TrackSchema` from the `TrackListItem` contract (or make `TrackListItem = z.infer<typeof TrackSchema>` and delete the duplicate type).
3. **Close the coverage gaps #50 listed** by registering the un-spec'd live routes (`GET /tracks/{idOrLogId}`, `/mixtapes`, `/stories`, `DELETE /me/saved-findings/{trackId}`, `PATCH /me/profile`) — now mechanical, each is one `registerPath`.
4. **Add the coverage test:** enumerate `routes/api/v1/**` route files, assert each (minus the genuinely-internal OAuth-callback set) has a registry entry. This is the _enforcement_ that keeps new routes from silently skipping the spec.
5. **Optionally fold in the admin surface** (the ~30 undocumented routes) behind an `x-internal`/separate tag, if/when an authenticated agent reference is wanted — _out of scope for v1_, but the registry makes it a per-route add, not a rewrite.

### 5.2 For Unit D (oRPC — the destination): the `matched:false` fall-through is the migration

If Maurice opts into oRPC, the migration is genuinely route-by-route, and the un-migrated routes keep working _with zero changes_:

1. **Mount an `OpenAPIHandler` over an empty (or one-route) router under `/api/v1`**, with the `matched:false` fall-through to the existing TanStack handler chain. Day one, oRPC owns _one_ route; TanStack owns the other 61.
2. **Pilot route: `GET /tracks/random`.** Pick it (not `/tracks`) for the _first oRPC route_ because it's the simplest real operation — no query params, no pagination cursor, a single `Ok<{ track }>` output — so the contract + handler + the two-router seam are proven on the lowest-risk surface before touching pagination or POST bodies. (Note the deliberate split: Unit A's _spec-modeling_ pilot is `GET /tracks` because that's where the drift is; Unit D's _route-rewrite_ pilot is `GET /tracks/random` because that's the safest rewrite. Different pilots, different risks.)
3. **Convert routes in risk order:** simple reads → reads with params/pagination → public POSTs (submissions, newsletter) → admin routes. Each conversion deletes its TanStack route file _only after_ its oRPC contract serves both `/api/v1/*` and `/api/*` and its test passes. Stop anytime — the two routers coexist indefinitely.
4. **The spec generates from the _oRPC router_ for migrated routes**; for _un-migrated_ routes, either keep them in the Zod registry (Unit A) and merge the two documents, or accept they're spec'd by the registry until converted. (Merging two generated docs is straightforward — both are plain JS objects; the spec route concatenates `paths`/`components`.) **This is why A and D compose:** A spec's the not-yet-oRPC routes; D spec's the converted ones; the served document is their union, and the union shrinks the registry side as D advances.

### 5.3 How old and new coexist (the invariant for both units)

- **The `/api/v1` ↔ `/api` alias is preserved by construction.** Unit A doesn't touch routing (alias intact). Unit D mounts the `OpenAPIHandler` under both prefixes (or runs `.handle` twice), and any route still on TanStack keeps its existing `aliasHandlers()` dual-mount. No route loses its bare-`/api/*` path during migration.
- **An un-migrated route is _invisible_ to the new machinery and works exactly as today.** In Unit A it's simply not yet in the registry (the spec omits it — same as the status quo for the ~30 admin routes). In Unit D the `OpenAPIHandler` returns `matched:false` and the request falls through untouched.
- **The served spec is always the union of what's modeled**, so `/docs/api` and Postman always reflect the _current_ migration state — never a half-written file.

---

## 6. Owner decisions

1. **Which option for v1?** _Recommended: Option 1 — the Zod registry → generated doc (Unit A)._ It deletes the drift-prone file with zero handler churn and unblocks B and C. (oRPC is a separate decision, #3 below.) _Default: Option 1._
2. **Which generator library for Option 1?** `@asteasolutions/zod-to-openapi` (mature, `OpenApiGeneratorV31`, registry model) vs `@samchungy/zod-openapi` (Zod-4-native `.meta()` metadata, 3.1-first, High reputation). Both run on workerd and both output 3.1. _Recommended: `@asteasolutions/zod-to-openapi`_ unless the app is already standardizing on Zod-4 `.meta()` (then `@samchungy/zod-openapi`). _Confirm which._
3. **Do we also climb to full contract-first (oRPC, Unit D), and if so when?** This is the big one. _Recommended: not in v1._ Ship Unit A (and B) first; treat oRPC as a named, separately-owned destination Maurice opts into **if** he wants drift to be _structurally impossible_ (route = contract) plus typed clients + MCP off one definition. The `matched:false` fall-through means it can start as a one-route pilot whenever, with TanStack handling the rest forever. _Owner call: yes-and-schedule-it, or no-Option-1-is-enough._
4. **Big-bang vs incremental?** _Recommended: incremental, always._ Unit A registers operations one at a time; Unit D converts routes one at a time via the fall-through. There is no scenario here where a big-bang is warranted. _Default: incremental._ (Stated as a decision only to close it explicitly.)
5. **Collapse `packages/contracts`' pure types into the Zod schemas?** Once the registry has `TrackSchema`, the pure `TrackListItem` type can become `z.infer<typeof TrackSchema>`, deleting the hand-maintained duplicate (and the CLI/Raycast types derive from it). _Recommended: yes_ — it removes a second place the DTO shape is written. The Go SSH app stays a hand-mirror regardless (it can't import TS), as the contracts header already notes. _Confirm._
6. **Unify CLI/MCP off the same registry (Unit C full)?** Beyond `operationId` generation, the registry _can_ emit the MCP tool `inputSchema`s and record the CLI/SSH voice aliases, making #50's cross-surface parity _generated_ rather than maintained. _Recommended: yes for MCP `inputSchema` (it's hand-written JSON Schema today and the win is clean), record CLI/SSH aliases as data._ But this is **gated on #50 ratification** so the names are the agreed ones. _Owner call: how far to take the registry beyond the spec._
7. **Ratify PR #50 (Convention B) before the registry hard-codes `operationId`s?** The registry _encodes_ the naming convention; building it against today's accidental names means re-churning when #50 lands. _Recommended: ratify #50 first_ (it's a doc decision, no code), then build the registry against the ratified `verb_noun` list. _Owner call — but the cheap path is #50 → registry._

Everything else is settled in this RFC and needs no further decision: the spec becomes a generated artifact (not a source file); `public/openapi.json` is deleted as a source; Scalar + Postman consume the generated `/api/v1/openapi.json` unchanged; the `/api/v1` ↔ `/api` alias is preserved; migration is incremental with the named pilots (`GET /tracks` for spec-modeling, `GET /tracks/random` for the oRPC route-rewrite if D is chosen); the coverage test enforces "every public route is in the spec"; Hono is declined on fit.

---

## 7. Acceptance criteria

Ship gates for **Unit A** (the recommended v1):

- [ ] `apps/web/public/openapi.json` no longer exists as a source file; the OpenAPI 3.1 document is produced by a generator from a typed Zod registry (`lib/server/openapi/registry.ts` or equiv).
- [ ] `GET /api/v1/openapi.json` serves the **generated** document (`application/openapi+json`), and it validates as well-formed OpenAPI 3.1 (a test asserts this).
- [ ] The generated `Track` schema reflects the **real** emitted DTO (`TrackListItem`, ~40 fields) — the headline drift is fixed; a test asserts `z.infer<TrackSchema>` is assignable to `TrackListItem` (or that `TrackListItem` _is_ the inferred type).
- [ ] `/docs/api` (Scalar) and `GET /api/v1/postman.json` (#52) consume the generated spec unchanged in behavior; the Postman route imports the **generated module**, not the deleted file; a test round-trips generated-spec → Postman asserting full operation coverage.
- [ ] The previously-undocumented live routes #50 listed (`GET /tracks/{idOrLogId}`, `/mixtapes`, `/stories`, `DELETE /me/saved-findings/{trackId}`, `PATCH /me/profile`) have `operationId`s and appear in the generated spec.
- [ ] A **coverage test** enumerates `routes/api/v1/**` and fails if a public route (excluding the genuinely-internal OAuth-callback set) has no registry entry.
- [ ] The `/api/v1` ↔ `/api` alias is untouched and verified intact.
- [ ] `bun run --cwd apps/web typecheck`, `build`, and `lint` are green; the spec-generation + coverage tests pass.
- [ ] `docs/` records the registry-is-the-source rule + the "how to add a route to the spec" recipe.

Additional gates **if Unit B** ships: at least the pilot route (`GET /tracks`) validates its query off the _same_ Zod schema the spec uses (the hand-rolled `parseLimit`/`parseTimestamp` for that route are replaced), with a test.

Additional gates **if Unit D (oRPC)** is chosen: one pilot route (`GET /tracks/random`) is served by an `OpenAPIHandler` mounted under both `/api/v1` and `/api`, with the `matched:false` fall-through proven (an un-migrated route still resolves through TanStack); the served spec is the union of the oRPC router doc + the Zod registry doc; the pilot has a route test.

Additional gates **if Unit C full** ships: the `operationId`s match #50's ratified `verb_noun → verbNoun` rule; (optionally) the MCP `inputSchema`s derive from the registry schemas.

---

## 8. Risks & open questions

- **Option 1's residual drift (registry vs handler).** The registry is a _parallel_ description of routes the library can't see; a new route can be added with no registry entry. **Mitigation:** the coverage test (fails on an unregistered public route) + sharing the response Zod schemas with the handlers (Unit B) so _shape_ drift is gone even if a path is briefly missing. Honest framing: this is _far_ less drift than today (today nothing binds spec to code), but it's not the _structural_ impossibility Option 3 gives. If that residual is unacceptable, that's the trigger for Unit D.
- **Build-time vs request-time generation on workerd.** Generation is pure JS, but doing it _per request_ adds cold-start/per-call cost. **Mitigation:** generate once at module load (cached in the route module) or at build time emitted to an asset; measure the cold-start delta. Cheap either way (the spec is small), but pick deliberately.
- **#52 composition.** The Postman route imports the static `openapi.json`; when it's deleted, that import breaks. **Mitigation:** the explicit one-line source change (import the generated module), sequenced in §4.1 so whichever PR lands second updates it. Call it out in both PRs.
- **#50 not ratified ⇒ re-churn.** Building the registry against today's accidental `operationId`s means renaming when Convention B lands. **Mitigation:** ratify #50 first (a doc decision), then build the registry against the agreed names. Cheap to sequence; expensive to skip.
- **oRPC bundle/cold-start on workerd (Unit D only).** A second framework's size + init cost on Workers must be measured, not assumed. **Mitigation:** it's `fetch`-native and tree-shakeable; the pilot route is the measurement. Don't adopt D on faith — adopt it on a measured pilot.
- **Two-router mental model (Unit D only).** Mid-migration, `/api` is served by _both_ oRPC and TanStack. **Mitigation:** the `matched:false` fall-through is a single, documented seam; the migration converts in risk order and can stop anytime. Bounded, not unbounded, complexity.
- **Zod version + workerd compat.** Pin a Zod major (3 vs 4) consciously — the generator library choice (#2 decision) couples to it (`@samchungy/zod-openapi` is Zod-4-native; `@asteasolutions` supports both). **Mitigation:** decide #2 and the Zod major together; verify in `wrangler dev`.
- **Scope creep into the admin surface.** The ~30 undocumented admin routes are _tempting_ to model now. **Mitigation:** v1 is the _public_ spec only (parity-or-better with today, plus the gap-closures); admin docs are a later per-route add behind a tag, explicitly out of v1. Resist boiling the ocean.
- **It's a small public API.** The honest one: this is ~15 public operations. The win is _deleting a drift-prone file and self-syncing three surfaces_, not adopting a big framework. Size the effort to that — Unit A is the right amount; Unit D is a real-but-optional climb, not table stakes.

---

## Appendix — verifications & sources

**Live code verifications (done during research):**

- **The drift is real and concrete.** `apps/web/public/openapi.json` → `components.schemas.Track` has **10 properties** (`trackId, spotifyUrl, title, artists, album, albumImageUrl, note, addedAt, addedToSpotify, postedToTelegram`). `packages/contracts/src/index.ts` → `TrackListItem` has **~40** (incl. `bpm, key, galaxy, vibeX, vibeY, observationAudioUrl, videoUrl, logId, enrichmentStatus, discogsReleaseUrl, …`). Verified: the spec's `Track` does **not** contain `observationAudioUrl`. The hand-spec under-describes the real payload.
- **The spec is hand-maintained, no codegen.** `public/openapi.json` is a static 716-line file; `routes/api/v1/openapi[.]json.ts` does `import openapi from ".../public/openapi.json"` and returns it. No build step, no test binds it to code. 13 paths / 15 `operationId`s / 8 component schemas in the file.
- **Three consumers of the one file.** `openapi[.]json.ts` (serves it), `docs.api.tsx` (Scalar, `url: "/api/v1/openapi.json"`), and PR #52's `routes/api/v1/postman[.]json.ts` (imports the same file, converts at request time). All inherit the file's drift.
- **The dual-mount.** `routes/api/-alias.ts` — `serverHandlers: ApiHandlers` exported per `/api/*` route, re-mounted at `/api/v1/*` via `aliasHandlers()` (a documented path-phantom cast; _not_ a redirect, so POST bodies survive). 62 `api/v1` route files mirror `api/*`.
- **Validation is hand-rolled.** `routes/api/tracks.ts` — hand-written `parseLimit` (clamp 1–48) + `parseTimestamp` (ISO-or-ignore); the spec's `minimum:1/maximum:48` is _separately_ hand-typed in the JSON. `routes/api/submissions.ts` — `(await request.json()) as SubmissionInput` is a cast, not a validation. `lib/server/http-errors.ts` — `parseJsonBody`/`parseEditorialNote` are ad-hoc, not a schema layer.
- **`packages/contracts` is types-only.** `package.json` exports `./src/index.ts`; the file is pure `export type …` (no runtime). Its header states it's "the single place the public DTOs + response envelopes are defined" so CLI/Raycast can't drift — but being types-only, it can neither generate a spec nor validate. 48 web route files import the contracts or `ApiHandlers`.
- **MCP tool schemas are hand-written JSON Schema.** `lib/server/mcp.ts` — five tools, each `inputSchema: Record<string, unknown>` written by hand; `webmcp.ts` mirrors the same five names (the one place #50 found cross-surface naming already coherent).
- **The runtime.** `apps/web/wrangler.jsonc` — `compatibility_flags: ["nodejs_compat"]`, `compatibility_date: "2026-06-03"`. TanStack Start (`@tanstack/react-start`) on Cloudflare Workers. No `zod`/`hono`/`@orpc/*` in `apps/web` deps today (all candidates are additions).
- **PR #50 (naming-conventions, open):** `docs/naming-conventions.md` (on `origin/worktree-agent-a4b476a8a91c0bebd`) — audits the four-names-for-one-op problem, the operationId≠path mismatches, the spec coverage gaps; recommends **Convention B** (canonical `verb_noun` registry → per-surface derivation; operationId = `verbNoun`, MCP = `verb_noun`); §6 checklist item: "a route with no operationId is a bug."
- **PR #52 (Postman, open):** `routes/api/v1/postman[.]json.ts` + `lib/server/openapi-to-postman.ts` — a dependency-free converter that turns _whatever_ `/api/v1/openapi.json` serves into a Postman v2.1 collection at request time; imports the static `openapi.json` today (the import that must retarget the generated module).

**External sources (current Context7 docs, 2026-06-21):**

- **oRPC** (`/dinwwwh/orpc`): contract-first via `oc.route({method,path}).input(zod).output(zod)`; `implement(contract).handler(...)`; spec from the router via `OpenAPIGenerator` + `ZodToJsonSchemaConverter` (`@orpc/openapi` + `@orpc/zod`); `OpenAPIHandler`/`RPCHandler` from `@orpc/server/fetch` + `@orpc/openapi/fetch` as documented **Cloudflare-Workers fetch adapters**; `handler.handle(req, { prefix })` returns `{ matched, response }` → `matched:false` is the **incremental fall-through** to other routers; `ContractRouterClient<typeof contract>` types a client from the contract alone.
- **`@asteasolutions/zod-to-openapi`** (`/asteasolutions/zod-to-openapi`): `OpenAPIRegistry` + `registry.register("Name", schema)` (→ `$ref`) + `registry.registerPath({method,path,request,responses})`; `OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi:"3.1.0", info })` returns a plain JS object (3.1 emits `type:[...,'null']` for nullable). Pure JS — workerd-safe.
- **`@samchungy/zod-openapi`** (`/samchungy/zod-openapi`): Zod-4-native `.meta()` metadata, OpenAPI 3.1-first — the alternative generator if standardizing on Zod 4.
- **`@hono/zod-openapi`** (`/paolostyle/hono-zod-openapi`, `/websites/hono_dev`): `OpenAPIHono` + `createRoute` define routes whose Zod schemas validate _and_ generate `/doc`; native workerd `fetch` framework. Declined on fit (second router; app is already on TanStack Start).
