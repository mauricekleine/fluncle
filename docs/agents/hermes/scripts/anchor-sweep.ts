#!/usr/bin/env bun
// anchor-sweep.ts — the bun orchestrator behind the CATALOGUE SPOTIFY-ANCHOR cron (`fluncle-anchor`),
// scheduled by a rave-02 HOST systemd timer (../anchor-timer/).
//
// WHY THIS EXISTS. A catalogue track (a `tracks` row with no `findings` row) is resolved from
// MusicBrainz, so it may land with no Spotify presence — the nullable `spotify_uri`/`spotify_url`.
// Filling that anchor used to run IN THE WORKER against the official dev-mode Spotify app, and at
// catalogue scale it starved under sustained 429s (the official app must stay for user-facing paths
// — adds, publish, the Frontier playlist mints). So ALL catalogue anchor-filling moved onto THIS
// box sweep. See docs/catalogue-crawler.md § the anchor.
//
// THE RESOLVER WATERFALL (slices 1-2). Apify used to be the SOLE candidate source, so an Apify outage
// stopped anchoring dead. This sweep runs a waterfall per row, all resolved through ONE `resolve_anchor`
// call the box makes FIRST: the FREE ListenBrainz rung, then — when the server's dark flag
// `anchor_spotify_search_enabled` is on (slice 2) — the free Spotify SEARCH rungs (exact ISRC, then
// fuzzy), and the metered Apify search only as the LAST resort. Any earlier hit spends no Apify money,
// and when Apify is down the free rungs still anchor their share (graceful degradation). The Spotify
// rungs share the official app with user-facing mints, so the box PACES them under a 60/min ceiling
// (`spotifySearchPaceMs`); when the flag is off they never run and the sweep is exactly slice 1.
//
// AND THE SPOTIFY RUNGS COME BACK AS A SUBORDINATE. The flag stays the operator's kill-switch, but
// what it now unleashes is metered by three TICK-level guards this driver owns, because each is a
// property of a whole tick that no single `resolve_anchor` call can see:
//   · the EXACT-ISRC ASK BUDGET (`FLUNCLE_ANCHOR_ISRC_ASK_LIMIT`, 25/tick) — the Class-B lever,
//   · the NIGHT WINDOW (`FLUNCLE_ANCHOR_ISRC_WINDOW_UTC`, `"0-8"`) — never over publishing hours,
//   · the YIELD LAW — ANY 429 in the anchor path ends the tick's remaining Spotify asks. A throttle
//     is PASS-ENDING and never ROW-FAILING: the deferred rows stamp nothing and keep their turn.
// Each is expressed as `spotifySearch: false` on the rows it covers — a request field the server ANDs
// into its own gate, so the box can only ever ask for LESS and never talk the rungs into running.
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (anchor-sweep.sh) the host timer
// docker-execs — see that file's header for the wire-up and ../anchor-timer/README.md for the
// operator runbook (and the cost math).
//
// ── THE LOOP, per tick ───────────────────────────────────────────────────────────────────────
//   (a) FETCH the anchor worklist from the Worker with the box's AGENT token
//       (`GET /api/v1/admin/tracks/work?kind=anchor`). Each row carries a ready-made `anchorQuery`
//       (the row's artists + title) so this driver stays dumb and never builds the query — and an
//       ISRC-LESS row also carries a ready-made `deezerQuery` (the server's one Deezer spelling), which is
//       the server asking for the search in (b0).
//   (b0) DEEZER ISRC RECOVERY, the one fetch this box makes on its OWN account. Deezer's public search
//       takes no token, so its quota is per-IP: from Cloudflare's shared edge it recovered 0 ISRCs out
//       of 5,133 ISRC-less rows over 3 days, while this box's dedicated IP answered 25/25 clean. So the
//       SEARCH runs here and the hits ride the `resolve_anchor` call as `deezerCandidates`. The
//       VERIFICATION and the ISRC write did NOT move — the Worker re-runs the row's identity fold +
//       duration window over these hits and writes fill-empty-only, exactly as when it held the search.
//       A failed search sends an empty list (never a re-ask from the dead edge) and is tallied as
//       `deezerSearchFailed`, so a box that goes quota-blind shows on the first tick.
//   (b) FREE RUNG next: POST each row's trackId (+ those Deezer hits) to `resolve_anchor`. The WORKER
//       resolves a ListenBrainz candidate (recording MBID → Spotify ids, no auth) + one by-id Spotify
//       metadata read, verifies it against the SAME gate, and on a hit writes the anchor for free. A
//       hit here means this row NEVER reaches the paid Apify rung.
//   (b1) THE ADMISSION GATE. A free-rung miss is not automatically a paid ask. The Worker decides
//       whether each row may cost money (`apifyEligible`) and the box obeys: an ISRC-bearing row is
//       admitted only once the FREE exact-ISRC rung actually asked Spotify about it and missed, and
//       any row is refused once the day's row cap is spent. A refused row settled nothing, so it is
//       `deferred` and keeps its turn — never `missed`.
//   (c) APIFY FALLBACK, over the ADMITTED free-rung misses only: RUN the Apify actor once per chunk of
//       queries (`run-sync-get-dataset-items`), GROUP its flat result array by `target` (the query),
//       map each to a candidate, and POST each row's candidates to `anchor_track`.
//       BUT the operator kill-flag `anchor_apify_enabled` (default ON) gates this whole step: when it
//       is OFF (out of Apify budget), `resolve_anchor` reports `apifyEnabled:false` on every verdict AND
//       has already PARKED each row it could settle, so the sweep SKIPS the actor loop entirely (zero
//       wasted 403s) and counts by the server's own `stamped`: parked rows are `missed`, rows that
//       kept their turn are `deferred`, a thrown free rung is `skipped`.
//   The WORKER re-runs the full verification on BOTH rungs (no source's match is EVER trusted) and,
//   on a hit, writes the anchor. Every FULL attempt stamps the row's re-ask backoff (a free-rung
//   miss does NOT — it leaves the Apify rung its turn — UNLESS Apify is disabled, when the free rung
//   backs the row off itself), so a missed row is not re-billed for weeks.
//
// AND THE TICK SAYS WHAT IT COULD NOT DO. With the Apify fallback OFF and the dark Spotify-search
// flag OFF, no rung in the waterfall can CONCLUDE about a row: the free ListenBrainz rung still runs
// and can win, but its miss is not a verdict. Such a tick reports `reason: "no_capable_rung"` rather
// than reading as a healthy empty run, and `missed` is reserved for rows the server actually retired.
//
// THE BOX DEPENDS ON NO NEW CLI COMMAND. The baked `fluncle` CLI is a PINNED release, so this
// sweep calls the oRPC HTTP endpoints DIRECTLY with the agent token (the verify-captures.ts
// precedent), never a `fluncle admin …` subcommand that a pin might not carry. No new secret and no
// new timer: the free rung rides the same agent token, base URL, and host timer as the Apify rung.
//
// COST. ~$0.005 per Apify result item → ~$0.015/row at searchKeywordLimit 3 — but ONLY on the rows
// the free rung ASKED ABOUT and missed, under a server-side daily row cap (`anchor_apify_daily_rows`,
// default 300). The firing reads that cap and the two rung flags ONCE up front (`readPreflight`) and
// pulls NOTHING when nothing it pulled could conclude: outside the night window with the paid rung
// armed, or once the day's cap is spent. Every query it does send is the free-text `anchorQuery` —
// there is no ISRC query shape here, so `searchKeywordLimit` stays at 3 (the gate needs candidates). A 2026-07-30 sample of 20 REAL anchor-worklist MBIDs found 11 mapping rows and
// 4 non-empty Spotify id lists: ~20% carried a free candidate. The realised anchor rate is measured,
// never assumed, by the per-outcome `lb*` counters below. Pause = stop the timer. Attended burn =
// `--limit N`. Full cost math: ../anchor-timer/README.md.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import {
  DUE_WORK_REPAIR_PENDING_REASON,
  type DueWorkRepairPendingGate,
  dueWorkRepairPendingGate,
  failureBodyUnlessRepairPending,
  isDueWorkRepairPending,
  throwIfPageRepairPending,
} from "./due-work-repair-pending";

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the secrets on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

// The Apify token — the ONLY new secret this sweep needs. Referenced by ENV NAME only; the
// concrete op:// path lives in the private companion + the timer README's activation section.
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN ?? "";

// The working actor (verified live 2026-07-18). Overridable for a pinned/forked actor id.
const APIFY_ACTOR = process.env.FLUNCLE_ANCHOR_ACTOR ?? "musicae~spotify-extended-scraper";

/** Rows per tick. Small on purpose — each is a billed Apify search (~$0.015). `--limit` overrides it. */
const BATCH = Number(process.env.FLUNCLE_ANCHOR_BATCH ?? "15");
// One worklist READ is capped server-side (the contract's `limit` max is 250 and the Worker clamps
// harder to MAX_WORK_LIMIT = 200), so a BATCH above the cap MUST page: `runAnchorSweep` pulls
// ≤PAGE_LIMIT rows per fetch until the batch is spent or the queue runs dry. Rows leave the window
// via their attempt stamps, so consecutive pages never re-pull the same rows within a sweep.
const PAGE_LIMIT = 200;

/** Queries per Apify run-sync call — chunked so a big `--limit` burn never one-shots a giant run. */
const APIFY_QUERY_CHUNK = Number(process.env.FLUNCLE_ANCHOR_APIFY_CHUNK ?? "15");

/** The actor's per-query candidate cap — the pilot-verified value; more candidates = more spend. */
const SEARCH_KEYWORD_LIMIT = Number(process.env.FLUNCLE_ANCHOR_KEYWORD_LIMIT ?? "3");

// ── THE SPOTIFY SEARCH RUNGS' THREE TICK-LEVEL GUARDS (the subordinate-consumer contract) ─────────
//
// The dark flag `anchor_spotify_search_enabled` stays THE operator kill-switch and lives on the
// server; nothing here can turn the rungs on. What lives HERE is what a tick knows and a single
// `resolve_anchor` call cannot: how many exact-ISRC asks this tick has already spent, what hour it
// is, and whether Spotify has thrown a 429 at us since the tick began. Each is sent as
// `spotifySearch: false` on the rows it covers — a request field the server ANDs into its own gate,
// so the box can only ever ask for LESS.
//
// The reason all three exist: the rungs draw on the ONE official Spotify app that also serves
// publishing and user playlist flows, and a sustained sweep DID starve it (2026-07-18), which is why
// they went dark in the first place. They come back as the app's SUBORDINATE consumer or not at all.

/**
 * The tick's ceiling on EXACT-ISRC asks (`findSpotifyTrackByIsrc`) — the Class-B lever, and the only
 * Spotify ask worth metering by count because it is the one with a real hit rate. 25 an hour is a
 * trickle by design: it drains the 5,141-row exact-ISRC backlog over weeks while never being the
 * reason a publish waits. Once it is spent the whole Spotify leg is deferred for the rest of the
 * tick (the box can only defer the leg, not one rung of it), which is the conservative direction.
 */
