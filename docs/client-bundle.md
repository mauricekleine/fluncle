# The client bundle: what every page pays before it paints

`apps/web` ships one eager JavaScript chunk and one stylesheet that **every page downloads before it renders anything**. This doc is the contract on what is allowed in them, why the two rules exist, and the build gate that holds the first one.

The shape of the split itself — how the client is carved into chunks and why grouping by package family was rejected — lives in [`apps/web/scripts/client-chunk-groups.ts`](../apps/web/scripts/client-chunk-groups.ts). This doc is about what gets IN.

## Rule 1 — no server-only module in the eager entry chunk

**Enforced. A violation fails the build** (`fluncle-eager-chunk-purity` in `apps/web/vite.config.ts`), the `orpc-coverage` pattern applied to the browser.

The `app` group in `client-chunk-groups.ts` deliberately folds everything statically reachable from the client entry into one chunk, because those bytes were being fetched before first paint anyway. The consequence is that **a single stray static import does not cost one page — it costs the homepage**, and it does it in total silence: the build stays green, the types pass, the page renders correctly.

### Why it happens, structurally

A route file is auto-split, but only its `component` moves to a lazy chunk. Its **`loader`, `head`, `validateSearch` and `loaderDeps` stay in the route's critical half** and are bundled eagerly. So any of those touching a `lib/server/**` export — even a bare integer constant like a thin-content floor — welds `getDb` → `@libsql/client` + `drizzle-orm` + the whole of `db/schema.ts` onto first paint.

The second shape is the one TanStack Start's own import-protection guide names: an **exported helper referenced outside a `createServerFn().handler()` boundary**. The client build removes a handler body wholesale, and the imports with it — but a resolver that is also exported for a test to drive keeps them alive.

Both were live. Measured on the built bundle in July 2026, four route files (`album.$slug`, `artist.$slug`, `label.$slug`, `galaxies.$slug`) and one shared lib put **~232 KB of rendered server-only modules** into the chunk the homepage downloads first.

### The two fixes

1. **A value the `head`/`loader`/`validateSearch` genuinely needs** → put it in a client-safe module and re-export it from the server one. Exemplars: [`lib/catalogue.ts`](../apps/web/src/lib/catalogue.ts) (the sort vocabulary, the page bounds, the group shapes, `pageNumbers`) re-exported by `lib/server/catalogue-groups.ts`; [`lib/galaxies.ts`](../apps/web/src/lib/galaxies.ts) (one thin-content floor) re-exported by `lib/server/galaxies-map.ts`. The SQL and the reads never move.
2. **The data resolution itself** → a `routes/-<entity>-page-data.ts` sibling, reached by a **dynamic import inside the handler body**. Exemplars: `-album-page-data.ts`, `-artist-page-data.ts`, `-label-page-data.ts`. The resolver stays exported and side-effect-free, so its unit test drives it directly against a real database exactly as before.

The same trap catches a `loader` that awaits anything heavy. `/docs/$` and `/docs/` statically imported `-docs-loader.tsx` for their MDX warm-up, which put **99 KB of rendered `fumadocs-ui`** into the eager chunk — on the homepage. Both now `await import("./-docs-loader")` inside the loader, which is free: the loader was awaiting that work regardless.

### The one exemption, and why it is safe

`lib/server/track-match.ts` is permitted, and it earns it by having an **empty import list** — a pure fold over strings, 3 KB, with nothing behind it to drag. `lib/log-schema.ts` needs it for a finding's remixer credits and is read from route `head`s. Its path is canon across `docs/`, the `fluncle-rekordbox-sync` skill, and a Python port kept in lockstep, so relocating it is a repo-wide rename for 3 KB.

The gate does not take that on trust: it **re-checks the premise every build** and fails if the module ever grows an import of its own.

### What the gate deliberately does not cover

Server modules still reach some **lazy route chunks** — `db/schema.ts` rides `/artists`' chunk, `lib/server/tools/specs.ts` rides another. That is the same bug an order of magnitude cheaper: a page pays only for its own route, not for everyone else's. Widening the gate to every chunk is the next step, not this one; a gate nobody can get green teaches nothing.

## Rule 2 — one render-blocking stylesheet, and it is `styles.css`

Not enforced by a gate (it needs a judgement call the gate cannot make), but the rule is simple: **a CSS file enters the app through `__root.tsx`'s `styles.css?url` link, or it is scoped to the route that needs it.**

A bare `import "some-package/style.css"` in a route module does NOT stay with that route. Rolldown folds it into the client entry's CSS bundle, and TanStack Start attaches the entry's CSS to the `__root` route — so it renders as a **render-blocking `<link>` on every page**. `/docs/api`'s `import "@scalar/api-reference-react/style.css"` is how the app came to ship a second **249 KB (37.6 KB gzip)** stylesheet on the homepage.

The fix is the pattern `/docs` already used for `docs.css`: import the sheet with **`?url`** and link it from that route's `head`. Cascade order is preserved — `@tanstack/react-router`'s `headContentUtils` renders route `head` links (root first, then children) BEFORE manifest CSS, so a route-linked sheet lands exactly where the manifest-attached one did.

### Known, measured, and deliberately not taken

`styles.css` folds in `fumadocs-ui/css/neutral.css` + `preset.css`, which are **docs-only weight on every page: 48 KB raw / 7.8 KB gzip** (measured by building with the two `@import`s removed — 316 KB → 268 KB raw, 47.1 KB → 39.3 KB gzip). Moving them into `docs.css` is not a straight lift: the `--color-fd-*` token bridge in `styles.css` only overrides Fumadocs' default LIGHT `:root` palette because it FOLLOWS `neutral.css` in source order. A docs-only sheet loads AFTER `styles.css`, so `neutral.css` would win and the docs hub would paint light. The bridge has to travel with it, and the result needs verifying against a rendered `/docs`.

## Where the weight actually is

Rendered-module weight of the eager entry chunk, after the July 2026 pass (measure it by adding a `generateBundle` hook that dumps `chunk.modules[id].renderedLength`):

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
