import { oc } from "@orpc/contract";
import * as z from "zod";

export const SavedFindingSchema = z
  .object({
    artists: z.array(z.string()),

    href: z.string().optional(),
    imageUrl: z.string().optional(),
    logId: z.string().optional(),
    note: z.string().optional(),
    savedAt: z.string(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "SavedFinding" });

const SaveFindingBodySchema = z.looseObject({
  logId: z.unknown().optional(),
  note: z.unknown().optional(),
  trackId: z.unknown().optional(),
});

export const listPrivateSavedFindings = oc
  .route({
    method: "GET",
    operationId: "listPrivateSavedFindings",
    path: "/me/saved-findings",
    summary: "List the signed-in user's saved findings",
    tags: ["Me"],
  })
  .output(z.object({ ok: z.literal(true), savedFindings: z.array(SavedFindingSchema) }));

export const savePrivateFinding = oc
  .route({
    method: "POST",
    operationId: "savePrivateFinding",
    path: "/me/saved-findings",
    summary: "Save a finding for the signed-in user",
    tags: ["Me"],
  })
  .input(SaveFindingBodySchema)
  .output(
    z.object({
      ok: z.literal(true),
      savedFinding: z.object({
        logId: z.string().optional(),
        note: z.string().optional(),
        savedAt: z.string(),
        trackId: z.string(),
      }),
    }),
  );

export const unsavePrivateFinding = oc
  .route({
    method: "DELETE",
    operationId: "unsavePrivateFinding",
    path: "/me/saved-findings/{trackId}",
    summary: "Remove a finding from the signed-in user's saved list",
    tags: ["Me"],
  })
  .input(z.object({ trackId: z.string() }))
  .output(z.object({ ok: z.literal(true) }));

export const meSavedContract = {
  list_private_saved_findings: listPrivateSavedFindings,
  save_private_finding: savePrivateFinding,
  unsave_private_finding: unsavePrivateFinding,
};