const ISRC_ASK_LIMIT = Number(process.env.FLUNCLE_ANCHOR_ISRC_ASK_LIMIT ?? "25");

/**
 * The NIGHT WINDOW, as UTC hours `start-end` (end EXCLUSIVE — the `FRONTIER_REFRESH_GATE_END_HOUR`
 * convention). `"0-8"` = 00:00–08:00 UTC, which sits clear of publishing hours and of when anyone is
 * actually listening. EMPTY = always allowed. A wrapping window (`"22-6"`) is understood. An
 * unreadable value DENIES — the same default-deny discipline the breaker reads by, since the cost of
 * being wrong is a paused optional sweep rather than a starved user-facing path.
 */
const ISRC_WINDOW_UTC = process.env.FLUNCLE_ANCHOR_ISRC_WINDOW_UTC ?? "0-8";

/**
 * THE DAY FREE-RUNGS ESCAPE HATCH. `1` makes a firing that would otherwise pull NOTHING (see
 * {@link AnchorPreflight}) instead pull its batch and run ONLY the free rungs, with the Apify leg
 * skipped and every row keeping its turn.
 *
 * It is DEFAULT OFF because the free rungs currently win nothing on this queue by day: with both
 * rungs armed, ListenBrainz mapped 0 of 3,092 rows across 18 ticks, and the Deezer ISRC-recovery
 * rung has its OWN hourly `fluncle-isrc-recovery` sweep that does not depend on this firing at all.
 * So the day gate costs ~nothing today and saves the whole daytime re-read of a queue head that
 * cannot conclude. The knob exists because "~nothing" is a measurement, not a law: if
 * `anchoredByListenbrainz` or `isrcRecoveredByDeezer` ever start moving on this sweep, this reverses
 * the tradeoff with an env change and a restart — no deploy, no rebake.
 */
const DAY_FREE_RUNGS = process.env.FLUNCLE_ANCHOR_DAY_FREE_RUNGS === "1";

/** This host timer runs hourly. Emitted so the run ledger judges freshness against the real cadence. */
const ANCHOR_EXPECTED_INTERVAL_MS = 60 * 60 * 1000;

const log = (message: string) => console.error(`[anchor-sweep] ${message}`);

// ── Types ────────────────────────────────────────────────────────────────────

/** One row of the anchor worklist (only the fields this sweep consumes). */
export type AnchorWorkItem = {
  anchorQuery?: string;
  /**
   * The ready-made DEEZER search query (Deezer's `artist:"…" track:"…"` FIELD syntax — a DIFFERENT
   * spelling from `anchorQuery`'s free text, which is why the server builds both). Present ONLY for a
   * row with no ISRC: its presence IS the instruction to run the rung-0 ISRC-recovery search from this
   * box's IP. Absent ⇒ this row needs no Deezer search and none is spent.
   */
  deezerQuery?: string;
  trackId?: string;
};

/**
 * One Deezer search hit, normalized to the four fields `resolve_anchor`'s rung-0 gate reads. The box
 * NORMALIZES; it never judges — the Worker re-runs the row's identity fold + duration window over
 * these and writes an ISRC only on a hard match, exactly as it did when it held the search itself.
 */
export type DeezerCandidatePayload = {
  /** Deezer's BILLED artist string (e.g. `"Fred V & Grafix"`) — the Worker folds it into a set. */
  artistName: string;
  /**
   * Deezer's own track id for the hit, when the response carried one. Passed through, never judged:
   * the gate does not read it, and the Worker keeps it only for a hit that CLEARS the gate, as that
   * recording's Deezer link. A hit without one still recovers its ISRC.
   */
  deezerTrackId?: string;
  /** Deezer bills seconds; promoted here so the Worker's ms window compares in one unit. */
  durationMs: number;
  isrc: string;
  title: string;
};

/** One credited artist on an Apify candidate. */
type ApifyArtist = { artist_id?: string; artist_name?: string };

/** One item in the actor's flat result array — one (query, rank) pair. */
export type ApifyResultItem = {
  albums?: { album_image?: string }[];
  artists?: ApifyArtist[];
  error?: null | string;
  success?: boolean;
  target?: string;
  tracks?: {
    track_duration_ms?: number;
    track_id?: string;
    track_image?: string;
    track_isrc?: string;
    track_name?: string;
    track_uri?: string;
    track_url?: string;
  }[];
};

/** One candidate in the `anchor_track` request body. */
export type AnchorCandidatePayload = {
  albumImageUrl?: null | string;
  artists: { id?: null | string; name: string }[];
  durationMs?: null | number;
  isrc?: null | string;
  spotifyTrackId: string;
  title: string;
};

export type AnchorVerdict = {
  anchored: boolean;
  /**
   * Rows the paid rung may still be sent TODAY under the server's daily cap, as it stands after this
   * call's own authorisation. Reported, never enforced here — the Worker charges and refuses.
   */
  apifyBudgetRemaining?: number;
  /**
   * THE PAID RUNG'S ADMISSION VERDICT for this row, from the server. FALSE ⇒ do NOT send it to the
   * actor: the free exact-ISRC rung has not asked Spotify about it yet (so the paid rung would be
   * buying an answer the free one gives away), or the day's row cap has no room. Such a row keeps its
   * turn — it is `deferred`, never `missed`.
   *
   * Optional, and ABSENT DEFAULTS TO TRUE: a pre-rule server has no admission rule to report, and the
   * sweep must not invent one on its behalf.
   */
  apifyEligible?: boolean;
  /** Why `apifyEligible` is false, or null. Drives which deferral counter the tick bumps. */
  apifyIneligibleReason?: "apify_budget_spent" | "awaiting_free_ask" | null;
  /**
   * The `anchor_apify_enabled` operator kill-flag (default ON) as `resolve_anchor` read it — a GLOBAL
   * flag, so every verdict in a tick agrees. FALSE ⇒ Apify is out of budget: the sweep skips the whole
   * Apify actor loop, and the server already stamped-and-backed-off each full-miss row (slice 3).
   * Optional / defaults true on the box (a pre-slice-3 server omits it ⇒ current Apify-runs behaviour).
   */
  apifyEnabled?: boolean;
  /** Worker-counted free-rung candidates that arrived without a numeric duration. */
  freeDurationMsOmitted?: number;
  /** True iff `resolve_anchor` recovered a verified ISRC from Deezer into an ISRC-less row this call. */
  isrcRecoveredByDeezer?: boolean;
  /** The free ListenBrainz rung's terminal outcome — optional only for an older server during rollout. */
  listenbrainzOutcome?:
    | "anchored"
    | "empty-ids"
    | "gate-rejected"
    | "metadata-failed"
    | "no-map"
    | "no-mbid"
    | "not-attempted"
    | "request-failed"
    | "yielded-on-breaker";
  /** Which free rung anchored (`resolve_anchor` only) — drives the per-rung tally. Null on the Apify path. */
  source?: "listenbrainz" | "spotify-isrc" | "spotify-search" | null;
  /** True iff an EXACT-ISRC search was spent — the unit this tick's ask budget meters. */
  spotifyIsrcAsked?: boolean;
  /** True iff `resolve_anchor` issued a Spotify SEARCH this call — the box's pacer signal (slice 2). */
  spotifySearchDone?: boolean;
  /**
   * The `anchor_spotify_search_enabled` dark flag (default OFF) as the server read it — the FLAG, not
   * the window/breaker/meter gate over it. With `apifyEnabled` also false, NO rung in the waterfall
   * can conclude about a row, which is what {@link AnchorSummary.reason} reports. Optional: an older
   * server omits it, and the tick then simply never claims a capability verdict it cannot know.
   */
  spotifySearchEnabled?: boolean;
  /**
   * True iff a Spotify call in the server's anchor path came back 429. THE YIELD LAW: one of these
   * ends every remaining Spotify ask in the tick — a throttle is pass-ending, never row-failing.
   */
  spotifyThrottled?: boolean;
  /**
   * True iff the server PARKED this row on its re-ask backoff. `!anchored && !stamped` is the one
   * honest test for "this row is coming back", and the only way the tick can tell a retired row from
   * one it merely re-read: a caller-deferred row settles nothing, so counting it as `missed` reports
   * a queue draining that is standing still. Optional: an older server omits it, and the tick falls
   * back to the pre-existing assumption that a full miss under a disabled Apify rung was stamped.
   */
  stamped?: boolean;
  /**
   * Which gate rung matched. `search-subset` is the ±1s proper-subset fallback — a DIFFERENT
   * confidence from `search`, which is why the server persists them apart. The tally below folds it
   * in with `search` (both are the verified-search gate), but the union must carry it or a future
   * `switch` here would silently mis-read a real verdict.
   */
  verifiedBy: "isrc" | "search" | "search-subset" | null;
};

/**
 * One rung-0 Deezer search's result: the hits that carried all four gate signals, plus how many the
 * response held that did NOT and so were withheld. The count exists because the drop used to be
 * invisible — an all-unusable response and an empty one both reached the Worker as `[]`.
 */
export type DeezerSearchResult = {
  candidates: DeezerCandidatePayload[];
  /** Hits dropped for a missing ISRC / title / artist / positive duration. */
  droppedIncomplete: number;
};

/**
 * THE TICK PREFLIGHT — which rungs are armed and what the paid one has left, read ONCE per firing
 * from `get_spotify_anchor_breaker` before a single worklist row is pulled.
 *
 * It exists because of what the admission rule changed about an out-of-window tick. The paid rung is
 * now admitted only after the FREE exact-ISRC rung asked about a row, and that rung is metered by
 * this sweep's own night window and per-tick ask budget — so outside the window a tick can conclude
 * nothing about the ISRC-bearing rows that lead the worklist. It would pull the same head hour after
 * hour, re-ask ListenBrainz the same question it already answered, and retire nothing: the churn PR
 * #1385 removed for the both-rungs-off case, walking back in wearing a new state.
 *
 * So the tick asks first, and pulls nothing when nothing it pulled could conclude. The rows keep
 * their turn and the night window — which is wider (8h) than the deferral is long — reaches them.
 */
export type AnchorPreflight = {
  apifyBudgetRemaining: number;
  apifyBudgetSpent: boolean;
  apifyEnabled: boolean;
  spotifySearchEnabled: boolean;
};

/** One counted worklist read: the page itself plus the real whole-queue depth before the page runs. */
export type AnchorQueuePage = {
  queueDepth: number;
  rows: AnchorWorkItem[];
};

