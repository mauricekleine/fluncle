import { ORPCError } from "@orpc/server";
import {
  type AnchorCandidate,
  anchorTrack,
  AnchorTrackError,
  recordAnchorValidationFailure,
  requeueAnchorStamps,
  requeueIsrcRecoveryStamps,
  resolveAnchorFree,
  resolveAnchorReview,
} from "../anchor";
import {
  getAnchorApifyBudget,
  isAnchorApifyEnabled,
  setAnchorApifyDailyRows,
  setAnchorApifyEnabled,
} from "../anchor-apify";
import {
  anchorSpotifySearchGate,
  isAnchorSpotifySearchEnabled,
  setAnchorSpotifySearchEnabled,
} from "../anchor-spotify-search";
import { resetAppleBreaker } from "../apple-breaker";
import {
  getCatalogueCaptureState,
  setCatalogueCaptureBudget,
  setCatalogueCapturePaused,
} from "../capture-budget";
import {
  countUnverifiedCaptures,
  clearWrongAudio,
  flagWrongAudio,
  forceCapture,
  listCatalogueTracks as listCatalogue,
  getCatalogueSummary,
  listUnverifiedCaptures,
  rankCatalogue,
  requeueUnmatchedCaptures,
  setTrackDismissed,
  verifyCapture,
} from "../catalogue";
import { recordDemand } from "../demand";
import { getSpotifyAnchorBreakerState, resetSpotifyAnchorBreaker } from "../spotify-anchor-breaker";
import { syncTelescopePlaylist } from "../telescope-playlist";
import {
  commitCrawlPhase,
  commitCrawlNodes,
  crawlCatalogue,
  DEFAULT_MAX_HOP,
  fetchCrawlPhase,
  getCrawlStatus,
  initializeCrawlPhase,
  MAX_HOP_CEILING,
  prepareCrawlPhase,
} from "../crawl";
import { adminAuth, operatorGuard } from "../orpc-auth";
import { certifyExistingTrack } from "../publish";
import { apiFault, type Implementer, parseBool, parseLimit } from "./_shared";

const CRAWL_DEFAULT_LIMIT = 10;
const CRAWL_MAX_LIMIT = 60;

function parseMaxHop(value: string | undefined): number {
  const hop = Number.parseInt(value ?? "", 10);

  if (!Number.isInteger(hop) || hop < 0) {
    return DEFAULT_MAX_HOP;
  }

  return Math.min(hop, MAX_HOP_CEILING);
}

function resolveSpotifyTrackId(candidate: {
  spotifyTrackId?: string;
  uri?: string;
  url?: string;
}): string | undefined {
  const direct = candidate.spotifyTrackId?.trim();

  if (direct) {
    return direct;
  }

  const fromUri = candidate.uri?.trim().match(/^spotify:track:([A-Za-z0-9]+)$/)?.[1];

  if (fromUri) {
    return fromUri;
  }

  return candidate.url?.trim().match(/\/track\/([A-Za-z0-9]+)/)?.[1];
}

