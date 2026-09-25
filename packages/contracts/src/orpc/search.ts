import { oc } from "@orpc/contract";
import * as z from "zod";
import { TrackSearchResultSchema } from "./_shared.js";

export const searchTracks = oc
  .route({
    method: "GET",
    operationId: "searchTracks",
    path: "/search",
    summary: "Search Spotify for finding candidates",
    tags: ["Search"],
  })
  .input(z.object({ q: z.string().max(512).optional() }))
  .output(z.object({ ok: z.literal(true), results: z.array(TrackSearchResultSchema) }));

export const SearchFiltersSchema = z
  .object({
    album: z.string().optional(),
    artist: z.string().optional(),
    bpmMax: z.number().optional(),
    bpmMin: z.number().optional(),
    key: z.string().optional(),
    label: z.string().optional(),
    sound: z.string().optional(),
    soundsLike: z.string().optional(),
    soundsLikeArtists: z.array(z.string()).max(6).optional(),
    text: z.string().optional(),
    yearMax: z.number().optional(),
    yearMin: z.number().optional(),
  })
  .meta({ id: "SearchFilters" });

export const SearchHitSchema = z
  .object({
    album: z.string().optional(),
    albumImageUrl: z.string().optional(),
    artists: z.array(z.string()),
    bpm: z.number().optional(),

    certified: z.boolean(),
    durationMs: z.number().optional(),
    galaxy: z.string().optional(),
    key: z.string().optional(),
    label: z.string().optional(),

    logId: z.string().optional(),
    previewable: z.boolean().optional(),
    releaseDate: z.string().optional(),
    similar: z.boolean().optional(),
    spotifyUrl: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "SearchHit" });

export const SearchEntitySchema = z
  .object({
    imageUrl: z.string().optional(),
    kind: z.enum(["album", "artist", "galaxy", "label", "mixtape"]),
    name: z.string(),
    slug: z.string(),

    url: z.string().optional(),
  })
  .meta({ id: "SearchEntity" });

export const SearchKindSchema = z
  .enum(["coordinate", "empty", "entity", "filters", "sonic", "token"])
  .meta({ id: "SearchKind" });

export const searchArchive = oc
  .route({
    method: "GET",
    operationId: "searchArchive",
    path: "/search/archive",
    summary: "Search Fluncle's archive by coordinate, entity, full-text, or natural language",
    tags: ["Search"],
  })
  .input(
    z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), q: z.string().max(512) }),
  )
  .output(
    z.object({
      anchor: SearchHitSchema.optional(),

      degraded: z.boolean(),
      entities: z.array(SearchEntitySchema),

      filters: SearchFiltersSchema.optional(),
      kind: SearchKindSchema,
      ok: z.literal(true),

      redirect: z.string().optional(),
      results: z.array(SearchHitSchema),
    }),
  );

export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export type SearchHit = z.infer<typeof SearchHitSchema>;

export type SearchEntity = z.infer<typeof SearchEntitySchema>;

export type SearchKind = z.infer<typeof SearchKindSchema>;

export const searchContract = {
  search_archive: searchArchive,
  search_tracks: searchTracks,
};