/** One tick's honest tally — the JSON summary line. */
export type AnchorSummary = {
  /** Failed Apify actor CHUNKS — the paid rung's failure denominator, never last-write-wins. */
  apifyActorErrors: number;
  /** Rows the server's daily cap had no room for. They keep their turn; tomorrow's tick buys them. */
  apifyBudgetSkipped: number;
  /**
   * WHICH RUNGS THIS FIRING DID NOT RUN, named rather than inferred. A firing that pulls nothing
   * reports `checked: 0` and settles nothing, which on its own reads like an empty queue; a reader a
   * year from now must be able to see that the ListenBrainz and Deezer rungs were skipped too, not
   * just the paid one. Empty on an ordinary firing.
   */
  rungsSkipped: string[];
  /**
   * Rows the paid rung may still be sent today, as the last verdict (or the preflight) reported it.
   * Null when nothing in this firing asked. The ledger's answer to "how much of the day is left".
   */
  apifyBudgetRemaining: null | number;
  /** Result ITEMS the actor returned — the unit Apify bills, so the unit the ledger must carry. */
  apifyResults: number;
  /** Rows actually POSTed to `anchor_track`, i.e. rows the actor was actually run for. */
  apifyRowsSent: number;
  /**
   * Rows held back from the paid rung because the FREE exact-ISRC rung has not asked Spotify about
   * them yet — the admission rule doing its job. They are `deferred`, never `missed`: nothing was
   * asked, so nothing was settled. A large value beside a small `spotifyIsrcAsks` is the tell that
   * the ask budget or the night window, not the catalogue, is the bottleneck.
   */
  apifySkippedAwaitingSpotify: number;
  /**
   * Rows whose query the Apify dataset came back WITHOUT — the actor returned, but no item carried
   * this row's `target`. Those rows are POSTed an empty candidate list, so the Worker stamps a clean
   * miss and backs the row off for `ANCHOR_REASK_AFTER_DAYS`, indistinguishable in every existing
   * number from "Spotify genuinely has nothing". That is the BLACKOUT class: a row the actor never
   * actually answered for, retired as though it had. Counted here so the class has a size before
   * anything is done about it — this slice deliberately changes NO stamping behaviour, it measures.
   */
  apifyTargetOmitted: number;
  /**
   * Apify CANDIDATES that arrived WITHOUT a numeric `durationMs` — the actor's item carried no
   * `track_duration_ms`, so `itemToCandidate` normalized it to `null`. The Worker's verified-search
   * gate hard-requires a numeric duration, so for an ISRC-less row such a candidate is a GUARANTEED
   * silent drop, indistinguishable in every miss number from "the gate judged it and said no" —
   * an actor payload class that omits durations zeroes the whole search gate while the exact-ISRC
   * rung runs at full strength. Counted per CANDIDATE at the point the candidates are handed to the
   * Worker, so the class has a size; the POST and the stamping are deliberately unchanged.
   */
  apifyDurationMsOmitted: number;
  /** Rows anchored by the Apify FALLBACK via the exact-ISRC gate. */
  anchoredByIsrc: number;
  /** Rows anchored by the FREE ListenBrainz rung — the waterfall's cheapest win (no Apify spent). */
  anchoredByListenbrainz: number;
  /** Rows anchored by the Apify FALLBACK via the verified-search gate. */
  anchoredBySearch: number;
  /** Rows anchored by the DARK Spotify ISRC-search rung (slice 2 — free of Apify, flag-gated). */
  anchoredBySpotifyIsrc: number;
  /** Rows anchored by the DARK Spotify fuzzy-search rung (slice 2 — free of Apify, flag-gated). */
  anchoredBySpotifySearch: number;
  /** Canonical run-ledger denominator: worklist rows this tick actually inspected. */
  checked: number;
  /**
   * Rows whose BOX-SIDE Deezer search failed outright — a network error, a non-2xx, a malformed body,
   * or a quota answer that outlasted the retries. Reported because the fetch now lives HERE: the
   * Worker's `deezer.search-quota-exhausted` log no longer fires for a sweep row, so without this
   * number a box that has gone quota-blind would look exactly like a catalogue Deezer has never heard
   * of. Those rows resolve normally, just unhelped (no ISRC recovered).
   */
  deezerSearchFailed: number;
  /**
   * Deezer HITS dropped before they were sent, for missing one of the four signals the Worker's gate
   * reads (ISRC, title, artist, a positive duration). The drop is right — an unverifiable hit is not
   * evidence — but until now it was silent: a search that returned five unusable hits reached the
   * Worker as the same empty array a search that found nothing does, so a systematic upstream change
   * (Deezer dropping `isrc` from search results, say) would read as "this catalogue is not on Deezer".
   * Counted per HIT, not per row, so the number is the size of what was withheld.
   */
  deezerHitsDroppedIncomplete: number;
  /** The first run-failure message for diagnosis; item diagnostics stay in their counters/logs. */
  error: null | string;
  /** Run-level failures only: the sweep could not do its job and exits non-zero. */
  errors: number;
  /** The timer's real hourly cadence, for run-ledger freshness. */
  expectedIntervalMs: number;
  /** Individual row/rung failures that did not prevent the run from continuing. */
  failed: number;
  /** Worker-counted free-rung candidates that arrived without a numeric duration. */
  freeDurationMsOmitted: number;
  /**
   * Free-rung (`resolve_anchor`) calls that THREW. Counted UNCONDITIONALLY, because it is the tell
   * that a rung is broken: with Apify enabled these rows fall silently through to the paid fallback
   * and anchoring looks healthy, which is exactly how a dead free rung once stayed invisible for a
   * week. Not part of `pulled` — a thrown call is already counted by whatever the row ends up as.
   */
  freeRungErrors: number;
  /** Rows whose ISRC was recovered from Deezer's free oracle before anchoring (the recovery rate). */
  isrcRecoveredByDeezer: number;
  /** ListenBrainz returned a mapped row, but its Spotify id list had no usable ids. */
  lbEmptyIds: number;
  /** ListenBrainz supplied a Spotify candidate that the shared identity gate rejected. */
  lbGateRejected: number;
  /** ListenBrainz supplied a candidate, but the required Spotify by-id metadata read failed. */
  lbMetadataFailed: number;
  /** The row had no usable recording MBID, so the ListenBrainz request was not made. */
  lbNoMbid: number;
  /** ListenBrainz had no mapping row for the recording MBID. */
  lbNoMap: number;
  /** The ListenBrainz rung could not run because the track itself was not available to resolve. */
  lbNotAttempted: number;
  /** ListenBrainz request/response failures (throw, non-2xx, malformed JSON, or non-array body). */
  lbRequestFailed: number;
  /**
   * Rows where the ListenBrainz rung DECLINED to spend its by-id Spotify read because the shared-app
   * throttle breaker was tripped. Its own counter rather than more `lbMetadataFailed`, because the
   * two mean opposite things: a failure is the rung breaking, a yield is the rung working. This is
   * the number that used to hide inside `lbMetadataFailed` during Spotify's throttle windows and made
   * a healthy rung under backpressure look like a dead one. NOT a `failed` — nothing went wrong.
   */
  lbYieldedOnBreaker: number;
  /** Rows that verified nothing on ANY rung (a clean full miss — stamped, backed off). */
  missed: number;
  ok: boolean;
  /** Canonical run-ledger numerator: rows whose Spotify anchor was actually written. */
  produced: number;
  /** Canonical real backlog left after this tick; null only when the queue read itself failed. */
  queueDepth: null | number;
  /**
   * Rows the server returned a verdict on that it did NOT anchor and did NOT park — they keep their
   * turn and the next tick reads them again. Its own counter because `missed` means RETIRED (stamped,
   * backed off) and folding the two together is how a tick that moved the queue not one row read as a
   * tick that cleared 250: the queue depth never falls, and nothing in the summary says why.
   */
  deferred: number;
  /**
   * Why this tick could settle nothing, or null when that is not the story.
   * `"no_capable_rung"` — rows were pulled and NOTHING that can conclude about them was armed: the
   * paid Apify fallback is off and the dark Spotify search flag is off, so the only rung that ran was
   * the positive-only ListenBrainz oracle and it won nothing. A run that is ok, honest, and useless
   * must not be indistinguishable from a healthy empty queue.
   */
  reason:
    | "apify_budget_spent"
    | "awaiting_free_ask"
    | "no_capable_rung"
    | null
    | typeof DUE_WORK_REPAIR_PENDING_REASON;
  /** Rows this tick could not settle (a bad worklist row, or an anchor POST that threw). */
  skipped: number;
  /** EXACT-ISRC asks the server reported spending this tick — what {@link ISRC_ASK_LIMIT} meters. */
  spotifyIsrcAsks: number;
  /** Rows whose Spotify leg was deferred because this tick's exact-ISRC ask budget was spent. */
  spotifyDeferredBudget: number;
  /** Rows whose Spotify leg was deferred because the clock was outside the night window. */
  spotifyDeferredWindow: number;
  /**
   * Rows whose Spotify leg was deferred because a 429 earlier in this tick ended its asks — the yield
   * law's visible half. A non-zero value with `spotifyIsrcAsks` small is the tell that Spotify pushed
   * back early and the tick correctly got out of the way.
   */
  spotifyDeferredYield: number;
  // `reason` is declared above rather than inherited, because this summary carries its OWN reason
  // vocabulary alongside the shared due-work one; the rest of the gate is merged as before.
} & Partial<Omit<DueWorkRepairPendingGate, "reason">>;

/** The injected effects — so the tick's mapping + routing are provable with stubs (no network). */
export type AnchorDeps = {
  fetchQueue: (limit: number) => Promise<AnchorQueuePage | AnchorWorkItem[]>;
  log: (message: string) => void;
  /** A monotonic clock (ms). Injected so the Spotify-search pacer is deterministic in tests. */
  now: () => number;
  report: (trackId: string, candidates: AnchorCandidatePayload[]) => Promise<AnchorVerdict>;
  /**
   * The FREE first rung — the server resolves + verifies ListenBrainz + (dark) Spotify search for this
   * row. `deezerCandidates` are the rung-0 hits THIS BOX fetched: present (even empty) ⇒ the server
   * verifies exactly those and asks Deezer nothing; omitted ⇒ the server searches Deezer itself.
   */
  resolveFree: (
    trackId: string,
    deezerCandidates?: DeezerCandidatePayload[],
    options?: { spotifySearch?: boolean },
  ) => Promise<AnchorVerdict>;
  runActor: (queries: string[]) => Promise<ApifyResultItem[]>;
  /**
   * ONE Deezer search from THIS BOX's IP, for the rung-0 ISRC recovery. `null` means the search FAILED
   * (network, non-2xx, malformed body, or a quota answer that outlasted the retries) as distinct from
   * an honest empty result — the sweep tallies the two apart. Never throws.
   *
   * A bare ARRAY and a {@link DeezerSearchResult} are both accepted, the `fetchQueue` precedent: the
   * result form carries the dropped-hit count alongside the candidates, and the array form is the
   * same answer with nothing to report.
   */
  searchDeezer: (query: string) => Promise<DeezerCandidatePayload[] | DeezerSearchResult | null>;
  /**
   * The ONE preflight read of `get_spotify_anchor_breaker` per firing (see {@link AnchorPreflight}).
   * OPTIONAL: omitted ⇒ no preflight and the pre-rule pull behaviour, which is what keeps every
   * existing caller and test honest. A read that THROWS is fail-OPEN for the same reason — the
   * admission rule is enforced by the server on every row regardless, so a preflight blip must cost
   * a wasted tick at worst, never a stalled drain.
   */
  readPreflight?: () => Promise<AnchorPreflight>;
  /** Pause for `ms`. Injected so the Spotify-search pacer can be driven by a fake clock in tests. */
  sleep: (ms: number) => Promise<void>;
};

