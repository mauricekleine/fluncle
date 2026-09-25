import { oc } from "@orpc/contract";
import * as z from "zod";

const LogbookEntrySchema = z
  .object({
    body: z.string(),
    generatedAt: z.string(),
    generatedBy: z.enum(["agent", "operator"]),
    sector: z.number(),
    title: z.string(),
  })
  .meta({ id: "LogbookEntry" });

const LogbookGapFindingSchema = z
  .object({
    artists: z.array(z.string()),
    contextNote: z.string().optional(),
    logId: z.string(),
    note: z.string().optional(),
    observationScript: z.string().optional(),
    posterUrl: z.string(),
    title: z.string(),
  })
  .meta({ id: "LogbookGapFinding" });

const LogbookGapSchema = z
  .object({
    date: z.string(),
    findings: z.array(LogbookGapFindingSchema),
    sector: z.number(),
  })
  .meta({ id: "LogbookGap" });

const LogbookSpentEntrySchema = z
  .object({
    closer: z.string(),
    opener: z.string(),
    sector: z.number(),
    title: z.string(),
  })
  .meta({ id: "LogbookSpentEntry" });

const LogbookEntryEnvelope = z.object({
  entry: LogbookEntrySchema,
  ok: z.literal(true),
  skipped: z.boolean().optional(),
});

export const listLogbookGaps = oc
  .route({
    method: "GET",
    operationId: "listLogbookGaps",
    path: "/admin/logbook/gaps",
    summary: "List sector-days with findings but no logbook entry (oldest first)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.string().optional() }))
  .output(
    z.object({
      gaps: z.array(LogbookGapSchema),
      ok: z.literal(true),
      spent: z.array(LogbookSpentEntrySchema),
    }),
  );

export const createLogbookEntry = oc
  .route({
    method: "POST",
    operationId: "createLogbookEntry",
    path: "/admin/logbook/{sector}",
    summary: "Author a sector-day's logbook entry (fills an empty sector only)",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      promptVersion: z.number().int().min(0).optional(),
      sector: z.string(),
    }),
  )
  .output(LogbookEntryEnvelope);

export const updateLogbookEntry = oc
  .route({
    method: "PATCH",
    operationId: "updateLogbookEntry",
    path: "/admin/logbook/{sector}",
    summary: "Create or overwrite a sector-day's logbook entry (operator)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ sector: z.string() }))
  .output(LogbookEntryEnvelope);

export const adminLogbookContract = {
  create_logbook_entry: createLogbookEntry,
  list_logbook_gaps: listLogbookGaps,
  update_logbook_entry: updateLogbookEntry,
};
