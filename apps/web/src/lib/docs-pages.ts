// The `/docs` page paths, for the consumers that need to KNOW what docs exist without
// pulling the docs content pipeline in with them (today: the sitemap's `docs` child).
//
// WHY IT IS A HAND-HONOURED LIST AND NOT A READ OF THE TREE. `docsSource.getPages()`
// (lib/docs-source.ts) is the real source of the page tree, and reading it here would be the
// obvious anti-drift move — but `.source/server` is the eagerly-compiled MDX collection, and
// resolving it needs the `fumadocs-mdx` Vite plugin, which `vite.config.ts` registers and
// `vitest.config.ts` does not. Importing it from a server module the tests exercise
// (`sitemap-data.ts`) therefore fails every sitemap test at transform time on
// `content/docs/meta.json`. So this list is hand-honoured and `./docs-pages.test.ts` is the
// build-failing net over it: the test reads `content/docs/` off disk (it runs in Node, where
// that is free) and asserts the two agree exactly, so a doc added, renamed, or deleted without
// touching this list fails the build. Same shape as the repo's other parity nets
// (`orpc-coverage`, `hermes-healthcheck-coverage`, the registry's `doctrine-parity`).
//
// Client-safe by construction: a plain string array, no imports.

/**
 * Every `/docs/<slug>` page, alphabetical. The `/docs` hub itself is NOT here — the sitemap's
 * static `pages` child owns the hub, and one `<loc>` in two children would blur the per-sitemap
 * coverage number the child split exists to give.
 *
 * `/docs/api` (the Scalar API reference) is NOT here either: it is a route, not a doc in the
 * content tree, and whether a reference whose body only exists after JS belongs in a sitemap is
 * a posture call rather than a mechanical one. `./docs-pages.test.ts` pins both exclusions.
 */
export const DOCS_PAGES: readonly string[] = [
  "/docs/api-overview",
  "/docs/cli",
  "/docs/dig",
  "/docs/feeds",
  "/docs/identity",
  "/docs/log-id",
  "/docs/mcp",
  "/docs/ssh",
  "/docs/tor",
];
