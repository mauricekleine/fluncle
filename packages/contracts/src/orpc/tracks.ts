// The `tracks` domain contract module. Owns every track-read op; a future wave
// adds an op here and one import line in `./index.ts`, touching no other
// domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  CatalogueTrackListItemSchema,
  FeedItemSchema,
  FreshAlbumSchema,
  FreshTrackSchema,
  MixCandidateSchema,
  MixtapeDTOSchema,
  TrackListItemSchema,
} from "./_shared";

/**
 * How a link or identifier came to be trusted. Mirrors `IdentityMethod` in
 * apps/web/src/lib/server/identity-envelope.ts, and a test asserts the two sets are
 * equal so neither side can gain a member alone. Every value is backed by a stored
 * column or by the recording's own primary key:
 *
 *   - `fingerprint` — Fluncle matched the audio against the official preview, either while buying a
 *     capture or while re-deriving an older one's provenance. The one method whose evidence is the
 *     SOUND rather than metadata.
 *   - `isrc` — an ISRC equality decided it.
 *   - `operator` — a human read the evidence and ruled.
 *   - `pk-derived` — the identifier is the recording's origin, not a lookup result.
 *   - `publish` — the link arrived with the add and was re-read through the platform's
 *     own API. No check ran because nothing needed checking: the id is the identity.
 *   - `search` — the full verified match cleared.
 *   - `search-subset` — the narrower fallback cleared, on a weaker artist match paid
 *     for with a tighter duration one. Kept apart from `search` on purpose.
 *   - `unknown-legacy` — Fluncle holds no record of how, rather than the check being weak.
 */
export const IdentityMethodSchema = z
  .enum([
    "fingerprint",
    "isrc",
    "operator",
    "pk-derived",
    "publish",
    "search",
    "search-subset",
    "unknown-legacy",
  ])
  .describe("How the identifier or link came to be trusted.");

/**
 * Why a Spotify look will not happen. Derived from the same predicate the acquisition
 * worklist itself is built on, so the answer here and the queue's behaviour cannot
 * disagree. A closed set: each value names a condition of the recording's own row.
 */
const IdentityRefusalSchema = z
  .enum(["attempt-cap-reached", "credit-not-an-identity", "dismissed", "duplicate", "no-duration"])
  .describe("Which condition of the recording stops Fluncle looking again.");

/**
 * One platform's or identifier's answer. The `state` field is the discriminant, and
 * the four negative states are the point of this whole response: Fluncle says when he
 * looked and found nothing, when nobody has looked yet, when he will not look, and when
 * he covers no such link at all, instead of leaving a caller to read silence.
 */
const IdentityStateSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("verified"),
    url: z.string().optional(),
    value: z.string().optional(),
    verification: z.object({
      at: z.string().nullable(),
      atMeaning: z
        .enum(["attempted", "verified"])
        .nullable()
        .describe(
          "What the timestamp means: the moment Fluncle wrote the link, or the moment a look concluded. Null where Fluncle holds no timestamp.",
        ),
      method: IdentityMethodSchema,
      source: z
        .string()
        .nullable()
        .describe("Which source turned up the candidate, where one is recorded."),
    }),
  }),
  z.object({
    attempts: z
      .number()
      .optional()
      .describe(
        "Total concluded looks. Present only where a count is kept; absent where the stored number is a spending budget rather than a tally.",
      ),
    cap: z.number().nullable(),
    lastAttemptedAt: z.string().nullable(),
    retry: z.enum(["capped", "recheckable", "single-shot"]),
    state: z.literal("absent"),
    terminal: z
      .boolean()
      .nullable()
      .describe("Whether Fluncle will look again. Null where nothing stored settles it."),
  }),
  z.object({ reason: IdentityRefusalSchema, state: z.literal("refused") }),
  z.object({ state: z.literal("unattempted") }),
  z.object({ state: z.literal("unsupported") }),
]);

/**
 * One recording. `certified` is the only field that says whether Fluncle has certified
 * this recording; `logId` is carried beside it and never inferred from it, because a
 * recording can hold one without the other while a certification is being written.
 */
