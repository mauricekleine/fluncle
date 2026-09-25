import { oc } from "@orpc/contract";
import * as z from "zod";

export const NoteGateSchema = z
  .object({
    maxOverlap: z.number(),

    minPhraseWords: z.number(),
  })
  .meta({ id: "NoteGate" });

export const NoteRejectionSchema = z
  .object({
    artUrl: z.string().optional(),
    artists: z.array(z.string()),

    attempts: z.number(),
    createdAt: z.string(),
    id: z.string(),
    logId: z.string().optional(),
    maxOverlap: z.number(),
    minPhraseWords: z.number(),

    neighborLogId: z.string().optional(),
    neighborNote: z.string().optional(),

    note: z.string(),
    overlap: z.number(),

    phrase: z.string(),
    resolution: z.enum(["accepted", "discarded"]).optional(),
    resolvedAt: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "NoteRejection" });

export const listNoteRejections = oc
  .route({
    method: "GET",
    operationId: "listNoteRejections",
    path: "/admin/note-rejections",
    summary: "The auto-notes the echo gate held back (with the reason + the gate's dials)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      open: z.string().optional(),
      trackId: z.string().optional(),
    }),
  )
  .output(
    z.object({
      gate: NoteGateSchema,
      ok: z.literal(true),
      rejections: z.array(NoteRejectionSchema),
    }),
  );

export const resolveNoteRejection = oc
  .route({
    method: "POST",
    operationId: "resolveNoteRejection",
    path: "/admin/note-rejections/{id}/resolve",
    summary: "Rule on a held auto-note: keep it (writes it) or bin it (operator)",
    tags: ["Admin"],
  })
  .input(z.object({ id: z.string(), resolution: z.enum(["accepted", "discarded"]) }))
  .output(
    z.object({
      note: z.string().optional(),
      ok: z.literal(true),
      rejection: NoteRejectionSchema,

      skipped: z.boolean(),
    }),
  );

export const updateNoteGate = oc
  .route({
    method: "PATCH",
    operationId: "updateNoteGate",
    path: "/admin/note-gate",
    summary: "Retune the auto-note echo gate's thresholds (operator; a flip, not a deploy)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      maxOverlap: z.number().optional(),
      minPhraseWords: z.number().optional(),
    }),
  )
  .output(z.object({ gate: NoteGateSchema, ok: z.literal(true) }));

export const adminNotesContract = {
  list_note_rejections: listNoteRejections,
  resolve_note_rejection: resolveNoteRejection,
  update_note_gate: updateNoteGate,
};
