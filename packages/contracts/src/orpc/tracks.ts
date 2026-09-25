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

const IdentityRefusalSchema = z
  .enum(["attempt-cap-reached", "credit-not-an-identity", "dismissed", "duplicate", "no-duration"])
  .describe("Which condition of the recording stops Fluncle looking again.");

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

export const IdentityEnvelopeSchema = z.object({
  meta: z.object({
    asOf: z.string(),
    attribution: z.string(),
    contact: z.string().describe("Where to write when an answer here is wrong."),
  }),
  recordings: z.array(IdentityRecordingSchema),
});

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

export const getRandomTrack = oc
  .route({
    method: "GET",
    operationId: "getRandomTrack",
    path: "/tracks/random",
    summary: "Get one random finding",
    tags: ["Tracks"],
  })
  .output(z.object({ ok: z.literal(true), track: TrackListItemSchema }));

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