const IdentityRecordingSchema = z.object({
  artists: z.array(z.string()),
  certified: z.boolean(),
  identifiers: z.object({ isrc: IdentityStateSchema, mbRecordingId: IdentityStateSchema }),
  links: z.object({
    appleMusic: IdentityStateSchema,
    beatport: IdentityStateSchema,
    deezer: IdentityStateSchema,
    discogs: IdentityStateSchema,
    spotify: IdentityStateSchema,
    tidal: IdentityStateSchema,
    youtube: IdentityStateSchema,
  }),
  logId: z.string().nullable(),
  relation: z
    .union([
      z.literal("ambiguous"),
      z.literal("canonical"),
      z.templateLiteral(["duplicate-of:", z.string()]),
    ])
    .describe(
      "How this recording stands to the others the key returned: canonical, ambiguous, or duplicate-of:<trackId>.",
    ),
  title: z.string(),
  trackId: z.string(),
});

/**
 * The identity answer. Always an array, because an ISRC or a MusicBrainz recording id
 * can name more than one recording in the archive and picking a winner silently is the
 * behaviour this response exists to avoid.
 *
 * That array is also what lets a BATCH answer in the SAME shape rather than a second one: up to 20
 * comma-separated ISRCs come back as one `recordings` list holding every match, in the order the
 * keys were supplied, each recording carrying its own `identifiers.isrc.value` so a caller maps an
 * answer back to the key that earned it. A key that matched nothing contributes no recording. The
 * single-key response is byte-for-byte what it always was.
 */
export const IdentityEnvelopeSchema = z.object({
  meta: z.object({
    asOf: z.string(),
    attribution: z.string(),
    contact: z.string().describe("Where to write when an answer here is wrong."),
  }),
  recordings: z.array(IdentityRecordingSchema),
});

/**
 * `get_track` → `GET /tracks/{idOrLogId}` (operationId `getTrack`).
 *
 * Public read of a single finding by its Spotify trackId OR its Log ID — the
 * lookup the enrichment agent uses to turn its input into track metadata. A Log
 * ID can also resolve to a mixtape, so the response is the discriminated
 * `{ ok: true } & ({ track } | { mixtape })` envelope (mirrors `TrackGetResponse`
 * in ../index.ts, plus the mixtape arm the live route already serves).
 *
 * THE IDENTITY PROJECTION (RFC dnb-identity-graph, Unit 2). A set of query params turns
 * the same op into the identity answer — the recording's identifiers and platform
 * links, each carrying whether Fluncle holds it, looked and missed, will not look, or
 * covers no such link:
 *
 *   - `identity=1` — return the identity answer for the recording named in the path.
 *   - `isrc=<ISRC>` — look the recording up by ISRC instead. Always the identity answer.
 *     Accepts up to 20 comma-separated ISRCs; see the batch note below.
 *   - `mbid=<uuid>` — look it up by MusicBrainz recording id. Always the identity answer.
 *   - `spotify=<link>` — look it up by Spotify track. Accepts a full `open.spotify.com/track/…`
 *     URL (locale segment and tracking parameters and all), a `spotify:track:<id>` URI, or a bare
 *     22-character id.
 *   - `deezer=<link>` — look it up by Deezer track. Accepts a full `deezer.com/track/…` URL
 *     (locale segment and tracking parameters and all) or a bare numeric id.
 *
 * THE PLATFORM KEYS are for the caller who holds a LINK rather than an identifier, which is what a
 * share sheet and a playlist export actually hand out. Both resolve by equality on stored columns —
 * a Spotify link against the row's own key and its `spotify_uri`, a Deezer link against
 * `deezer_track_id` — never by pattern match. Beatport is deliberately absent: Fluncle stores a
 * Beatport URL and no Beatport id, so the only available match would be a suffix `like` over a
 * growing table, which is the one shape this read must not take.
 *
 * THE KEY IS EXCLUSIVE. Exactly one of the lookup keys may be supplied, and the
 * path segment counts as one of them: pass a single `-` in the path when the key rides
 * a query param (`GET /tracks/-?isrc=GBABC1234567`). Two keys at once is a 422, as is a
 * key that is not a well-formed ISRC, UUID, Spotify id, or Deezer id, as is a batch of
 * more than 20 ISRCs. Every one of those is thrown IN-HANDLER,
 * on the `search_tracks` precedent: the input schema stays tolerant optional strings,
 * because oRPC's own schema rejection emits a 400 and the honest answer to a
 * well-formed request carrying an unusable value is a 422.
 *
 * THE BATCH IS THE SAME OP AND THE SAME SHAPE, because the answer was already a list (see
 * `IdentityEnvelopeSchema`) — a caller sending one ISRC reads exactly what they read before. What
 * it is NOT is a discount: the dials count KEYS, so a 20-ISRC request spends 20 of the per-minute
 * allowance and 20 of the daily one. The saving is the round trip, never the allowance.
 *
 * A key that matches nothing is a 404, and carries no invitation to submit the
 * recording; a batch 404s only when NONE of its keys matched. The identity reads are rate limited
 * per caller; the plain read is not.
 */
