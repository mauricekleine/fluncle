// The `admin-albums` domain contract module — the album entity's admin surface. An album
// carries no operator control (no crawl-seed ruling, no alias review — the album-entity.md
// note: an album is not a crawl seed, so there is nothing to rule on), so this domain is the
// voiced-bio engine and nothing else, on the `admin-labels` bio pattern.
//
// ── The voiced bio: the entity-bio engine (agent-tier author + its worklist) ──────────
// `describe_album` is the entity sibling of `note_track`: the on-box sweep authors the
// album's short Fluncle-voiced bio (grounded in Firecrawl facts + the tracks Fluncle has
// logged off it), and this step VOICE-GATES it and writes it FILL-EMPTY-ONLY — an operator
// bio is never clobbered. `list_albums_missing_bio` is its worklist. Both agent tier: the
// box's agent token drives them, the `note_track` / `describe_label` precedent. This is
// AGENT tier throughout: authoring a bio is enrichment, and an album carries no operator-tier
// ruling to sit beside it.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * The describe body (POST /admin/albums/{slug}/bio). LOOSE: the live route voice-gates
 * `bio` itself and length-bounds it. `promptVersion` is the bio's provenance (0 = the
 * registry's baked default, N = operator override N); `dryRun` runs the voice gate and
 * stores nothing.
 */
const DescribeAlbumBodySchema = z.looseObject({
  bio: z.unknown().optional(),
  dryRun: z.unknown().optional(),
  promptVersion: z.number().int().min(0).optional(),
});

/**
 * `describe_album` → `POST /admin/albums/{slug}/bio` (operationId `describeAlbum`).
 *
 * Agent tier (`adminAuth`), the `note_track` precedent: the on-box sweep has authored the
 * album's bio in Fluncle's voice (grounded in the gathered facts + the tracks Fluncle has
 * logged off it); this VOICE-GATES it (the note gate's shared scan + the bio's length
 * ceiling) and stores it into `bio` with its `bio_prompt_version` provenance + `bio_status =
 * 'resolved'`, atomically.
 *
 * SAFETY (the cardinal guarantee): it fills an EMPTY bio ONLY. An album that already carries
 * a bio — operator-written OR previously auto-authored — is a no-op (`skipped: true`); the
 * agent NEVER clobbers an existing bio. `dryRun` runs the gate and stores nothing. Codes:
 * `not_found`/404, `no_bio`/400, `bio_too_short`/422, `bio_too_long`/422, `voice_gate`/422.
 */
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
      // `true` when `dryRun` was set: the voice gate ran, NOTHING was stored.
      dryRun: z.literal(true).optional(),
      ok: z.literal(true),
      // `true` when a bio already existed and the fill-empty-only guard refused to
      // clobber it; absent on a fresh fill.
      skipped: z.boolean().optional(),
      slug: z.string(),
    }),
  );

/**
 * `draft_album_bio` → `GET /admin/albums/{slug}/bio-draft` (operationId `draftAlbumBio`).
 *
 * Agent tier (`adminAuth`), the `describe_album` sibling: the Worker-paced grounding seam.
 * The box holds no Firecrawl key and cannot enumerate the tracks it has logged off an album;
 * this READ runs the Firecrawl gather (with the Worker's key) + pulls the logged finding
 * titles (with the Worker's DB) and assembles the registered bio prompt, handing the box a
 * ready-to-author PROMPT. The box then runs `claude -p` on it and writes back via
 * `describe_album`. A pure read — it publishes nothing, and it returns only public facts
 * (web snippets + finding titles), never a secret or an internal id beyond the slug/name/count.
 *
 * `found:false` when the slug does not resolve (it never throws on a missing entity).
 * `hasFacts` reports whether Firecrawl returned any facts (false = the prompt's no-facts arm).
 */
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

/** One row of the bio worklist: an album with findings but no bio yet. */
const AlbumBioWorkItemSchema = z
  .object({ id: z.string(), name: z.string(), slug: z.string() })
  .meta({ id: "AlbumBioWorkItem" });

/**
 * `list_albums_missing_bio` → `GET /admin/albums/bio-queue` (operationId
 * `listAlbumsMissingBio`).
 *
 * Agent tier (`adminAuth`), the `list_labels_missing_bio` precedent. The bio worklist: albums
 * with at least one coordinate-bearing finding but no bio yet, oldest-first — the worklist
 * the `describe_album` cron drains. A pure read; it publishes nothing.
 */
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

/** The `admin-albums` domain's ops, merged into the root contract by `./index.ts`. */
export const adminAlbumsContract = {
  describe_album: describeAlbum,
  draft_album_bio: draftAlbumBio,
  list_albums_missing_bio: listAlbumsMissingBio,
};
