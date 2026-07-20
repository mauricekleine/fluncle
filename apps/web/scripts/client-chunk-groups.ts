import { type Rolldown } from "vite";

// How the CLIENT bundle is split into chunks, consumed by `vite.config.ts` as
// the `client` environment's `output.codeSplitting.groups`. Vite 8 bundles with
// Rolldown, so this is Rolldown's `codeSplitting` API (the successor to Rollup's
// `manualChunks` and to Rolldown's own earlier `advancedChunks`) — `manualChunks`
// is deprecated there and is ignored outright when `codeSplitting` is also set.
//
// It lives in its own side-effect-free module so the invariants below can be
// unit-tested without importing `vite.config.ts`, which would pull in the
// Cloudflare, Sentry and fumadocs plugins and shell out to git.
//
// THE PROBLEM. Left to the default splitting the client shattered into 362
// chunks, 162 of them under 2 KB — a chunk per Phosphor icon (48 of those), a
// chunk per Shadcn primitive, a chunk per one-line helper. Each is a request,
// each is compressed on its own so gzip never gets to see the repetition ACROSS
// them, and each carries the ~490-byte crawler banner from `vite.config.ts`
// (~175 KB of pure banner across the bundle). Every module the client entry
// reaches STATICALLY is also preloaded eagerly, so that count decided how many
// `<link rel="modulepreload">` tags landed in the `<head>` of every document.
// Measured on the built output, the home page's first-paint JS was 117 requests.
//
// THE SHAPE OF THE FIX. Merging chunks is only free when the merged modules were
// going to be downloaded together anyway. Grouping by PACKAGE FAMILY (`react`,
// `@tanstack`, `fumadocs`) is emphatically not that — it welds the route-lazy
// 2.1 MB API-reference vendor onto a module the root happens to touch. Measured,
// that naive shape took the home page from 1,501 KB to 5,113 KB of first-paint
// JS even as the request count fell; the wrong trade. So the split follows the
// LOAD GRAPH instead of the dependency tree, in two bands:
//
//  1. `app` captures Rolldown's `$initial` tag — precisely the modules reachable
//     STATICALLY from the entry, i.e. the eager first-paint set. Every byte in
//     here was already fetched before anything rendered, so merging within it
//     costs no extra download and collapses ~100 requests into a handful. It
//     carries NO `maxSize`; see the constant below for why.
//  2. The lazy tail (`vendor`, then everything else) merges ONLY within an
//     identical entry set — that is what `entriesAware` means: modules reached by
//     the same set of entries share a chunk, modules reached by a different set
//     never do. So a public page cannot be made to carry admin-only or docs-only
//     weight.
//
// Route-level code splitting is untouched throughout: every route still resolves
// to its own lazily-fetched chunk, and the heavy single-route vendors (@scalar,
// fumadocs, the chat SDKs) stay behind their dynamic imports. The goal is fewer,
// better-sized chunks — never one bundle.

/**
 * `entriesAwareMergeThreshold` MUST STAY 0, and the unit test holds it there.
 *
 * The option folds an undersized `entriesAware` subgroup into its "closest
 * neighbouring subgroup", and that merge crosses the very entry-set boundary
 * band 2 exists to enforce. Measured at a threshold of just 8 KB it welded the
 * @scalar API-reference bundle onto the shared path and took `/tracks` from
 * 1,405 KB to 4,375 KB of first-paint JS. Any non-zero value reintroduces the
 * leak, silently — the build stays green and the page triples.
 */
export const ENTRIES_AWARE_MERGE_THRESHOLD = 0;

export const clientChunkGroups: Rolldown.CodeSplittingGroup[] = [
  /**
   * The eager `$initial` group MUST NOT carry a `maxSize`, and the unit test holds
   * it there.
   *
   * A bound looks appealing — it would split the ~1.3 MB eager set into several
   * independently cacheable chunks instead of folding it into the entry, so a
   * one-line app edit would not re-bust React for every visitor. It does not
   * survive contact with the runtime. `maxSize` cuts the group at arbitrary module
   * boundaries, and that reordering breaks CommonJS interop initialisation: with
   * `maxSize: 1_000_000` the built app threw `Uncaught TypeError: n is not a
   * function` from the `use-sync-external-store` shim on first paint, killing
   * hydration. Verified in a browser against the built output — the build, the
   * typecheck and the tests were all green while the page was dead, which is
   * exactly why this is a guarded invariant and not a comment.
   *
   * The cache-granularity cost is real and accepted: the eager set is one chunk.
   */
  { name: "app", priority: 100, tags: ["$initial"] },
  {
    entriesAware: true,
    entriesAwareMergeThreshold: ENTRIES_AWARE_MERGE_THRESHOLD,
    name: "vendor",
    priority: 20,
    test: /node_modules[\\/]/,
  },
  {
    entriesAware: true,
    entriesAwareMergeThreshold: ENTRIES_AWARE_MERGE_THRESHOLD,
    name: "chunk",
    priority: 10,
  },
];