export const getTrack = oc
  .route({
    method: "GET",
    operationId: "getTrack",
    path: "/tracks/{idOrLogId}",
    summary:
      "Get a finding or mixtape by Spotify trackId or Log ID, or a recording's identifiers and links by ISRC, MusicBrainz id, or a Spotify or Deezer link",
    tags: ["Tracks"],
  })
  .input(
    z.object({
      deezer: z
        .string()
        .optional()
        .describe(
          "Look it up by a Deezer track URL or a bare Deezer track id. Pass a single - in the path.",
        ),
      idOrLogId: z
        .string()
        .describe(
          "A Spotify trackId or a Log ID. A single - when the key rides a query parameter instead.",
        ),
      identity: z
        .string()
        .optional()
        .describe("Any value turns on the identity answer for the recording in the path."),
      isrc: z
        .string()
        .optional()
        .describe(
          "Look the recording up by ISRC instead, or by up to 20 comma-separated ISRCs. Pass a single - in the path.",
        ),
      mbid: z
        .string()
        .optional()
        .describe("Look it up by MusicBrainz recording id. Pass a single - in the path."),
      spotify: z
        .string()
        .optional()
        .describe(
          "Look it up by a Spotify track URL, a spotify:track: URI, or a bare Spotify track id. Pass a single - in the path.",
        ),
    }),
  )
  .output(
    z.union([
      z.object({ ok: z.literal(true), track: TrackListItemSchema }),
      z.object({ mixtape: MixtapeDTOSchema, ok: z.literal(true) }),
      z.object({ identity: IdentityEnvelopeSchema, ok: z.literal(true) }),
    ]),
  );

/**
 * `list_findings` → `GET /findings` (operationId `listFindings`).
 *
 * The public merged FEED — findings interleaved with published mixtapes, newest FOUND first,
 * keyset-paginated. This is the found-order stream the homepage, the feeds, and the newsletter
 * agent read (the day Fluncle found each one — the Found Rule), the twin of the release-ordered
 * `list_tracks` enumerator below. The query params mirror the live route exactly:
 *   - `limit`   — page size (default 16, clamped to 48). Kept as a raw string and
 *                 parsed in-handler so an invalid value degrades to the default
 *                 exactly as the live route does (rather than 400-ing on a
 *                 non-numeric query — coercion would reject `?limit=abc`).
 *   - `cursor`  — the opaque base64url keyset cursor from a prior page's
 *                 `nextCursor`.
 *   - `since` / `until` — the newsletter agent's discovery window (ISO 8601).
 *                 When EITHER is present the feed is findings-only (mixtapes are
 *                 dropped), matching the live `includeMixtapes` gate.
 *
 * Every param is a tolerant optional string: the live route never rejects a
 * malformed query, it degrades, so the contract accepts any string and the
 * handler ports the exact parse/clamp logic.
 *
 * The response is the `FeedListPage` itself — NO `ok` envelope (the page is the
 * body, mirroring `TracksResponse` in ../index.ts).
 */
export const listFindings = oc
  .route({
    method: "GET",
    operationId: "listFindings",
    path: "/findings",
    summary: "List the feed of findings and published mixtapes, newest found first",
    tags: ["Tracks"],
  })
  .input(
    z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
    }),
  )
  .output(
    z.object({
      nextCursor: z.string().optional(),
      totalCount: z.number(),
      tracks: z.array(FeedItemSchema),
    }),
  );

