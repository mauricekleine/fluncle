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
//   THE CAPTURE BUDGET (../capture-budget.ts) — the brake on what the two above lead to:
//   - `get_capture_budget` — the spend readout (agent-allowed read).
//   - `set_capture_budget` — the caps + the kill switch. OPERATOR tier, the one op here that
//     is: the crawler and the Ear are free, and this one spends money.
//
// WHY EVERY OTHER OP HERE IS AGENT-ALLOWED AND NOT OPERATOR-TIER. None of them can certify.
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

import { resetAppleBreaker } from "../apple-breaker";
import {
  getCatalogueCaptureState,
  setCatalogueCaptureBudget,
  setCatalogueCapturePaused,
} from "../capture-budget";
import {
  clearWrongAudio,
  listCatalogueTracks as listCatalogue,
  getCatalogueSummary,
  rankCatalogue,
  setTrackDismissed,
} from "../catalogue";
import { crawlCatalogue, DEFAULT_MAX_HOP, getCrawlStatus, MAX_HOP_CEILING } from "../crawl";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { certifyExistingTrack } from "../publish";
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

  // POST /admin/catalogue/wrong-audio/clear — OPERATOR tier. Overrule the wrong-audio quarantine
  // on one row (docs/the-ear.md § Wrong audio): an agent does not get to reverse the machine's own
  // wrong-audio verdict, the same reasoning that keeps `update_label` and `set_capture_budget`
  // operator-tier. Idempotent: `cleared: false` when the row was not actually quarantined.
  const clearWrongAudioHandler = os.clear_wrong_audio
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { cleared: await clearWrongAudio(input.trackId), ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/catalogue/certify — OPERATOR tier. Certify an existing catalogue row in place:
  // mint its finding, without creating a new track (docs/the-ear.md § The operator's actions).
  // Operator-only because certifying is the one act the domain forbids a machine — the agent-tier
  // sweep is agent-allowed precisely because it can never certify. Returns the minted Log ID.
  const certifyTrackHandler = os.certify_track
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { logId } = await certifyExistingTrack(input.trackId, { note: input.note });

        return { logId, ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  // PUT /admin/catalogue/dismissed — OPERATOR tier. The "not for me" / restore toggle
  // (docs/the-ear.md § The operator's actions): dismissing steers what the telescope keeps
  // pointing at and what the capture ladder may buy — a taste ruling, the `update_label` class,
  // so an agent may never fire it. `changed: false` when the row was already in that state.
  const setTrackDismissedHandler = os.set_track_dismissed
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return {
          changed: await setTrackDismissed(input.trackId, input.dismissed),
          ok: true,
        } as const;
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

  // GET /admin/catalogue/capture-budget — the spend readout. Admin tier (agent-allowed READ,
  // the `get_crawl_status` precedent): reading what a budget has left publishes nothing and
  // spends nothing, and the box's sweeps are entitled to know why the queue went quiet.
  const getCaptureBudgetHandler = os.get_capture_budget.use(adminAuth).handler(async () => {
    try {
      return { ...(await getCatalogueCaptureState()), ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  // PUT /admin/catalogue/capture-budget — OPERATOR tier, and the only op in this domain that
  // is. Every other one is free (the crawler moves metadata, the Ear moves vectors); this one
  // decides how much of the operator's money a metered proxy may spend. An agent does not get
  // to raise its own budget — the `set_publish_advance` shape, on the same `settings` KV.
  //
  // It returns the FULL state rather than an echo of the input, so one call both writes and
  // reads back: the operator (or the CLI) sees the new verdict — open or shut, and why —
  // computed by the same code path the capture queue obeys.
  const setCaptureBudgetHandler = os.set_capture_budget
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        if (input.paused !== undefined) {
          await setCatalogueCapturePaused(input.paused);
        }

        if (input.dailyBytes !== undefined || input.dailyTracks !== undefined) {
          await setCatalogueCaptureBudget({
            dailyBytes: input.dailyBytes,
            dailyTracks: input.dailyTracks,
          });
        }

        return { ...(await getCatalogueCaptureState()), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  // POST /admin/catalogue/apple-breaker/reset — OPERATOR tier. Clear the cross-cutting Apple
  // failure-regime breaker once the token is fixed. Operator tier, the `set_capture_budget`
  // neighbour's rule: a machine does not get to silently re-arm a spend-adjacent external
  // integration it just tripped.
  const resetAppleBreakerHandler = os.reset_apple_breaker
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        return { ...(await resetAppleBreaker()), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  return {
    certify_track: certifyTrackHandler,
    clear_wrong_audio: clearWrongAudioHandler,
    crawl_catalogue: crawlCatalogueHandler,
    get_capture_budget: getCaptureBudgetHandler,
    get_crawl_status: getCrawlStatusHandler,
    list_catalogue_tracks: listCatalogueTracksHandler,
    rank_catalogue: rankCatalogueHandler,
    reset_apple_breaker: resetAppleBreakerHandler,
    set_capture_budget: setCaptureBudgetHandler,
    set_track_dismissed: setTrackDismissedHandler,
  };
}