/** Count an item/rung failure that did not stop the run. */
function recordFailure(summary: AnchorSummary): void {
  summary.failed += 1;
}

/** Count a run failure without letting a later one overwrite the first useful diagnostic. */
function recordRunError(summary: AnchorSummary, message?: string): void {
  summary.errors += 1;

  if (summary.error === null && message) {
    summary.error = message;
  }
}

/** One anchored or conclusively missed row has left the derived worklist. */
function settleQueueRow(summary: AnchorSummary): void {
  if (summary.queueDepth !== null && summary.queueDepth > 0) {
    summary.queueDepth -= 1;
  }
}

/** Preserve the server's per-row ListenBrainz outcome as tick-level counters. */
function tallyListenBrainzOutcome(summary: AnchorSummary, verdict: AnchorVerdict): void {
  switch (verdict.listenbrainzOutcome) {
    case "empty-ids":
      summary.lbEmptyIds += 1;
      break;
    case "gate-rejected":
      summary.lbGateRejected += 1;
      break;
    case "metadata-failed":
      summary.lbMetadataFailed += 1;
      recordFailure(summary);
      break;
    case "no-mbid":
      summary.lbNoMbid += 1;
      break;
    case "no-map":
      summary.lbNoMap += 1;
      break;
    case "not-attempted":
      summary.lbNotAttempted += 1;
      break;
    case "request-failed":
      summary.lbRequestFailed += 1;
      recordFailure(summary);
      break;
    case "yielded-on-breaker":
      // NOT a `recordFailure`: the rung declined to spend a read into a wall. See the field's doc.
      summary.lbYieldedOnBreaker += 1;
      break;
    case "anchored":
    case undefined:
      break;
  }
}

/**
 * THE 60/min SPOTIFY-SEARCH CEILING (slice 2). The dark Spotify search rungs share the ONE official
 * app that also serves user-facing mints/publish — the app that starved under 429s at catalogue scale
 * — so the box paces them well under Spotify's limit. `resolve_anchor` issues at most TWO searches per
 * row (exact ISRC, then fuzzy), so holding consecutive search-bearing calls ≥ 2s apart caps the rate
 * at ≤ 2 searches / 2s = 60/min. The existing Spotify 429/Retry-After backoff (apps/web spotify.ts) is
 * the second half: if we ever do approach the wall, anchor search backs off and yields the token, so a
 * mint always has headroom — the pacer keeps us far from the wall, the backoff guarantees priority.
 * The pacer only bites when a call actually SEARCHED (`spotifySearchDone`), so a flag-OFF sweep (LB +
 * Apify only) runs at full speed.
 */
export const SPOTIFY_SEARCH_MIN_INTERVAL_MS = 2000;

// ── THE NIGHT WINDOW (pure) ──────────────────────────────────────────────────
//
// Parsed once per tick and asked once per row. Pure so the window is proven against fixed clocks
// rather than by waiting for 03:00, and so a malformed operator value is a tested outcome rather
// than a surprise at runtime.

/** A parsed {@link ISRC_WINDOW_UTC}: an hour range, "always" (empty value), or "invalid". */
export type IsrcAskWindow = "always" | "invalid" | { endHour: number; startHour: number };

/**
 * Parse `start-end` UTC hours. `end` is EXCLUSIVE, so `"0-8"` is 00:00–08:00. An empty/absent value
 * is `"always"` (no window). Anything else that is not two integers in 0..23 with a `-` between them
 * is `"invalid"`, which {@link withinIsrcAskWindow} reads as DENY.
 */
export function parseIsrcAskWindow(raw: string | undefined): IsrcAskWindow {
  const value = (raw ?? "").trim();

  if (!value) {
    return "always";
  }

  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(value);
  const startHour = Number(match?.[1]);
  const endHour = Number(match?.[2]);

  if (!match || !(startHour >= 0 && startHour <= 23) || !(endHour >= 0 && endHour <= 24)) {
    return "invalid";
  }

  return { endHour, startHour };
}

/**
 * Is `now` inside the parsed window? `"always"` ⇒ true, `"invalid"` ⇒ false (deny). A window whose
 * start is greater than its end WRAPS across midnight (`"22-6"` = 22:00–06:00), and a start equal to
 * its end is an EMPTY window (never open) rather than an all-day one — an operator who means "always"
 * writes the empty string, so the degenerate range is read literally instead of guessed at.
 */
export function withinIsrcAskWindow(window: IsrcAskWindow, now: Date): boolean {
  if (window === "always") {
    return true;
  }

  if (window === "invalid") {
    return false;
  }

  const hour = now.getUTCHours();

  return window.startHour <= window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
}

/**
 * How long to wait before the next `resolve_anchor` call so consecutive Spotify-search-bearing calls
 * stay ≥ `minIntervalMs` apart (start-to-start). `lastSearchStartMs` is null until the first call that
 * issued a Spotify search, so a sweep that never searches never waits. Pure, so the ceiling is proven
 * without real timers.
 */
export function spotifySearchPaceMs(
  lastSearchStartMs: null | number,
  nowMs: number,
  minIntervalMs: number = SPOTIFY_SEARCH_MIN_INTERVAL_MS,
): number {
  if (lastSearchStartMs === null) {
    return 0;
  }

  const elapsed = nowMs - lastSearchStartMs;

  return elapsed >= minIntervalMs ? 0 : minIntervalMs - elapsed;
}

// ── Pure mappers (unit-tested against the real pilot payloads) ────────────────

/** Split an array into fixed-size chunks. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }

  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
}

/** Map one Apify result item to a candidate, or null when it carries no usable Spotify track. */
export function itemToCandidate(item: ApifyResultItem): AnchorCandidatePayload | null {
  const track = item.tracks?.[0];
  const spotifyTrackId = track?.track_id?.trim();

  if (item.success === false || !track || !spotifyTrackId) {
    return null;
  }

  return {
    albumImageUrl: track.track_image ?? item.albums?.[0]?.album_image ?? null,
    artists: (item.artists ?? [])
      .filter((artist): artist is ApifyArtist & { artist_name: string } =>
        Boolean(artist.artist_name),
      )
      .map((artist) => ({ id: artist.artist_id ?? null, name: artist.artist_name })),
    durationMs: typeof track.track_duration_ms === "number" ? track.track_duration_ms : null,
    isrc: track.track_isrc ?? null,
    spotifyTrackId,
    title: track.track_name ?? "",
  };
}

/**
 * Group the actor's flat result array by `target` (the query string) and map each item to a
 * candidate. A row's candidates are then `byTarget.get(row.anchorQuery)`.
 */
export function groupCandidatesByTarget(
  items: ApifyResultItem[],
): Map<string, AnchorCandidatePayload[]> {
  const byTarget = new Map<string, AnchorCandidatePayload[]>();

  for (const item of items) {
    const target = item.target;

    if (typeof target !== "string") {
      continue;
    }

    const candidate = itemToCandidate(item);

    if (!candidate) {
      continue;
    }

    const bucket = byTarget.get(target);

    if (bucket) {
      bucket.push(candidate);
    } else {
      byTarget.set(target, [candidate]);
    }
  }

  return byTarget;
}

// ── THE SPOTIFY ASK STATE (one per timer firing, shared across pages) ────────
//
// The budget and the yield law are properties of a TICK — one firing of the host timer — not of a
// page, so they live in a value `runAnchorSweep` mints once and threads through every page it runs.
// A `runAnchorTick` called on its own (the tests, an attended single page) gets a fresh one, which is
// the same thing when there is only one page.

/** The tick's live Spotify-ask permission: how much budget is left, and whether we have yielded. */
export type SpotifyAskState = {
  /** The parsed night window. Asked per row against the injected clock. */
  askWindow: IsrcAskWindow;
  /** EXACT-ISRC asks the server has reported spending so far this tick. */
  asksSpent: number;
  /** The tick's ceiling on those asks — {@link ISRC_ASK_LIMIT} by default. */
  limit: number;
  /** Latched by the first 429 anywhere in the anchor path; never un-latches within the tick. */
  yielded: boolean;
};

/** A fresh tick's ask state, off the operator's env (or explicit values, for the tests). */
export function newSpotifyAskState(
  limit: number = ISRC_ASK_LIMIT,
  windowUtc: string | undefined = ISRC_WINDOW_UTC,
): SpotifyAskState {
  return {
    askWindow: parseIsrcAskWindow(windowUtc),
    asksSpent: 0,
    limit: Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 0,
    yielded: false,
  };
}

/**
 * May THIS row's `resolve_anchor` call use the Spotify search rungs? The three tick guards, in the
 * order that reads best in a summary: the yield law first (a 429 has happened and nothing else
 * matters), then the clock, then the budget. `null` means yes; a string names which guard deferred
 * it, and is the counter to bump.
 */
export function spotifyAskDeferral(
  state: SpotifyAskState,
  now: Date,
): "budget" | "window" | "yield" | null {
  if (state.yielded) {
    return "yield";
  }

  if (!withinIsrcAskWindow(state.askWindow, now)) {
    return "window";
  }

  return state.asksSpent >= state.limit ? "budget" : null;
}

/**
 * WHAT THIS FIRING CAN CONCLUDE, off the preflight and the clock — pure, so the decision is proven
 * against fixed clocks rather than by waiting for 09:00.
 *
 * `null` means "pull work". A string is the firing's `reason` and means the opposite: pull NOTHING,
 * because every row this firing could reach would be re-read and put straight back.
 *
 *   · `apify_budget_spent` — the server's daily row cap has no room. Every free-rung miss today is
 *     already refused per row, so pulling more rows only re-reads the queue head.
 *   · `awaiting_free_ask` — the paid rung is armed AND the free exact-ISRC rung is armed, but the
 *     clock is outside this box's night window, so no row can get the free ask the paid rung now
 *     requires. The rows keep their turn and the window reaches them: the window is 8h wide and a
 *     firing is hourly, so every waiting row is offered inside it every day.
 *
 * WITH THE FREE SEARCH RUNGS DISARMED it returns `null` unconditionally, and that is the load-bearing
 * case: no receipt can ever be written then, so the admission rule exempts every row and the sweep
 * must keep draining exactly as it did before the rule existed.
 *
 * `dayFreeRungs` ({@link DAY_FREE_RUNGS}) turns every would-be deferral into `"free_rungs_only"`
 * instead: pull the batch, run the free rungs, skip the paid leg, and let every row keep its turn.
 * That is the reversal lever for the day this sweep's free rungs start winning something.
 */
