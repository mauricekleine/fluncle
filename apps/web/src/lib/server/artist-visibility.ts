// ARTIST VISIBILITY — the read side of the global `unlisted` artist rule.
//
// An artist entity is PUBLIC unless a global `artist_rules` row carrying the verdict `unlisted`
// names its MusicBrainz MBID. The rule exists for the shape MusicBrainz forces on the crawler: a
// remix is billed to the ORIGINAL artist, so a drum & bass remix of a pop song mints an artist
// entity for the pop act. The remix belongs in the archive; the pop act does not get a page.
//
// ── THE TWO LAWS ────────────────────────────────────────────────────────────────
//   1. Derived at READ time, never stamped on the `artists` row. Authoring or removing the rule
//      flips every surface at once, with no backfill and no row rewrite. The only lag is the
//      edge cache.
//   2. ONE SQL pass. Every consumer carries the predicate below inside its own statement — never a
//      second read whose result is folded in the isolate, and never a column pulled into the Worker
//      to filter (the hosted-Turso law in AGENTS.md).
//
// ── WHY IT IS A LIST SUBQUERY ON `slug`, NOT A CORRELATED PROBE ON `mbid` ───────
// The obvious spelling is `not exists (… artist_rules.artist_mbid = a.mbid …)`. It is correct and
// it is wrong here, because it makes `mbid` part of the gate: the hub's two AGGREGATE reads (the
// total and the A–Z lane) run off `artists_hub_listing_idx`, whose key is `slug` alone, so a gate
// that needs `mbid` seeks a TABLE ROW for every entry — the whole-table read that index exists to
// remove (entity-hub-seek.integration.test.ts pins it).
//
// So the direction is reversed. The rules table drives: it is operator-authored and tiny, and the
// seek `artist_rules → artists_mbid_idx (mbid, slug)` resolves each ruled identity to its slugs
// index-only. SQLite evaluates that list ONCE per statement (a LIST SUBQUERY over an ephemeral
// index, never re-run per row), and what the outer scan then tests is `slug` — the column the hub
// index already carries. Cost: one bounded lookup per statement, and every gated read stays on its
// own index.
//
// `slug` is NOT NULL on `artists`, so the `not in` cannot collapse to NULL and hide the archive.
//
// Visibility hides the PAGE, never a track: `/track/<id>` and `/log/<coordinate>` are untouched,
// and an unlisted artist's credit still renders — as plain text, because there is nowhere to send
// you. That gate rides the same name→slug maps the link already reads, so one predicate serves
// both the link and its JSON-LD `@id`.

/**
 * The public-artist predicate, for splicing into a `where` clause.
 *
 * `alias` is the SQL name the `artists` table carries in the calling query, and is always a
 * literal written at the call site — never user input, so the interpolation is closed.
 *
 * An artist whose `mbid` is still null can carry no rule, so it stays public — the honest answer,
 * since nothing identifies it as the ruled act.
 */
export function listedArtistWhere(alias = "artists"): string {
  return `${alias}.slug not in (
    select unlisted_artist.slug
    from artist_rules
    join artists as unlisted_artist on unlisted_artist.mbid = artist_rules.artist_mbid
    where artist_rules.label_id is null and artist_rules.verdict = 'unlisted'
  )`;
}
