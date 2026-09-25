# The client bundle: what every page pays before it paints

`apps/web` ships one eager JavaScript chunk and one stylesheet that **every page downloads before it renders anything**, plus a lazy chunk per route. This doc is the contract on what is allowed in them, why the two rules exist, and the build gate that holds the first one.

The split follows the load graph: the `$initial` group holds statically reachable modules, and lazy groups merge only modules reached by identical entry sets. Keep `entriesAwareMergeThreshold` at zero so a small lazy subgroup cannot cross that boundary and pull route-specific vendors into another page's first paint. Leave the eager group's `maxSize` unset: splitting it at arbitrary module boundaries can reorder CommonJS interop initialization and break hydration even when the build passes. [`client-chunk-groups.test.ts`](../apps/web/scripts/client-chunk-groups.test.ts) pins both settings.

## Rule 1 — no server-only module in any client chunk

**Enforced. A violation fails the build** (`fluncle-client-chunk-purity`, implemented in [`apps/web/scripts/client-chunk-purity.ts`](../apps/web/scripts/client-chunk-purity.ts) and registered in `vite.config.ts`), the `orpc-coverage` pattern applied to the browser.

The `app` group in `client-chunk-groups.ts` deliberately folds everything statically reachable from the client entry into one chunk, because those bytes were being fetched before first paint anyway. The consequence is that **a single stray static import does not cost one page — it costs the homepage**, and it does it in total silence: the build stays green, the types pass, the page renders correctly.

### Why it happens, structurally

A route file is auto-split, but only its `component` moves to a lazy chunk. Its **`loader`, `head`, `validateSearch` and `loaderDeps` stay in the route's critical half** and are bundled eagerly. So any of those touching a `lib/server/**` export — even a bare integer constant like a thin-content floor — welds `getDb` → `@libsql/client` + `drizzle-orm` + the whole of `db/schema.ts` onto first paint.

The second shape is the one TanStack Start's own import-protection guide names: an **exported helper referenced outside a `createServerFn().handler()` boundary**. The client build removes a handler body wholesale, and the imports with it — but a resolver that is also exported for a test to drive keeps them alive.

The third shape is the one that takes a page DOWN rather than making it fat: a **helper the route's component calls**. A live client reference pins the server module outright — there is no handler body to strip and nothing to tree-shake around — and pinning it pins everything it imports.

### Why a lazy route chunk is an outage, not a weight problem

The client build does not delete a server module. It **rewrites its `node:*` imports to Vite's externalized stubs**, and every property access on one of those throws. So a server module that reaches a lazy route chunk throws during the chunk's module evaluation: the route's component never mounts, and the visitor gets the root `errorComponent` instead of the page. The rest of the site is fine, which is exactly why it can sit in production unnoticed.

Tree-shaking is not a safety net. A module-level side effect Rollup cannot prove pure — `new AsyncLocalStorage()` at the top of [`lib/server/database-request-scope.ts`](../apps/web/src/lib/server/database-request-scope.ts) — keeps the whole import chain alive even when every one of its exports is unused. That is the difference between a server import the build silently drops and one that ships.

### The two fixes

1. **A value the client genuinely needs** — a `head`/`loader`/`validateSearch` constant, or a pure helper the component folds over its data → put it in a client-safe module under `src/lib/` and re-export it from the server one. Exemplars: [`lib/catalogue.ts`](../apps/web/src/lib/catalogue.ts) (the sort vocabulary, the page bounds, the group shapes, `pageNumbers`) re-exported by `lib/server/catalogue-groups.ts`; [`lib/galaxies.ts`](../apps/web/src/lib/galaxies.ts) (one thin-content floor) re-exported by `lib/server/galaxies-map.ts`; [`lib/artist-review.ts`](../apps/web/src/lib/artist-review.ts) (the artist-review shapes plus `artistNeedsLook` / `unreviewedSocials` / `partitionFreshLinks`, which `/admin/artists` calls in its component) re-exported by `lib/server/artists.ts`. The SQL and the reads never move.
2. **The data resolution itself** → a `routes/-<entity>-page-data.ts` sibling, reached by a **dynamic import inside the handler body**. Exemplars: `-album-page-data.ts`, `-artist-page-data.ts`, `-label-page-data.ts`. The resolver stays exported and side-effect-free, so its unit test drives it directly against a real database exactly as before. The read-path lock in [`search-consumers.test.ts`](../apps/web/src/lib/server/search-consumers.test.ts) recognizes literal dynamic imports of `lib/server/track-search` too: the import is bundle-safe, but it still counts as a Spotify read-path consumer.

