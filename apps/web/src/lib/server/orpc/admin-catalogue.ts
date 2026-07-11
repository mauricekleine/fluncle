// The `admin-catalogue` domain router module — THE CATALOGUE, both halves. Four ops, all
// `adminAuth` (operator OR agent):
//
//   THE CRAWLER (docs/catalogue-crawler.md) — what makes the rows exist:
//   - `crawl_catalogue`  — one bounded, resumable pass of the MusicBrainz walk.
//   - `get_crawl_status` — the crawl frontier's state.
//
//   THE EAR (docs/the-ear.md) — the ranked read over them:
//   - `list_catalogue_tracks` — the ranked read. An ordered walk of a precomputed column;
//     no vector math on the request path.
//   - `rank_catalogue` — one tick of the precompute sweep, the job a periodic `--no-agent`
//     cron drives with the box's agent token.
//
// WHY EVERY OP HERE IS AGENT-ALLOWED AND NOT OPERATOR-TIER. None of them can certify.
// The sweep writes only DERIVED ranking columns, and only on CATALOGUE rows (`tracks` with
// no `findings` row); the crawler writes new catalogue rows and captures no audio. Neither
// can mint a coordinate, write a note, or touch a finding — the columns for that do not
// exist on the rows they can reach. That makes them machine jobs like `update_galaxy_map`,
// not editorial acts like `update_galaxy` (which an agent token 403s on, correctly).
//
// The ONE act that steers the catalogue — RULING on a seed label, which decides what may be
// crawled at all — is `update_label`, and it stays OPERATOR tier.
//
// `crawl_catalogue`'s params ride the query string of a bodyless POST, so its handler reads
// `input.query.*` and applies the same tolerant parse/clamp the backfills do.

import {
  listCatalogueTracks as listCatalogue,
  getCatalogueSummary,
  rankCatalogue,
} from "../catalogue";
import { crawlCatalogue, DEFAULT_MAX_HOP, getCrawlStatus, MAX_HOP_CEILING } from "../crawl";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer, parseBool, parseLimit } from "./_shared";

// One crawl tick expands this many frontier nodes. Each node is ~1 MusicBrainz request paced
// at ~1 req/s, so 10 is a ~12s tick — comfortably inside the Worker's budget and the cron's
// timeout, with the frontier making the next tick pick up exactly where this one stopped.
const CRAWL_DEFAULT_LIMIT = 10;
const CRAWL_MAX_LIMIT = 50;

/**
 * `maxHop` needs its own parse: `parseLimit` floors at 1, and hop **0** is a legitimate
 * setting — "crawl only the releases ON the seed labels, follow no artist outward". A
 * malformed value degrades to the ratified default rather than 400-ing a cron.
 */
function parseMaxHop(value: string | undefined): number {
  const hop = Number.parseInt(value ?? "", 10);

  if (!Number.isInteger(hop) || hop < 0) {
    return DEFAULT_MAX_HOP;
  }

  return Math.min(hop, MAX_HOP_CEILING);
}

/** Build the `admin-catalogue` domain's handlers. */
export function adminCatalogueHandlers(os: Implementer) {
  // GET /admin/catalogue — the ranked catalogue through one lens, plus the summary.
  const listCatalogueTracksHandler = os.list_catalogue_tracks
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const [tracks, summary] = await Promise.all([
          listCatalogue(input.lens, input.limit),
          getCatalogueSummary(),
        ]);

        return { ok: true, summary, tracks } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/catalogue/rank — one tick of the sweep. `remaining > 0` means run it again.
  const rankCatalogueHandler = os.rank_catalogue.use(adminAuth).handler(async ({ input }) => {
    try {
      return { ok: true, summary: await rankCatalogue(input.limit) } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // POST /admin/catalogue/crawl — one bounded, resumable pass of the crawl.
  const crawlCatalogueHandler = os.crawl_catalogue.use(adminAuth).handler(async ({ input }) => {
    try {
      const { query } = input;
      const pass = await crawlCatalogue({
        dryRun: parseBool(query.dryRun),
        limit: parseLimit(query.limit, CRAWL_DEFAULT_LIMIT, CRAWL_MAX_LIMIT),
        maxHop: parseMaxHop(query.maxHop),
      });

      return { ...pass, ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /admin/catalogue/crawl — the frontier's state.
  const getCrawlStatusHandler = os.get_crawl_status.use(adminAuth).handler(async () => {
    try {
      return { ...(await getCrawlStatus()), ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  return {
    crawl_catalogue: crawlCatalogueHandler,
    get_crawl_status: getCrawlStatusHandler,
    list_catalogue_tracks: listCatalogueTracksHandler,
    rank_catalogue: rankCatalogueHandler,
  };
}
