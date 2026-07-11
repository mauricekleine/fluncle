// The `admin-catalogue` domain router module — THE EAR (docs/the-ear.md). Two ops, both
// `adminAuth` (operator OR agent):
//
//   - `list_catalogue_tracks` — the ranked read. An ordered walk of a precomputed column;
//     no vector math on the request path.
//   - `rank_catalogue` — one tick of the precompute sweep, the job a periodic `--no-agent`
//     cron drives with the box's agent token.
//
// WHY THE SWEEP IS AGENT-ALLOWED AND NOT OPERATOR-TIER. It writes only DERIVED ranking
// columns, and only on CATALOGUE rows (`tracks` with no `findings` row). It cannot mint a
// coordinate, write a note, certify anything, or touch a finding — the columns for that do
// not exist on the rows it can reach. That makes it a machine job like `update_galaxy_map`,
// not an editorial act like `update_galaxy` (which an agent token 403s on, correctly).

import {
  listCatalogueTracks as listCatalogue,
  getCatalogueSummary,
  rankCatalogue,
} from "../catalogue";
import { adminAuth } from "../orpc-auth";
import { apiFault, type Implementer } from "./_shared";

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

  return {
    list_catalogue_tracks: listCatalogueTracksHandler,
    rank_catalogue: rankCatalogueHandler,
  };
}