export function anchorFiringDeferral(
  preflight: AnchorPreflight,
  askWindow: IsrcAskWindow,
  now: Date,
  dayFreeRungs: boolean = false,
): "apify_budget_spent" | "awaiting_free_ask" | "free_rungs_only" | null {
  if (!preflight.apifyEnabled) {
    // The free-rungs-only drain: no money to protect, and its own `no_capable_rung` verdict already
    // describes the useless case honestly.
    return null;
  }

  const deferral = preflight.apifyBudgetSpent
    ? "apify_budget_spent"
    : preflight.spotifySearchEnabled && !withinIsrcAskWindow(askWindow, now)
      ? "awaiting_free_ask"
      : null;

  // The escape hatch turns "pull nothing" into "pull, but spend nothing".
  return deferral !== null && dayFreeRungs ? "free_rungs_only" : deferral;
}

// ── One tick, with injected effects ──────────────────────────────────────────

async function fetchAnchorWorkRows(
  limit: number,
  deps: AnchorDeps,
  summary: AnchorSummary,
): Promise<AnchorWorkItem[] | undefined> {
  try {
    const fetched = await deps.fetchQueue(limit);
    const queue = Array.isArray(fetched) ? fetched : fetched.rows;
    summary.queueDepth = Array.isArray(fetched) ? fetched.length : fetched.queueDepth;
    summary.checked = queue.length;
    return queue;
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      // The Worker deferred this page while due-work repair converges: it was never read, so it
      // pauses instead of failing and the next tick reads again.
      deps.log(error.message);
      Object.assign(summary, dueWorkRepairPendingGate(summary));
      return undefined;
    }

    summary.ok = false;
    recordRunError(summary, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function actionableAnchorRows(queue: AnchorWorkItem[]): {
  invalidRows: number;
  rows: (AnchorWorkItem & { anchorQuery: string; trackId: string })[];
} {
  const rows = queue.filter(
    (row): row is AnchorWorkItem & { anchorQuery: string; trackId: string } =>
      Boolean(row.trackId) && Boolean(row.anchorQuery),
  );
  return { invalidRows: queue.length - rows.length, rows };
}

/**
 * Settle the free-rung misses on every path where the ACTOR WILL NOT RUN — the paid rung disabled by
 * the operator's kill-flag, or a free-rungs-only firing. Either way nothing further will be asked
 * about these rows this tick.
 *
 * A row is `missed` — retired, backed off, one fewer in the backlog — ONLY when the server says it
 * PARKED it (`stamped`). A verdict that stamped nothing leaves the row exactly where it was, so it is
 * `deferred` and the queue depth is not decremented: counting it as a miss is how a tick that re-read
 * the same 250-row head reported clearing 250 of them. A free-rung call that THREW never reaches here
 * at all — it is `skipped` at the point it threw, because a row the server never answered about is a
 * row it never admitted to the paid rung.
 *
 * An older server omits `stamped`; that row falls back to the pre-existing reading (a full miss under
 * a disabled Apify rung was stamped), so a lagging Worker degrades to today's numbers, never worse.
 */
function settleUnspentRows(input: {
  apifyEnabled: boolean;
  apifyRows: readonly { stamped?: boolean }[];
  freeRungsOnly: boolean;
  summary: AnchorSummary;
}): boolean {
  const { apifyEnabled, apifyRows, freeRungsOnly, summary } = input;

  // FREE-RUNGS-ONLY ({@link DAY_FREE_RUNGS}). The batch got its free shot and the paid leg is
  // skipped, so every remaining row is DEFERRED, never `missed`: no actor ran, the server stamped
  // nothing, and the queue depth is untouched because not one of these rows was settled.
  if (freeRungsOnly) {
    summary.deferred += apifyRows.length;
    summary.rungsSkipped = ["apify"];

    return true;
  }

  if (apifyEnabled) {
    return false;
  }

  for (const row of apifyRows) {
    if (row.stamped === false) {
      summary.deferred += 1;
    } else {
      summary.missed += 1;
      settleQueueRow(summary);
    }
  }

  return true;
}

async function runApifyFallback(
  apifyRows: readonly { anchorQuery: string; trackId: string }[],
  actorChunkSize: number,
  deps: AnchorDeps,
  summary: AnchorSummary,
): Promise<void> {
  for (const batch of chunk(apifyRows, actorChunkSize)) {
    let byTarget: Map<string, AnchorCandidatePayload[]>;

    try {
      const items = await deps.runActor(batch.map((row) => row.anchorQuery));
      // The actor bills per RESULT ITEM, so the ledger counts items, not runs: `apifyResults` divided
      // by `apifyRowsSent` is the realised results-per-row the cost math is built on
      // (`FLUNCLE_ANCHOR_KEYWORD_LIMIT` is what it is asked for, never what it comes back as).
      summary.apifyResults += items.length;
      byTarget = groupCandidatesByTarget(items);
    } catch (error) {
      deps.log(`actor run failed: ${error instanceof Error ? error.message : String(error)}`);
      summary.ok = false;
      summary.apifyActorErrors += 1;
      recordRunError(summary, error instanceof Error ? error.message : String(error));
      summary.skipped += batch.length;
      continue;
    }

    for (const row of batch) {
      const candidates = byTarget.get(row.anchorQuery) ?? [];
      if (!byTarget.has(row.anchorQuery)) {
        summary.apifyTargetOmitted += 1;
      }
      summary.apifyDurationMsOmitted += candidates.filter(
        (candidate) => typeof candidate.durationMs !== "number",
      ).length;

      try {
        summary.apifyRowsSent += 1;
        const verdict = await deps.report(row.trackId, candidates);
        if (verdict.anchored && verdict.verifiedBy === "isrc") {
          summary.anchoredByIsrc += 1;
          summary.produced += 1;
          settleQueueRow(summary);
        } else if (verdict.anchored) {
          summary.anchoredBySearch += 1;
          summary.produced += 1;
          settleQueueRow(summary);
        } else {
          summary.missed += 1;
          settleQueueRow(summary);
        }
      } catch (error) {
        deps.log(`${row.trackId}: ${error instanceof Error ? error.message : String(error)}`);
        summary.skipped += 1;
        recordFailure(summary);
      }
    }
  }
}

/**
 * Fold ONE `resolve_anchor` verdict into the tick's tally and its live ask state: the exact-ISRC ask
 * budget, the yield law, the per-rung diagnostics, and the anchor itself. Returns TRUE when the row
 * ANCHORED — i.e. it is settled and never reaches the paid fallback.
 *
 * The two GLOBAL flags stay with the caller, because they are properties of the tick rather than of
 * a row; everything here is this row's own accounting.
 */
function tallyFreeVerdict(
  verdict: AnchorVerdict,
  summary: AnchorSummary,
  askState: SpotifyAskState,
  deps: AnchorDeps,
): boolean {
  if (verdict.spotifyIsrcAsked) {
    askState.asksSpent += 1;
    summary.spotifyIsrcAsks += 1;
  }

  // THE YIELD LAW. A throttle ends the tick's remaining Spotify asks — it says nothing about this
  // row, which stamps nothing and keeps its turn.
  if (verdict.spotifyThrottled && !askState.yielded) {
    askState.yielded = true;
    deps.log("spotify throttled — yielding the rest of the tick's Spotify asks");
  }

  if (typeof verdict.freeDurationMsOmitted === "number") {
    summary.freeDurationMsOmitted += verdict.freeDurationMsOmitted;
  }

  // Recovery is orthogonal to anchoring — count it whether or not this row then anchored (a
  // recovered ISRC that still missed every rung this tick is persisted and helps the next one).
  if (verdict.isrcRecoveredByDeezer) {
    summary.isrcRecoveredByDeezer += 1;
  }

  tallyListenBrainzOutcome(summary, verdict);

  if (!verdict.anchored) {
    return false;
  }

  if (verdict.source === "spotify-isrc") {
    summary.anchoredBySpotifyIsrc += 1;
  } else if (verdict.source === "spotify-search") {
    summary.anchoredBySpotifySearch += 1;
  } else {
    // "listenbrainz" (or a pre-slice-2 server that omits `source`) — the free ListenBrainz rung.
    summary.anchoredByListenbrainz += 1;
  }

  summary.produced += 1;
  settleQueueRow(summary);

  return true;
}

export async function runAnchorTick(
  limit: number,
  deps: AnchorDeps,
  actorChunkSize: number = APIFY_QUERY_CHUNK,
  askState: SpotifyAskState = newSpotifyAskState(),
  /**
   * FREE-RUNGS-ONLY ({@link DAY_FREE_RUNGS}): run the free rungs over the batch and skip the paid
   * leg entirely. Every row that reaches the fallback keeps its turn — nothing is stamped, so
   * nothing is retired, and the next eligible firing reads them again.
   */
  freeRungsOnly: boolean = false,
): Promise<AnchorSummary> {
  const summary: AnchorSummary = {
    anchoredByIsrc: 0,
    anchoredByListenbrainz: 0,
    anchoredBySearch: 0,
    anchoredBySpotifyIsrc: 0,
    anchoredBySpotifySearch: 0,
    apifyActorErrors: 0,
    apifyBudgetRemaining: null,
    apifyBudgetSkipped: 0,
    apifyDurationMsOmitted: 0,
    apifyResults: 0,
    apifyRowsSent: 0,
    apifySkippedAwaitingSpotify: 0,
    apifyTargetOmitted: 0,
    checked: 0,
    deezerHitsDroppedIncomplete: 0,
    deezerSearchFailed: 0,
    deferred: 0,
    error: null,
    errors: 0,
    expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
    failed: 0,
    freeDurationMsOmitted: 0,
    freeRungErrors: 0,
    isrcRecoveredByDeezer: 0,
    lbEmptyIds: 0,
    lbGateRejected: 0,
    lbMetadataFailed: 0,
    lbNoMap: 0,
    lbNoMbid: 0,
    lbNotAttempted: 0,
    lbRequestFailed: 0,
    lbYieldedOnBreaker: 0,
    missed: 0,
    ok: true,
    produced: 0,
    queueDepth: null,
    reason: null,
    rungsSkipped: [],
    skipped: 0,
    spotifyDeferredBudget: 0,
    spotifyDeferredWindow: 0,
    spotifyDeferredYield: 0,
    spotifyIsrcAsks: 0,
  };

  const queue = await fetchAnchorWorkRows(limit, deps, summary);
  if (queue === undefined) {
    return summary;
  }

  // Only rows with both a trackId and a query are actionable; the rest are counted skipped.
  const { invalidRows, rows } = actionableAnchorRows(queue);
  summary.skipped += invalidRows;
  summary.failed += invalidRows;

  if (rows.length === 0) {
    return summary;
  }

  // ── RUNG 1-3: THE FREE (non-Apify) RUNGS, per row, via ONE `resolve_anchor` call: the FREE
  // ListenBrainz rung, then the DARK Spotify search rungs (slice 2, server-gated behind the default-off
  // flag). A hit here anchors WITHOUT Apify money and this row NEVER reaches the metered Apify rung
  // below. Only the misses fall through to `apifyRows`. The free path failing (a Worker error, a
  // network blip) is treated exactly like a miss — the row still gets its paid turn — so a flaky free
  // path can never STARVE anchoring, only fail to save money on that row.
  //
  // PACING: when a call actually issued a Spotify search (`spotifySearchDone`), the next call waits so
  // consecutive search-bearing calls stay ≥ 2s apart — the 60/min ceiling on the shared official app
  // (see `spotifySearchPaceMs`). A flag-OFF sweep never searches, so it never waits.
  //
  // THE THREE TICK-LEVEL GUARDS ride the same loop, as one `spotifySearch: false` per covered row:
  // the night window (asked once per row off the injected clock), the exact-ISRC ask budget, and the
  // yield law. None of them can ARM the rungs — the server's dark flag is the only thing that does —
  // so a tick where the flag is off spends the guards' bookkeeping and nothing else.
  const apifyRows: { anchorQuery: string; stamped?: boolean; trackId: string }[] = [];
  let lastSearchStartMs: null | number = null;
  // The GLOBAL Apify kill-flag, learned from any verdict (all agree). Default true ⇒ a pre-slice-3
  // server that omits it keeps the current Apify-runs behaviour. When false, the Apify loop is skipped.
  let apifyEnabled = true;
  // The GLOBAL dark Spotify-search flag, learned the same way. `undefined` ⇒ the server never said, so
  // this tick makes NO claim about what could have concluded (see the `reason` verdict below).
  let spotifySearchEnabled: boolean | undefined;

  for (const row of rows) {
    // ── RUNG 0's FETCH, and the reason it lives here. Deezer's public search takes no token, so its
    // quota is purely PER-IP — and the Worker egresses from Cloudflare's SHARED edge IPs, where that
    // quota is spent by the whole platform rather than by Fluncle's one-request-per-row cadence.
    // Measured in production: 0 ISRCs recovered out of 5,133 ISRC-less rows over 3 days from the edge,
    // against 25/25 clean from this box's own dedicated IP. So the SEARCH runs here and the hits ride
    // the `resolve_anchor` call. NOTHING ELSE MOVED: the Worker re-runs the row's identity fold +
    // duration window over these hits and writes the ISRC fill-empty-only, exactly as before — this
    // box offers evidence and is never asked for a verdict.
    //
    // Only a row the worklist attached a `deezerQuery` to (an ISRC-LESS row) is searched, so the
    // request cadence stays one-per-recoverable-row. A FAILED search hands over an empty list rather
    // than omitting the field: retrying it from the saturated edge is a known-dead request.
    let deezerCandidates: DeezerCandidatePayload[] | undefined;

    if (row.deezerQuery) {
      const hits = await deps.searchDeezer(row.deezerQuery).catch(() => null);

      if (hits === null) {
        summary.deezerSearchFailed += 1;
        recordFailure(summary);
      } else if (Array.isArray(hits)) {
        deezerCandidates = hits;
      } else {
        // The result form — the same candidates, plus how many hits were withheld as unverifiable.
        deezerCandidates = hits.candidates;
        summary.deezerHitsDroppedIncomplete += hits.droppedIncomplete;
      }

      deezerCandidates ??= [];
    }

    const waitMs = spotifySearchPaceMs(lastSearchStartMs, deps.now());

    if (waitMs > 0) {
      await deps.sleep(waitMs);
    }

    const startMs = deps.now();
    // THE TICK GUARDS, asked once per row. `deps.now()` is the real wall clock in production (and an
    // injected one in the tests), so the night window reads the hour the same way either way.
    const deferral = spotifyAskDeferral(askState, new Date(startMs));

    if (deferral === "budget") {
      summary.spotifyDeferredBudget += 1;
    } else if (deferral === "window") {
      summary.spotifyDeferredWindow += 1;
    } else if (deferral === "yield") {
      summary.spotifyDeferredYield += 1;
    }

    // What the server said about this row's fate, so the settle below can tell a RETIRED row from one
    // that merely kept its turn. Undefined until a verdict says.
    let rowStamped: boolean | undefined;

    try {
      const verdict = await deps.resolveFree(
        row.trackId,
        deezerCandidates,
        // Sent ONLY as a deferral. Omitting the option entirely on the allowed path keeps the
        // request byte-identical to what a pre-slice server already accepts.
        deferral === null ? undefined : { spotifySearch: false },
      );

      rowStamped = verdict.stamped;

      if (verdict.spotifySearchDone) {
        lastSearchStartMs = startMs;
      }

      // Both flags are global, so any verdict tells the whole tick's answer.
      apifyEnabled = verdict.apifyEnabled ?? apifyEnabled;
      spotifySearchEnabled = verdict.spotifySearchEnabled ?? spotifySearchEnabled;

      if (typeof verdict.apifyBudgetRemaining === "number") {
        summary.apifyBudgetRemaining = verdict.apifyBudgetRemaining;
      }

      if (tallyFreeVerdict(verdict, summary, askState, deps)) {
        continue;
      }

      // THE ADMISSION GATE. The server decides whether this row may cost money and says so; the box
      // obeys. An un-admitted row settled NOTHING — it was not asked — so it is `deferred`, keeps its
      // turn, and the queue depth is not decremented. Absent (a pre-rule server) reads as admitted,
      // so a lagging Worker degrades to the previous behaviour rather than to a silent stall.
      if (verdict.apifyEligible === false) {
        if (verdict.apifyIneligibleReason === "apify_budget_spent") {
          summary.apifyBudgetSkipped += 1;
        } else {
          summary.apifySkippedAwaitingSpotify += 1;
        }

        summary.deferred += 1;
        continue;
      }
    } catch (error) {
      deps.log(
        `free rung ${row.trackId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      summary.freeRungErrors += 1;
      recordFailure(summary);
      // A THROWN free rung is not an authorisation. Under the admission rule the server is the only
      // thing that may admit a row to the paid fallback, so a row it never answered about must not be
      // bought on a guess — it is `skipped` and the next tick asks again. The trade is deliberate:
      // spend correctness over throughput, with `freeRungErrors` as the alarm that says which.
      summary.skipped += 1;
      continue;
    }

    apifyRows.push({ ...row, stamped: rowStamped });
  }

  // THE CAPABILITY VERDICT. Neither the paid Apify fallback nor the dark Spotify search rungs are
  // armed, so the only rung that ran was the positive-only ListenBrainz oracle — and it won nothing.
  // The tick is honest, `ok`, and settled no row's question; saying so is the difference between this
  // and a healthy empty queue. Claimed only when the server actually reported both flags.
  if (apifyEnabled === false && spotifySearchEnabled === false && summary.produced === 0) {
    summary.reason = "no_capable_rung";
  }

  // Every row the free rung anchored is done; only the misses cost Apify money.
  if (apifyRows.length === 0) {
    return summary;
  }

  // ── THE APIFY KILL-FLAG (slice 3). When Apify is out of budget the operator flips `anchor_apify_enabled`
  // OFF; `resolve_anchor` reports it on every verdict AND has already parked each row it could settle.
  // So we skip the whole actor loop — ZERO wasted 403s — and count per the server's own `stamped`:
  // parked rows are `missed` (terminal, backed off), rows that kept their turn are `deferred`, and a
  // free rung that THREW got no verdict at all and stays `skipped`.
  if (settleUnspentRows({ apifyEnabled, apifyRows, freeRungsOnly, summary })) {
    return summary;
  }

  // ── RUNG 2: THE APIFY FALLBACK, over the free-rung misses only. Run the actor in bounded chunks so
  // a big `--limit` burn never one-shots a giant run-sync call.
  await runApifyFallback(apifyRows, actorChunkSize, deps, summary);

  return summary;
}

// ── The real (box-side) effects ───────────────────────────────────────────────

async function fetchAnchorQueue(limit: number): Promise<AnchorQueuePage> {
  // ONE bounded retry: the queue read sees a transient non-OK (a rolling Worker deploy
  // window) every few hours; without the retry a lone blip exits the tick 1 and fires a
  // Discord alert the on-failure restart then self-heals — pure noise. A PERSISTENT
  // failure still throws (and alerts) on the second miss.
  const attempt = () =>
    fetch(
      `${API_BASE_URL}/api/v1/admin/tracks/work?kind=anchor&limit=${limit}&count=true&debtAware=true`,
      {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
  let res = await attempt().catch(() => undefined);

  // The Worker's typed due-work deferral is never retried in-tick: the refused read already advanced
  // its bounded repair step, and the next tick reads again.
  if (res !== undefined && !res.ok) {
    await failureBodyUnlessRepairPending(res, "anchor queue read");
  }

  if (!res?.ok) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    res = await attempt();
  }

  if (!res.ok) {
    const body = await failureBodyUnlessRepairPending(res, "anchor queue read");
    throw new Error(`anchor queue read failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const body = (await res.json()) as { queued?: unknown; tracks?: unknown };

  // A `count=true` read answers the backlog size even while repair converges, reporting the
  // withheld page as `debtPending`. This sweep consumes the PAGE, so it pauses on it exactly as
  // it pauses on the typed refusal.
  throwIfPageRepairPending("anchor queue read", body);

  if (!Array.isArray(body.tracks)) {
    throw new Error("anchor queue read returned a non-array tracks body");
  }

  if (
    typeof body.queued !== "number" ||
    !Number.isInteger(body.queued) ||
    body.queued < body.tracks.length
  ) {
    throw new Error("anchor queue read returned an invalid whole-queue count");
  }

  return { queueDepth: body.queued, rows: body.tracks as AnchorWorkItem[] };
}

export async function runApifyActor(queries: string[]): Promise<ApifyResultItem[]> {
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`;
  const res = await fetch(url, {
    body: JSON.stringify({
      searchKeywordLimit: SEARCH_KEYWORD_LIMIT,
      tracks: queries,
      tracksIncludeAlbum: true,
      tracksIncludeArtists: true,
      tracksIncludeAudioFeatures: false,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    // Apify run-sync waits for the run to finish; a chunk of 15 keyword searches is well within
    // this, with headroom for a slow run.
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    throw new Error(`apify actor run failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as unknown;

  if (!Array.isArray(body)) {
    const preview = JSON.stringify(body) ?? String(body);

    throw new Error(
      `apify actor run failed (200): expected an array, got ${preview.slice(0, 200)}`,
    );
  }

  return body as ApifyResultItem[];
}

// ── THE BOX-SIDE DEEZER SEARCH (rung 0's fetch) ───────────────────────────────
//
// Deezer's public search takes no token, so its quota is purely PER-IP. That is the whole reason this
// code is on the box and not in the Worker: the Worker egresses from Cloudflare's SHARED edge IPs,
// where the quota is spent by the entire platform. Measured in production — 0 ISRCs recovered out of
// 5,133 ISRC-less rows over 3 days from the edge; 25/25 clean, zero quota errors, in a tight
// back-to-back burst from this box's own IP. No proxy: the box's IP is enough, and
// `deezerSearchFailed` in the tick summary is the tripwire for the day it stops being.
//
// Politeness: IDENTIFIED (the honest Fluncle User-Agent, the same one the Worker presents) and BOUNDED
// (a per-request deadline). One search per ISRC-less worklist row, issued one at a time down the
// worklist — the cadence, never a burst, is what keeps us under Deezer's limit.

/** The identifiable User-Agent Fluncle presents across the web — one honest identity. */
const DEEZER_USER_AGENT = "Fluncle/1.0 (+https://www.fluncle.com)";

/** Per-request wall-clock deadline. Deezer answers well under a second; past this is a stalled socket. */
const DEEZER_TIMEOUT_MS = 10_000;

/**
 * Hits to consider. Deezer's search is fuzzy, so the WORKER's gate picks from a small handful.
 *
 * This MUST equal the contract's `DEEZER_CANDIDATE_LIMIT` (packages/contracts, admin-catalogue.ts),
 * which is the cap `resolve_anchor` accepts — send more and the whole call is refused as a 400. It is
 * a literal here only because this script is baked standalone onto the box and imports nothing from
 * the workspace; the contract is the owner, and this is the copy that follows it.
 */
const DEEZER_SEARCH_LIMIT = 5;

/**
 * THE QUOTA TRAP. Deezer does not signal a throttle with a 429, or with any non-2xx: it answers
 * **HTTP 200** carrying `{"error":{"type":"Exception","message":"Quota limit exceeded","code":4}}`
 * instead of a result set. That walks past `res.ok`, parses as valid JSON, and lands on an absent
 * `data` — so a client that only asks "is `data` an array?" reads a THROTTLE as a clean MISS. It is
 * read FIRST here, and treated as a failure, never as a miss.
 */
const DEEZER_QUOTA_ERROR_CODE = 4;

/** Backoff between quota retries — Deezer's window is a few seconds wide, so a short wait lands fresh. */
const DEEZER_QUOTA_RETRY_DELAYS_MS = [1_200, 2_500];

/** One Deezer search attempt's outcome, so a throttle can be retried and a hard failure cannot. */
type DeezerAttempt =
  | ({ outcome: "ok" } & DeezerSearchResult)
  | { outcome: "failed" }
  | { outcome: "quota" };

/** ONE Deezer search request, mapped to {@link DeezerAttempt}. Never throws. */
async function attemptDeezerSearch(query: string): Promise<DeezerAttempt> {
  let res: Response;

  try {
    res = await fetch(
      `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=${DEEZER_SEARCH_LIMIT}`,
      {
        headers: { "User-Agent": DEEZER_USER_AGENT },
        signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      },
    );
  } catch {
    return { outcome: "failed" };
  }

  if (!res.ok) {
    return { outcome: "failed" };
  }

  let body: unknown;

  try {
    body = await res.json();
  } catch {
    return { outcome: "failed" };
  }

  const parsed = body as {
    data?: {
      artist?: { name?: string };
      duration?: number;
      id?: number;
      isrc?: string;
      title?: string;
    }[];
    error?: { code?: unknown };
  };

  // THE ERROR BODY, read BEFORE `data` — a 200 is not a result.
  if (parsed.error) {
    return parsed.error.code === DEEZER_QUOTA_ERROR_CODE
      ? { outcome: "quota" }
      : { outcome: "failed" };
  }

  if (!Array.isArray(parsed.data)) {
    return { outcome: "failed" };
  }

  const candidates: DeezerCandidatePayload[] = [];
  let droppedIncomplete = 0;

  for (const hit of parsed.data) {
    const isrc = hit.isrc?.trim() ?? "";
    const title = hit.title?.trim() ?? "";
    const artistName = hit.artist?.name?.trim() ?? "";

    // A hit missing any of the four signals the Worker's gate reads cannot be verified, so it is
    // dropped HERE rather than sent as an unverifiable payload. Dropping is the box's only judgement
    // and it is one-way: it can withhold evidence, never manufacture it. It is also COUNTED: an
    // all-dropped response and a genuinely empty one both leave as `[]`, so without this number a
    // systematic upstream change (Deezer dropping `isrc` from search results) would read as a
    // catalogue Deezer has never heard of.
    if (!isrc || !title || !artistName || typeof hit.duration !== "number" || hit.duration <= 0) {
      droppedIncomplete += 1;
      continue;
    }

    candidates.push({
      artistName,
      // Kept when present, never required: the id is not one of the four signals the gate reads, so
      // a hit without one is still a good ISRC recovery.
      ...(typeof hit.id === "number" ? { deezerTrackId: String(hit.id) } : {}),
      durationMs: Math.round(hit.duration * 1000),
      isrc,
      title,
    });
  }

  return { candidates, droppedIncomplete, outcome: "ok" };
}

/**
 * The rung-0 Deezer search for one worklist row, with a bounded quota retry. Returns `null` when the
 * search FAILED (so the tick can count it apart from an honest empty result) and never throws.
 *
 * `retryDelaysMs` is injected for deterministic tests; production uses the calibrated backoff.
 */
export async function searchDeezerOnBox(
  query: string,
  retryDelaysMs: number[] = DEEZER_QUOTA_RETRY_DELAYS_MS,
): Promise<DeezerSearchResult | null> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await attemptDeezerSearch(query);

    if (result.outcome === "ok") {
      return { candidates: result.candidates, droppedIncomplete: result.droppedIncomplete };
    }

    const delay = result.outcome === "quota" ? retryDelaysMs[attempt] : undefined;

    // A hard failure never retries (it is not going to un-fail); a quota retry stops once the bounded
    // budget is spent. Either way this row gets no recovery, and the tick says so.
    if (delay === undefined) {
      log(
        result.outcome === "quota"
          ? `deezer quota exhausted after ${attempt + 1} attempts`
          : "deezer search failed",
      );

      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * The real preflight: ONE `get_spotify_anchor_breaker` read (admin tier, agent-allowed) that answers
 * which rungs are armed and what the paid one has left today. Never throws in a way the caller must
 * handle — `runAnchorSweep` catches and proceeds, the fail-open rule.
 */
async function readAnchorPreflight(): Promise<AnchorPreflight> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/catalogue/anchor/breaker`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`anchor preflight read failed (${res.status})`);
  }

  const body = (await res.json()) as {
    rungs?: {
      apifyBudget?: { remainingRows?: number; spent?: boolean };
      apifyEnabled?: boolean;
      spotifySearchEnabled?: boolean;
    };
  };

  const budget = body.rungs?.apifyBudget;

  return {
    apifyBudgetRemaining: typeof budget?.remainingRows === "number" ? budget.remainingRows : 0,
    // A server that predates the brake carries no `apifyBudget`, and an ABSENT cap must never read as
    // spent: the old behaviour is "no cap", and failing closed here would stop anchoring on a version
    // skew rather than on a budget.
    apifyBudgetSpent: budget?.spent === true,
    apifyEnabled: body.rungs?.apifyEnabled !== false,
    spotifySearchEnabled: body.rungs?.spotifySearchEnabled === true,
  };
}

async function reportAnchor(
  trackId: string,
  candidates: AnchorCandidatePayload[],
): Promise<AnchorVerdict> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/catalogue/anchor`, {
    body: JSON.stringify({ candidates, trackId }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `anchor_track ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as AnchorVerdict;

  return { anchored: Boolean(body.anchored), verifiedBy: body.verifiedBy ?? null };
}

/**
 * The FREE (non-Apify) rungs — the SERVER resolves this row from ListenBrainz (recording MBID →
 * Spotify ids, no auth) + one by-id read and, when the dark flag is on, from the Spotify SEARCH rungs
 * (slice 2), verifies each against the same gate, and on a hit writes the anchor. The box supplies no
 * candidates; it just hands over the trackId. Only when ALL of these miss does the caller spend the
 * metered Apify search. `source` tells which rung anchored (for the tally); `spotifySearchDone` tells
 * whether a Spotify search was issued (for the pacer); `isrcRecoveredByDeezer` tells whether a verified
 * ISRC was recovered from Deezer into this ISRC-less row before anchoring (for the tally).
 *
 * `deezerCandidates` is the ONE thing the box hands over: the rung-0 Deezer hits it fetched from its
 * own IP (see `searchDeezerOnBox`). Sent even when EMPTY, which tells the server "the box searched,
 * ask Deezer nothing" — re-asking from the saturated shared edge is a known-dead request. Omitted for
 * a row the worklist gave no `deezerQuery`, which is a row that already carries an ISRC. The server
 * verifies these against the row and writes the ISRC itself; the box's opinion is never sent.
 *
 * `options.spotifySearch: false` is the tick's DEFERRAL of the Spotify search rungs for this row —
 * the ask budget, the night window, or the yield law. It is sent only when one of them fires, so the
 * allowed path's request body is byte-identical to what it has always been, and it can only ever
 * subtract permission: the server's dark flag remains the one thing that arms the rungs.
 */
async function resolveAnchorFree(
  trackId: string,
  deezerCandidates?: DeezerCandidatePayload[],
  options?: { spotifySearch?: boolean },
): Promise<AnchorVerdict> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/catalogue/anchor/resolve`, {
    body: JSON.stringify({
      trackId,
      ...(deezerCandidates ? { deezerCandidates } : {}),
      ...(options?.spotifySearch === false ? { spotifySearch: false } : {}),
    }),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(
      `resolve_anchor ${trackId} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as AnchorVerdict;

  return {
    anchored: Boolean(body.anchored),
    apifyBudgetRemaining: body.apifyBudgetRemaining,
    // ABSENT DEFAULTS TO ADMITTED: a server with no admission rule has no verdict to give, and the
    // sweep must not invent one for it (version tolerance runs both ways — new sweep, old Worker).
    apifyEligible: body.apifyEligible === undefined ? true : Boolean(body.apifyEligible),
    // Default true when a pre-slice-3 server omits it — the current Apify-runs behaviour.
    apifyEnabled: body.apifyEnabled === undefined ? true : Boolean(body.apifyEnabled),
    apifyIneligibleReason: body.apifyIneligibleReason ?? null,
    isrcRecoveredByDeezer: Boolean(body.isrcRecoveredByDeezer),
    listenbrainzOutcome: body.listenbrainzOutcome,
    source: body.source ?? null,
    spotifyIsrcAsked: Boolean(body.spotifyIsrcAsked),
    spotifySearchDone: Boolean(body.spotifySearchDone),
    spotifyThrottled: Boolean(body.spotifyThrottled),
    verifiedBy: body.verifiedBy ?? null,
  };
}

/**
 * The PAGED sweep: `runAnchorTick` per ≤PAGE_LIMIT page until `total` rows have been pulled or the
 * queue runs dry (a short page). One page failing stops the sweep (its summary carries the error) —
 * a later page would just re-hit the same broken dependency. Summaries are summed field-wise.
 */
export async function runAnchorSweep(
  total: number,
  deps: AnchorDeps,
  pageLimit: number = PAGE_LIMIT,
): Promise<AnchorSummary & { pages: number; pulled: number }> {
  const merged = {
    anchoredByIsrc: 0,
    anchoredByListenbrainz: 0,
    anchoredBySearch: 0,
    anchoredBySpotifyIsrc: 0,
    anchoredBySpotifySearch: 0,
    apifyActorErrors: 0,
    apifyBudgetRemaining: null as null | number,
    apifyBudgetSkipped: 0,
    apifyDurationMsOmitted: 0,
    apifyResults: 0,
    apifyRowsSent: 0,
    apifySkippedAwaitingSpotify: 0,
    apifyTargetOmitted: 0,
    checked: 0,
    deezerHitsDroppedIncomplete: 0,
    deezerSearchFailed: 0,
    deferred: 0,
    error: null as null | string,
    errors: 0,
    expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
    failed: 0,
    freeDurationMsOmitted: 0,
    freeRungErrors: 0,
    isrcRecoveredByDeezer: 0,
    lbEmptyIds: 0,
    lbGateRejected: 0,
    lbMetadataFailed: 0,
    lbNoMap: 0,
    lbNoMbid: 0,
    lbNotAttempted: 0,
    lbRequestFailed: 0,
    lbYieldedOnBreaker: 0,
    missed: 0,
    ok: true,
    pages: 0,
    produced: 0,
    pulled: 0,
    queueDepth: null as null | number,
    reason: null as AnchorSummary["reason"],
    rungsSkipped: [] as string[],
    skipped: 0,
    spotifyDeferredBudget: 0,
    spotifyDeferredWindow: 0,
    spotifyDeferredYield: 0,
    spotifyIsrcAsks: 0,
  };

  // THE PREFLIGHT, once per firing and before a single row is pulled. Fail-OPEN: the admission rule
  // is enforced server-side on every row regardless, so a blip here costs one wasted tick at most,
  // never a stalled drain. An omitted dep is the pre-rule behaviour, unchanged.
  const askState = newSpotifyAskState();
  // Whether the free exact-ISRC rung is armed at all — set by the preflight, and the condition under
  // which a pulled row needs an ask before it can conclude.
  let askArmed = false;
  // Whether this firing runs its batch through the free rungs alone (the escape hatch).
  let freeRungsOnly = false;

  if (deps.readPreflight) {
    const preflight = await deps.readPreflight().catch((error: unknown) => {
      deps.log(`preflight read failed: ${error instanceof Error ? error.message : String(error)}`);

      return undefined;
    });

    if (preflight) {
      merged.apifyBudgetRemaining = preflight.apifyBudgetRemaining;
      askArmed = preflight.apifyEnabled && preflight.spotifySearchEnabled;
      const deferral = anchorFiringDeferral(
        preflight,
        askState.askWindow,
        new Date(deps.now()),
        DAY_FREE_RUNGS,
      );

      if (deferral === "free_rungs_only") {
        // The escape hatch: pull the batch, run the free rungs, spend nothing. No ask can be made
        // outside the window, so the ask ceiling is not the right cap on this pull — the operator's
        // batch is.
        freeRungsOnly = true;
        askArmed = false;
      } else if (deferral !== null) {
        // Nothing this firing pulled could conclude, so it pulls nothing: the rows keep their turn
        // and the queue is not churned. `checked` stays 0 and `queueDepth` stays null — the firing
        // measured nothing and must not claim to have.
        //
        // IT NAMES WHAT IT SKIPPED. A firing that settles nothing reads like an empty queue unless
        // the summary says which rungs never ran — including the two FREE ones, which is the part a
        // later reader would otherwise have to infer. `FLUNCLE_ANCHOR_DAY_FREE_RUNGS=1` is the knob
        // that trades this back (see {@link DAY_FREE_RUNGS}).
        merged.reason = deferral;
        merged.rungsSkipped = ["listenbrainz", "deezer-isrc-recovery", "spotify-search", "apify"];

        return merged;
      }
    }
  }

  let remaining = Math.max(0, Math.trunc(total));

  // AND THE PULL IS CAPPED BY WHAT THE TICK CAN ASK. With the exact-ISRC rung armed, a row only
  // leaves this queue after that rung has asked about it, and the tick may ask `ISRC_ASK_LIMIT`
  // times. Pulling more than that hands the surplus rows a free-rung pass that can conclude nothing
  // and then re-reads them next tick — the same churn the preflight above exists to stop, one layer
  // in. The cap binds only while the rung is ARMED; disarmed, every row is admitted on sight and the
  // operator's full batch is the right pull.
  if (askArmed) {
    remaining = Math.min(remaining, askState.limit);
  }
  // Whether any page found no rung capable of concluding. Folded into the firing's `reason` only if
  // the firing as a whole settled nothing — one page's win makes the sweep useful.
  let noCapableRung = false;
  // ONE ask state for the whole firing (minted above, before the preflight reads its window). The
  // budget and the yield law are per-TICK, and a sweep's pages are internal bookkeeping — a per-page
  // state would hand a `--limit 200` burn eight fresh budgets and defeat the ceiling entirely.
  while (remaining > 0) {
    const ask = Math.min(pageLimit, remaining);
    const page = await runAnchorTick(ask, deps, APIFY_QUERY_CHUNK, askState, freeRungsOnly);
    const pulled = page.checked;

    merged.pages += 1;
    merged.pulled += pulled;
    merged.checked += page.checked;
    merged.produced += page.produced;
    // A deferred page read nothing, so the last measured backlog gauge stands.
    merged.queueDepth = page.gateState === "paused" ? merged.queueDepth : page.queueDepth;
    merged.apifyActorErrors += page.apifyActorErrors;
    merged.apifyResults += page.apifyResults;
    merged.apifyRowsSent += page.apifyRowsSent;
    merged.apifySkippedAwaitingSpotify += page.apifySkippedAwaitingSpotify;
    merged.apifyBudgetSkipped += page.apifyBudgetSkipped;

    if (page.rungsSkipped.length > 0) {
      merged.rungsSkipped = page.rungsSkipped;
    }
    // The LAST page to hear a number wins — the budget is a live counter, not a sum.
    merged.apifyBudgetRemaining = page.apifyBudgetRemaining ?? merged.apifyBudgetRemaining;
    merged.anchoredByIsrc += page.anchoredByIsrc;
    merged.anchoredByListenbrainz += page.anchoredByListenbrainz;
    merged.anchoredBySearch += page.anchoredBySearch;
    merged.anchoredBySpotifyIsrc += page.anchoredBySpotifyIsrc;
    merged.anchoredBySpotifySearch += page.anchoredBySpotifySearch;
    merged.isrcRecoveredByDeezer += page.isrcRecoveredByDeezer;
    merged.lbEmptyIds += page.lbEmptyIds;
    merged.lbGateRejected += page.lbGateRejected;
    merged.lbMetadataFailed += page.lbMetadataFailed;
    merged.lbNoMbid += page.lbNoMbid;
    merged.lbNoMap += page.lbNoMap;
    merged.lbNotAttempted += page.lbNotAttempted;
    merged.lbRequestFailed += page.lbRequestFailed;
    merged.lbYieldedOnBreaker += page.lbYieldedOnBreaker;
    // The diagnostics ride along field-wise but stay OUT of `pulled` — none is a row outcome: a
    // failed Deezer search still resolves its row, a thrown free rung is already counted by whatever
    // that row ends up as (an Apify verdict, or `skipped` when Apify is off), an omitted Apify target
    // is already counted as `missed`, and a deferred Spotify leg is a row that simply took a
    // different (cheaper) path through the same waterfall.
    merged.apifyTargetOmitted += page.apifyTargetOmitted;
    merged.apifyDurationMsOmitted += page.apifyDurationMsOmitted;
    merged.deezerHitsDroppedIncomplete += page.deezerHitsDroppedIncomplete;
    merged.deezerSearchFailed += page.deezerSearchFailed;
    merged.failed += page.failed;
    merged.freeDurationMsOmitted += page.freeDurationMsOmitted;
    merged.freeRungErrors += page.freeRungErrors;
    merged.errors += page.errors;
    merged.missed += page.missed;
    merged.deferred += page.deferred;
    merged.skipped += page.skipped;

    if (page.reason === "no_capable_rung") {
      noCapableRung = true;
    }

    merged.spotifyDeferredBudget += page.spotifyDeferredBudget;
    merged.spotifyDeferredWindow += page.spotifyDeferredWindow;
    merged.spotifyDeferredYield += page.spotifyDeferredYield;
    merged.spotifyIsrcAsks += page.spotifyIsrcAsks;

    if (page.gateState === "paused") {
      // The Worker deferred this page while due-work repair converges. The firing stops without
      // re-asking; the pages before it keep their counts and make the pause partial.
      Object.assign(merged, dueWorkRepairPendingGate(merged));
      break;
    }

    if (!page.ok) {
      merged.ok = false;
      merged.error ??= page.error;
      break;
    }

    if (pulled < ask) {
      break; // a short page = the queue ran dry; asking again buys nothing.
    }

    remaining -= pulled;
  }

  // The due-work pause already owns `reason` when it fired; never overwrite a gate's own account.
  if (merged.reason === null && noCapableRung && merged.produced === 0) {
    merged.reason = "no_capable_rung";
  }

  return merged;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/** Parse `--limit N` (an attended backlog burn); default is the hourly `FLUNCLE_ANCHOR_BATCH`. */
export function parseLimitArg(argv: string[], fallback: number): number {
  const index = argv.indexOf("--limit");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(
      JSON.stringify({
        checked: 0,
        errors: 1,
        expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
        ok: false,
        produced: 0,
        queueDepth: null,
        reason: "missing_api_token",
      }),
    );
    process.exit(1);
  }

  if (!APIFY_API_TOKEN) {
    console.log(
      JSON.stringify({
        checked: 0,
        errors: 1,
        expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
        ok: false,
        produced: 0,
        queueDepth: null,
        reason: "missing_apify_token",
      }),
    );
    process.exit(1);
  }

  const limit = parseLimitArg(
    process.argv.slice(2),
    Number.isFinite(BATCH) && BATCH > 0 ? Math.trunc(BATCH) : 15,
  );

  const summary = await runAnchorSweep(limit, {
    fetchQueue: fetchAnchorQueue,
    log,
    now: () => Date.now(),
    readPreflight: readAnchorPreflight,
    report: reportAnchor,
    resolveFree: resolveAnchorFree,
    runActor: runApifyActor,
    searchDeezer: searchDeezerOnBox,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`anchor-sweep failed: ${message}`);
    console.log(
      JSON.stringify({
        checked: 0,
        error: message,
        errors: 1,
        expectedIntervalMs: ANCHOR_EXPECTED_INTERVAL_MS,
        ok: false,
        produced: 0,
        queueDepth: null,
        reason: "anchor_failed",
      }),
    );
    process.exit(1);
  });
}