/**
 * `list_tracks` → `GET /tracks` (operationId `listTracks`).
 *
 * The whole-archive ENUMERATOR — every track Fluncle holds, findings and the quieter rows alike,
 * newest RELEASE first, one numbered page at a time. This is the machine twin of the web `/tracks`
 * page: it reads the SAME hosted-proven hub shape, so the two never disagree. The certified findings
 * carry their `logId` coordinate + cover; the uncertified rows carry neither (the Unlit Rule, in the
 * row shape). Distinct from the found-order `list_findings` feed above: this is ordered by RELEASE
 * date (when the tune came OUT), never the day Fluncle found it (the Found Rule).
 *
 *   - `page`      — the 1-based page number (a tolerant optional string, default 1). Past-the-end is a
 *                   404, never a clamp to page 1.
 *   - `certified` — the tri-state filter: `true` returns only the certified findings, `false` only the
 *                   rest, omitted returns everything. This is the ONE filter on the enumerator.
 *
 * The response mirrors the `/albums` + `/labels` hub envelope: `{ ok: true, tracks, page, pageCount,
 * total }`.
 */
export const listTracks = oc
  .route({
    method: "GET",
    operationId: "listTracks",
    path: "/tracks",
    summary: "List every track Fluncle holds, newest release first, one page at a time",
    tags: ["Tracks"],
  })
  .input(
    z.object({
      certified: z.enum(["true", "false"]).optional(),
      page: z.string().optional(),
    }),
  )
  .output(
    z.object({
      ok: z.literal(true),
      page: z.number(),
      pageCount: z.number(),
      total: z.number(),
      tracks: z.array(CatalogueTrackListItemSchema),
    }),
  );

/**
 * `get_random_track` → `GET /tracks/random` (operationId `getRandomTrack`).
 *
 * One random certified finding, mapped like every other list item. The success
 * body is the `{ ok: true, track }` envelope (mirrors `RandomTrackResponse` in
 * ../index.ts). An empty archive is a 404 — handled by the rails error encoder,
 * not the output schema.
 */
export const getRandomTrack = oc
  .route({
    method: "GET",
    operationId: "getRandomTrack",
    path: "/tracks/random",
    summary: "Get one random finding",
    tags: ["Tracks"],
  })
  .output(z.object({ ok: z.literal(true), track: TrackListItemSchema }));

/**
 * `list_similar_tracks` → `GET /tracks/{idOrLogId}/similar` (operationId
 * `listSimilarTracks`).
 *
 * The N sonically-nearest findings to the given one — the automatic "more like this"
 * cluster (docs/track-lifecycle.md). Loads the target's MuQ audio
 * embedding, cosine-ranks it against every other coordinate-bearing finding's
 * embedding, and returns the top-N (self excluded, similarity order). A public read;
 * the same op backs the `/log` "more like this" row and a future radio "play
 * something like this" hook.
 *
 * `limit` is a tolerant optional string (default 6, clamped to 24), parsed in-handler
 * so a bad value degrades to the default rather than 400-ing — mirrors `list_findings`.
 * An unknown coordinate, a finding with no embedding yet (the embed cron hasn't
 * drained it), or an otherwise-empty archive all yield `{ ok: true, findings: [] }` —
 * a quiet empty row, never an error.
 */
export const listSimilarTracks = oc
  .route({
    method: "GET",
    operationId: "listSimilarTracks",
    path: "/tracks/{idOrLogId}/similar",
    summary: "List the sonically-nearest findings to one (by Spotify trackId or Log ID)",
    tags: ["Tracks"],
  })
  .input(z.object({ idOrLogId: z.string(), limit: z.string().optional() }))
  .output(z.object({ findings: z.array(TrackListItemSchema), ok: z.literal(true) }));

