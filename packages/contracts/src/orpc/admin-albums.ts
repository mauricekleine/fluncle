import { oc } from "@orpc/contract";
import * as z from "zod";

const DescribeAlbumBodySchema = z.looseObject({
  bio: z.unknown().optional(),
  dryRun: z.unknown().optional(),
  finalAttempt: z.boolean().optional(),
  promptVersion: z.number().int().min(0).optional(),
});

export const describeAlbum = oc
  .route({
    method: "POST",
    operationId: "describeAlbum",
    path: "/admin/albums/{slug}/bio",
    summary: "Auto-author an album's voiced bio (fills an empty bio only)",
    tags: ["Admin"],
  })
  .input(DescribeAlbumBodySchema.extend({ slug: z.string() }))
  .output(
    z.object({
      bio: z.string(),

      dryRun: z.literal(true).optional(),

      gateBypassed: z.literal(true).optional(),
      ok: z.literal(true),

      skipped: z.boolean().optional(),
      slug: z.string(),

      voiceViolations: z.array(z.string()).optional(),
    }),
  );

export const draftAlbumBio = oc
  .route({
    method: "GET",
    operationId: "draftAlbumBio",
    path: "/admin/albums/{slug}/bio-draft",
    summary: "Assemble a ready-to-author bio prompt for an album (Worker-side grounding)",
    tags: ["Admin"],
  })
  .input(z.object({ slug: z.string() }))
  .output(
    z.object({
      findingCount: z.number(),
      found: z.boolean(),
      hasFacts: z.boolean(),
      name: z.string(),
      prompt: z.string(),
      promptVersion: z.number(),
    }),
  );

const AlbumBioWorkItemSchema = z
  .object({ id: z.string(), name: z.string(), slug: z.string() })
  .meta({ id: "AlbumBioWorkItem" });

export const listAlbumsMissingBio = oc
  .route({
    method: "GET",
    operationId: "listAlbumsMissingBio",
    path: "/admin/albums/bio-queue",
    summary: "List albums with findings but no bio yet, oldest first (the bio worklist)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.string().optional() }))
  .output(z.object({ albums: z.array(AlbumBioWorkItemSchema), ok: z.literal(true) }));

export const adminAlbumsContract = {
  describe_album: describeAlbum,
  draft_album_bio: draftAlbumBio,
  list_albums_missing_bio: listAlbumsMissingBio,
};
