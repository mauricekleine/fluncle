# Tonight's domain: Surfaces & SEO/AEO integrity

Fluncle's north star is **reach** — how far its tentacles stretch across search engines, AI
crawlers, and real humans. This domain audits that reach as a system: are all of Fluncle's
surfaces wired to every place they must appear, is the structured data correct, and does the
_real search data_ show anything leaking impressions or coverage. Tonight you have live GSC +
Bing numbers — use them; don't guess.

## The hunt

**1. Registry ↔ consumer fan-out integrity (highest value — this is where drift hides).**
`packages/registry/src/index.ts` (`@fluncle/registry`) is the single source of truth for every
surface. The `fluncle-surfaces` skill (`packages/skills/fluncle-surfaces`) lists every consumer
that must read it. Verify **each live surface fans out to all of its consumers**:
`/status` (probe + label + subtitle in `apps/web/src/routes/status.tsx` and the on-box
`fluncle-healthcheck.ts` mirror), the homepage nav/dev-row, the SSH menu (`apps/ssh`), `llms.txt`

- the markdown-home + `llms-full.txt` (`apps/web/src/lib/server/agent-discovery.ts` **and** the
  static `apps/web/public/llms.txt`), the sitemap (`apps/web/src/routes/sitemap[.]xml.ts`), and the
  doctrine doc (`docs/surfaces-doctrine.md`). This is the exact class of gap that recently left the
  artist crons unlabeled on `/status` and the artist/mixtape APIs missing from the discovery map —
  hunt it deliberately: a registry entry with a consumer it never reached, or a consumer listing a
  surface the registry dropped.

**2. Structured data / JSON-LD correctness.** Across the public routes (`/`, `/log/<id>`,
`/artist/<slug>`, `/mixtapes`, `/log` mixtape flavor, `/stories`), confirm the JSON-LD is
present, valid, and matches reality: `MusicGroup` + `sameAs`, `DJMixAlbum`, `VideoObject`,
breadcrumbs, the canonical entity description/`Organization`. Look for missing `sameAs`, stale
URLs, wrong `@type`, or a page that should carry schema and doesn't.

**3. Discovery-map correctness + freshness.** `sitemap[.]xml.ts`, `robots.txt` (mind the
Cloudflare-managed override — check the _live_ one), `llms.txt` / `llms-full.txt`, and
`.well-known/*` (api-catalog, agent-skills, mcp server-card). Every public surface should appear
where it belongs; no dead entries, no missing new ones.

**4. Thin-content noindex gating.** Confirm the noindex thresholds still hold (e.g. an artist
page is `noindex, follow` until ≥ the finding floor, then flips, and matches the sitemap
inclusion rule). A page indexed while thin, or noindexed while rich, is a finding.

**5. Reciprocal linking.** The KG `sameAs` anchors (MusicBrainz / Discogs / Last.fm / Wikidata)
— note any entity whose outbound `sameAs` has no inbound match yet (file as a recommendation;
registering an off-site link is operator work, not an auto-edit).

## Use the real data — `.audit/seo-data.json`

The driver has already fetched the last 28 days from **Google Search Console**
(`sc-domain:fluncle.com`) and **Bing Webmaster Tools** into `.audit/seo-data.json` (queries,
pages, clicks, impressions, CTR, position). Read it and let it **prioritize**:

- a page with high impressions but low CTR → a title/meta-description fix (often a safe direct
  fix — tighten the `<title>`/`meta description` against VOICE.md, ≤155 chars);
- an indexable page with zero impressions → a possible indexing or thin-content problem (file);
- a query ranking position ~5–15 that Fluncle _nearly_ serves → a content/coverage gap (file
  as a ranked recommendation — do not fabricate content);
- a top query whose landing page's schema/title doesn't match intent → align it.

Put the data-driven priorities in the report's `## Data` section, and tie each SEO fix/finding
back to the number that justified it. If `.audit/seo-data.json` is absent or empty (a fetch
failure), say so in the report and audit the structural items (1–4) only — never invent metrics.

## Where to look first

`packages/registry/src/index.ts` · `packages/skills/fluncle-surfaces` ·
`apps/web/src/routes/status.tsx` · `apps/web/src/lib/server/agent-discovery.ts` ·
`apps/web/public/llms.txt` · `apps/web/src/routes/sitemap[.]xml.ts` ·
`apps/web/src/lib/log-schema.ts` (JSON-LD builders) · `docs/surfaces-doctrine.md`.