export function adminCatalogueHandlers(os: Implementer) {
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

  const rankCatalogueHandler = os.rank_catalogue.use(adminAuth).handler(async ({ input }) => {
    try {
      const summary = await rankCatalogue(input.limit, input.countRemaining);

      const telescope = await syncTelescopePlaylist();

      return { ok: true, summary, telescope } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const recordDemandHandler = os.record_demand.use(adminAuth).handler(async () => {
    try {
      return { ok: true, summary: await recordDemand() } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  const listUnverifiedCapturesHandler = os.list_unverified_captures
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const [tracks, queued] = await Promise.all([
          listUnverifiedCaptures(input.limit),
          input.count ? countUnverifiedCaptures() : Promise.resolve(undefined),
        ]);

        return {
          ok: true,
          ...(queued === undefined ? {} : { queued }),
          tracks,
        } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const verifyCaptureHandler = os.verify_capture.use(adminAuth).handler(async ({ input }) => {
    try {
      return { action: await verifyCapture(input.trackId, input.verdict), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

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

  const requeueUnmatchedCapturesHandler = os.requeue_unmatched_captures
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        return { ...(await requeueUnmatchedCaptures()), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const requeueAnchorHandler = os.requeue_anchor
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, requeued: await requeueAnchorStamps(input.trackIds) };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const requeueIsrcRecoveryHandler = os.requeue_isrc_recovery
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { matched, requeued } = await requeueIsrcRecoveryStamps(input);

        return { dryRun: input.dryRun, matched, ok: true as const, requeued };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const flagWrongAudioHandler = os.flag_wrong_audio
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { flagged: await flagWrongAudio(input.trackId), ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const forceCaptureHandler = os.force_capture
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { forced: await forceCapture(input.trackId), ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const certifyTrackHandler = os.certify_track
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { logId } = await certifyExistingTrack(input.trackId, { note: input.note });

        await syncTelescopePlaylist();

        return { logId, ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const setTrackDismissedHandler = os.set_track_dismissed
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const changed = await setTrackDismissed(input.trackId, input.dismissed);

        if (changed) {
          await syncTelescopePlaylist();
        }

        return { changed, ok: true } as const;
      } catch (error) {
        throw apiFault(error);
      }
    });

  const crawlCatalogueHandler = os.crawl_catalogue.use(adminAuth).handler(async ({ input }) => {
    try {
      const phase = input.body;
      if (phase?.phase === "initialize") {
        const { kind, ...initialization } = await initializeCrawlPhase();
        return { initialization, kind, ok: true as const, phase: phase.phase };
      }
      if (phase?.phase === "prepare") {
        return {
          ...(await prepareCrawlPhase({ limit: phase.limit, maxHop: phase.maxHop })),
          ok: true as const,
          phase: phase.phase,
        };
      }
      if (phase?.phase === "fetch") {
        return {
          ...(await fetchCrawlPhase(phase.preparedToken, phase.supplied)),
          ok: true as const,
          phase: phase.phase,
        };
      }
      if (phase?.phase === "commit") {
        return {
          ok: true as const,
          phase: phase.phase,
          receipt: await commitCrawlPhase(phase),
        };
      }

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

  const commitCrawlNodesHandler = os.commit_crawl_nodes
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const { deferred, receipts } = await commitCrawlNodes(input.items);

        return { deferred, ok: true as const, receipts };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const getCrawlStatusHandler = os.get_crawl_status.use(adminAuth).handler(async () => {
    try {
      return { ...(await getCrawlStatus()), ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

  const anchorTrackHandler = os.anchor_track.use(adminAuth).handler(async ({ input }) => {
    try {
      const candidates = input.candidates.flatMap((candidate): AnchorCandidate[] => {
        const spotifyTrackId = resolveSpotifyTrackId(candidate);

        if (!spotifyTrackId) {
          return [];
        }

        return [
          {
            albumImageUrl: candidate.albumImageUrl ?? null,
            artists: candidate.artists.map((artist) => ({
              id: artist.id ?? null,
              name: artist.name,
            })),
            durationMs: candidate.durationMs ?? null,
            isrc: candidate.isrc ?? null,
            spotifyTrackId,
            title: candidate.title,
          },
        ];
      });

      const result = await anchorTrack(input.trackId, candidates);

      return { ...result, ok: true as const };
    } catch (error) {
      if (error instanceof AnchorTrackError) {
        throw new ORPCError(error.reason === "not_found" ? "NOT_FOUND" : "CONFLICT", {
          data: {
            apiCode: error.reason,
            apiMessage: error.message,
          },
          message: error.message,
          status: error.reason === "not_found" ? 404 : 409,
        });
      }

      throw apiFault(error);
    }
  });

  const recordAnchorFailureHandler = os.record_anchor_failure
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return {
          ...(await recordAnchorValidationFailure(input.trackId, input.status)),
          ok: true as const,
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const resolveAnchorHandler = os.resolve_anchor.use(adminAuth).handler(async ({ input }) => {
    try {
      const result = await resolveAnchorFree(input.trackId, new Date(), {
        deezerCandidates: input.deezerCandidates,
        spotifySearch: input.spotifySearch,
      });

      return { ...result, ok: true as const };
    } catch (error) {
      if (error instanceof AnchorTrackError) {
        throw new ORPCError(error.reason === "not_found" ? "NOT_FOUND" : "CONFLICT", {
          data: {
            apiCode: error.reason,
            apiMessage: error.message,
          },
          message: error.message,
          status: error.reason === "not_found" ? 404 : 409,
        });
      }

      throw apiFault(error);
    }
  });

  const resolveAnchorReviewHandler = os.resolve_anchor_review
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const { anchored, review } = await resolveAnchorReview(input.trackId, input.resolution);
        const spotifyTrackId = review.candidate.spotifyTrackId?.trim();

        return {
          anchored,
          ok: true as const,
          review: {
            candidateTitle: review.candidate.title,
            ...(anchored && spotifyTrackId ? { spotifyTrackId } : {}),
          },
        };
      } catch (error) {
        if (error instanceof AnchorTrackError) {
          const missing = error.reason === "not_found" || error.reason === "no_review";

          throw new ORPCError(missing ? "NOT_FOUND" : "CONFLICT", {
            data: { apiCode: error.reason, apiMessage: error.message },
            message: error.message,
            status: missing ? 404 : 409,
          });
        }

        throw apiFault(error);
      }
    });

  const setAnchorSearchHandler = os.set_anchor_search
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        await setAnchorSpotifySearchEnabled(input.enabled);

        return { enabled: await isAnchorSpotifySearchEnabled(), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const setAnchorApifyHandler = os.set_anchor_apify
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        const requeued = await setAnchorApifyEnabled(input.enabled);

        return { enabled: await isAnchorApifyEnabled(), ok: true as const, requeued };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const getAnchorApifyBudgetHandler = os.get_anchor_apify_budget
    .use(adminAuth)
    .handler(async () => {
      try {
        return { ...(await getAnchorApifyBudget()), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const setAnchorApifyBudgetHandler = os.set_anchor_apify_budget
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ...(await setAnchorApifyDailyRows(input.dailyRows)), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const getCaptureBudgetHandler = os.get_capture_budget.use(adminAuth).handler(async () => {
    try {
      return { ...(await getCatalogueCaptureState()), ok: true as const };
    } catch (error) {
      throw apiFault(error);
    }
  });

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

  const getSpotifyAnchorBreakerHandler = os.get_spotify_anchor_breaker
    .use(adminAuth)
    .handler(async () => {
      try {
        const [breaker, apifyBudget, apifyEnabled, spotifySearchEnabled, gate] = await Promise.all([
          getSpotifyAnchorBreakerState(),
          getAnchorApifyBudget(),
          isAnchorApifyEnabled(),
          isAnchorSpotifySearchEnabled(),
          anchorSpotifySearchGate(new Date()),
        ]);

        return {
          ...breaker,
          ok: true as const,
          rungs: {
            apifyBudget,
            apifyEnabled,
            gateReason: gate.reason,
            nextEligibleAt: gate.nextEligibleAt,
            spotifySearchEnabled,
          },
        };
      } catch (error) {
        throw apiFault(error);
      }
    });

  const resetSpotifyAnchorBreakerHandler = os.reset_spotify_anchor_breaker
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        return { ...(await resetSpotifyAnchorBreaker()), ok: true as const };
      } catch (error) {
        throw apiFault(error);
      }
    });

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
    anchor_track: anchorTrackHandler,
    certify_track: certifyTrackHandler,
    clear_wrong_audio: clearWrongAudioHandler,
    commit_crawl_nodes: commitCrawlNodesHandler,
    crawl_catalogue: crawlCatalogueHandler,
    flag_wrong_audio: flagWrongAudioHandler,
    force_capture: forceCaptureHandler,
    get_anchor_apify_budget: getAnchorApifyBudgetHandler,
    get_capture_budget: getCaptureBudgetHandler,
    get_crawl_status: getCrawlStatusHandler,
    get_spotify_anchor_breaker: getSpotifyAnchorBreakerHandler,
    list_catalogue_tracks: listCatalogueTracksHandler,
    list_unverified_captures: listUnverifiedCapturesHandler,
    rank_catalogue: rankCatalogueHandler,
    record_anchor_failure: recordAnchorFailureHandler,
    record_demand: recordDemandHandler,
    requeue_anchor: requeueAnchorHandler,
    requeue_isrc_recovery: requeueIsrcRecoveryHandler,
    requeue_unmatched_captures: requeueUnmatchedCapturesHandler,
    reset_apple_breaker: resetAppleBreakerHandler,
    reset_spotify_anchor_breaker: resetSpotifyAnchorBreakerHandler,
    resolve_anchor: resolveAnchorHandler,
    resolve_anchor_review: resolveAnchorReviewHandler,
    set_anchor_apify: setAnchorApifyHandler,
    set_anchor_apify_budget: setAnchorApifyBudgetHandler,
    set_anchor_search: setAnchorSearchHandler,
    set_capture_budget: setCaptureBudgetHandler,
    set_track_dismissed: setTrackDismissedHandler,
    verify_capture: verifyCaptureHandler,
  };
}