/**
 * `list_mixable_tracks` → `GET /tracks/{idOrLogId}/mixable` (operationId
 * `listMixableTracks`).
 *
 * The tracks that mix cleanly OUT of the given one, ranked by the mixability engine
 * (`lib/server/mixability.ts`) — a harmonic next-track finder with a dense texture
 * tiebreak and a live MuQ sonic term. The rail behind `/mix`.
 *
 * CANDIDATES ARE THE WHOLE ARCHIVE, not just the findings. Any track with a key is
 * rankable (the key is the engine's mandatory floor), so a track Fluncle has never
 * certified competes for the rail on exactly the same terms as one he has — which is what
 * makes the tool get BETTER as the archive grows rather than merely bigger. Each row says
 * which it is with `certified`, and nothing else: the uncertified tier has no public name
 * (DESIGN.md's Unlit Rule), so the flag picks a visual register and never a label. A row
 * with `certified: false` has no `logId` and cannot be given one — see `MixTrackSchema`.
 *
 * THE RAIL IS ORDERED BY ADJACENCY TO THE TRACK YOU JUST PLAYED — mixability × how close a
 * candidate sits to `idOrLogId` itself, which is the chain's last track. One probe, never a
 * fold and never a centroid: what follows a tune is a fact about THAT tune, and the chain
 * (`exclude`) is what lets the set drift as it goes. Every candidate still mixes clean;
 * adjacency only chooses among the clean ones.
 *
 * `taste` — a comma-separated list of artist slugs (`list_mixable_artists`) — is ACCEPTED and
 * no longer orders this rail; it used to seed a multi-artist taste fold. It remains meaningful
 * where a seed genuinely decides something: `list_mix_openers` picks what a set OPENS with. The
 * parameter stays on the wire so existing `/mix` links, the web builder and the mobile app all
 * keep working unchanged.
 *
 * `limit` is a tolerant optional string (default 12, clamped to 32), parsed in-handler
 * so a bad value degrades rather than 400-ing (mirrors `list_similar_tracks`).
 * `exclude` is a comma-separated list of the already-chained tracks — Log IDs or Spotify
 * track ids, mixed freely, because a chain now holds both kinds. Excluded SERVER-SIDE so
 * a deep chain can't silently empty the rail.
 *
 * Public-unauth (keys/BPMs are already public on every track chip). An unknown coordinate
 * / a target scored on nothing / an empty archive all yield `{ ok: true, findings: [] }` —
 * a quiet empty rail, never a fault.
 */
export const listMixableTracks = oc
  .route({
    method: "GET",
    operationId: "listMixableTracks",
    path: "/tracks/{idOrLogId}/mixable",
    summary: "List the tracks that mix cleanly out of one (by Spotify trackId or Log ID)",
    tags: ["Tracks"],
  })
  .input(
    z.object({
      exclude: z.string().optional(),
      idOrLogId: z.string(),
      limit: z.string().optional(),
      taste: z.string().optional(),
    }),
  )
  .output(z.object({ findings: z.array(MixCandidateSchema), ok: z.literal(true) }));

/** The `tracks` domain's ops, merged into the root contract by `./index.ts`. */
/**
 * `list_fresh` → `GET /tracks/fresh` (operationId `listFresh`).
 *
 * WHAT JUST CAME OUT: the newest drum & bass RELEASES over a trailing 30-day window, newest release
 * first, flat and capped (`limit`, a tolerant string, default 50, max 100). Ordered by
 * `tracks.release_date` — NOT `findings.added_at` — so this is "just landed", never "Fluncle found"
 * (VOICE.md's Found Rule; the opposite date axis from `list_findings`). Every track is unlit-safe: an
 * uncertified catalogue row carries no `logId` and no cover (the Unlit Rule, structural in the DTO).
 * `albums` are the album entities those releases sit on.
 */
export const listFresh = oc
  .route({
    method: "GET",
    operationId: "listFresh",
    path: "/tracks/fresh",
    summary: "List what just came out (newest releases)",
    tags: ["Tracks"],
  })
  .input(z.object({ limit: z.string().optional() }))
  .output(
    z.object({
      albums: z.array(FreshAlbumSchema),
      tracks: z.array(FreshTrackSchema),
      windowDays: z.number(),
    }),
  );

export const tracksContract = {
  get_random_track: getRandomTrack,
  get_track: getTrack,
  list_findings: listFindings,
  list_fresh: listFresh,
  list_mixable_tracks: listMixableTracks,
  list_similar_tracks: listSimilarTracks,
  list_tracks: listTracks,
};