A loader that awaits a heavy route-specific module must dynamically import it inside the loader. The `/docs` routes are the exemplar.

### The one exemption, and why it is safe

`lib/server/track-match.ts` is permitted, and it earns it by having an **empty import list** — a pure fold over strings, 3 KB, with nothing behind it to drag. `lib/log-schema.ts` needs it for a finding's remixer credits and is read from route `head`s. Its path is canon across `docs/`, the `fluncle-rekordbox-sync` skill, and a Python port kept in lockstep, so relocating it is a repo-wide rename for 3 KB.

The gate does not take that on trust: it **re-checks the premise every build** and fails if the module ever grows an import of its own.

### What "client-safe" means operationally

The gate reads the **path**, not the module's contents: anything matching `apps/web/src/lib/server/**` or `apps/web/src/db/**` is refused. A module that is already pure is therefore moved rather than annotated — [`lib/tool-specs.ts`](../apps/web/src/lib/tool-specs.ts) (the WebMCP-facing tool specs, zod only) and [`lib/track-stage.ts`](../apps/web/src/lib/track-stage.ts) (the admin board's derived pipeline stage) live under `lib/` for exactly that reason.

The gate's own tripwire is [`apps/web/scripts/client-chunk-purity.test.ts`](../apps/web/scripts/client-chunk-purity.test.ts): it drives the predicate and the Rollup hook over a leaking bundle, a clean one, the SSR output it must ignore, and the exemption with its premise broken.

HTML cached at the edge references build-scoped `/assets/<hash>.js` URLs. Keep its stale-while-revalidate tail within the deploy cadence (the page tier caps it at one hour); an older HTML response can otherwise point a browser at removed chunks. The root route's chunk-load recovery is the second guard.

## Rule 2 — one render-blocking stylesheet, and it is `styles.css`

Not enforced by a gate (it needs a judgement call the gate cannot make), but the rule is simple: **a CSS file enters the app through `__root.tsx`'s `styles.css?url` link, or it is scoped to the route that needs it.**

Import route-specific stylesheets with `?url` and link them from the route's `head`. A bare CSS import in a route enters the global entry stylesheet.

`styles.css` currently includes Fumadocs' `neutral.css` and `preset.css`. Moving them into `docs.css` also requires moving the `--color-fd-*` bridge after those imports so the docs retain the dark palette. Verify the result on a rendered `/docs` page. Measure eager-entry weight from `chunk.modules[id].renderedLength` when evaluating further cuts.

## Where the weight actually is

Rendered-module weight of the eager entry chunk:

| Group                                    | Rendered | Note                                                             |
| ---------------------------------------- | -------- | ---------------------------------------------------------------- |
| `react-dom`                              | 450 KB   | the floor                                                        |
| `@base-ui/react`                         | 351 KB   | menu + tooltip + scroll-area + floating-ui, from the root chrome |
| `@tanstack/router-core` + `react-router` | 195 KB   | the framework                                                    |
| `@sentry/core` + `@sentry/browser`       | 167 KB   | must init early by design                                        |
| `@phosphor-icons/react`                  | 93 KB    | icons actually on screen                                         |
| `packages/registry/src`                  | 84 KB    | the surfaces registry, read by the nav model                     |
| `cnfast`                                 | 62 KB    | the tailwind-merge table                                         |

Nothing in that list is a leak. The next real cut is the root chrome's Base UI surface (a lazily-mounted menu/tooltip is an interaction-timing decision, not plumbing) and the registry — both belong to the design overhaul rather than to delivery.
