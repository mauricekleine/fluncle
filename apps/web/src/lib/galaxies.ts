// The CLIENT-SAFE half of the galaxies map: the one bound a page's `head` has to know.
//
// It sits here rather than in `lib/server/galaxies-map.ts` for the same reason `lib/catalogue.ts`
// exists. `galaxies.$slug.tsx` reads this floor inside its `head`, and a route's `head` lives in
// the route's CRITICAL half — so importing the number from the server module put `galaxies-map.ts`
// → `getDb` → `@libsql/client` + `drizzle-orm` + `db/schema.ts` into the eager entry chunk every
// page downloads before first paint. A constant does not need a database behind it.
//
// `lib/server/galaxies-map.ts` re-exports it, so the sitemap and every other server caller keep
// reading it from where they always did.

/**
 * The galaxy thin-content floor (browse-by-feel RFC, mirroring the `/artist` gate): a
 * named galaxy below this many members renders `noindex, follow` and stays out of the
 * sitemap. It still resolves (200) and is reachable — just not indexed while thin.
 */
export const GALAXY_INDEX_MIN_FINDINGS = 4;
