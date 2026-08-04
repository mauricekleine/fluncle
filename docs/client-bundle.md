# The client bundle: what every page pays before it paints

`apps/web` ships one eager JavaScript chunk and one stylesheet that **every page downloads before it renders anything**. This doc is the contract on what is allowed in them, why the two rules exist, and the build gate that holds the first one.

The shape of the split itself — how the client is carved into chunks and why grouping by package family was rejected — lives in [`apps/web/scripts/client-chunk-groups.ts`](../apps/web/scripts/client-chunk-groups.ts). This doc is about what gets IN.

## Rule 1 — no server-only module in the eager entry chunk

**Enforced. A violation fails the build** (`fluncle-eager-chunk-purity` in `apps/web/vite.config.ts`), the `orpc-coverage` pattern applied to the browser.

The `app` group in `client-chunk-groups.ts` deliberately folds everything statically reachable from the client entry into one chunk, because those bytes were being fetched before first paint anyway. The consequence is that **a single stray static import does not cost one page — it costs the homepage**, and it does it in total silence: the build stays green, the types pass, the page renders correctly.

### Why it happens, structurally

A route file is auto-split, but only its `component` moves to a lazy chunk. Its **`loader`, `head`, `validateSearch` and `loaderDeps` stay in the route's critical half** and are bundled eagerly. So any of those touching a `lib/server/**` export — even a bare integer constant like a thin-content floor — welds `getDb` → `@libsql/client` + `drizzle-orm` + the whole of `db/schema.ts` onto first paint.

The second shape is the one TanStack Start's own import-protection guide names: an **exported helper referenced outside a `createServerFn().handler()` boundary**. The client build removes a handler body wholesale, and the imports with it — but a resolver that is also exported for a test to drive keeps them alive.

The eager-chunk gate covers route-critical imports and shared helpers that can pull server-only modules into the homepage entry.

### The two fixes

1. **A value the `head`/`loader`/`validateSearch` genuinely needs** → put it in a client-safe module and re-export it from the server one. Exemplars: [`lib/catalogue.ts`](../apps/web/src/lib/catalogue.ts) (the sort vocabulary, the page bounds, the group shapes, `pageNumbers`) re-exported by `lib/server/catalogue-groups.ts`; [`lib/galaxies.ts`](../apps/web/src/lib/galaxies.ts) (one thin-content floor) re-exported by `lib/server/galaxies-map.ts`. The SQL and the reads never move.
2. **The data resolution itself** → a `routes/-<entity>-page-data.ts` sibling, reached by a **dynamic import inside the handler body**. Exemplars: `-album-page-data.ts`, `-artist-page-data.ts`, `-label-page-data.ts`. The resolver stays exported and side-effect-free, so its unit test drives it directly against a real database exactly as before. The read-path lock in [`search-consumers.test.ts`](../apps/web/src/lib/server/search-consumers.test.ts) recognizes literal dynamic imports of `lib/server/track-search` too: the import is bundle-safe, but it still counts as a Spotify read-path consumer.

A loader that awaits a heavy route-specific module must dynamically import it inside the loader. The `/docs` routes are the exemplar.

### The one exemption, and why it is safe

`lib/server/track-match.ts` is permitted, and it earns it by having an **empty import list** — a pure fold over strings, 3 KB, with nothing behind it to drag. `lib/log-schema.ts` needs it for a finding's remixer credits and is read from route `head`s. Its path is canon across `docs/`, the `fluncle-rekordbox-sync` skill, and a Python port kept in lockstep, so relocating it is a repo-wide rename for 3 KB.

The gate does not take that on trust: it **re-checks the premise every build** and fails if the module ever grows an import of its own.

### What the gate deliberately does not cover

The gate covers the eager entry chunk. Lazy route chunks remain outside its scope.

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
