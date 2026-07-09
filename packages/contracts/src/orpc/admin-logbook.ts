// The `admin-logbook` domain contract module — Fluncle's Logbook write path + the
// nightly sweep's gap/gather read. Everything nests under `/admin/logbook`. Built on
// the `admin-editions` pattern (a contract-only oRPC domain — no TanStack route
// files; oRPC owns the paths directly).
//
// VERIFIED auth tiers (enforced in the handlers, not the contract):
//   - `list_logbook_gaps`    — admin tier (`adminAuth`): the sweep's queue+material
//     read (agent-allowed, like `list_editions_admin` / the note queue). Returns the
//     eligible sector-days with their findings' internal fuel (context_note,
//     observation script) so the box's `fluncle-logbook` cron gathers in ONE call.
//   - `create_logbook_entry` — admin tier (`adminAuth`): the fill-empty-only author
//     the on-box sweep drives with its agent token (the `note_track` precedent). A
//     sector that already has an entry is a no-op (`skipped: true`).
//   - `update_logbook_entry` — operator tier (`adminAuth` + `operatorGuard`): the
//     operator's overwrite/edit path. It CAN clobber a cron-authored entry (that's
//     the point — an operator note always wins), so a valid agent token 403s.
//
// Mutating bodies stay LOOSE/passthrough — the server `logbook` module validates and
// voice-gates, throwing its own codes (`no_title`/`no_body`/`voice_gate`/…), so the
// contract must not pre-reject.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** A logbook entry row as every logbook op returns it. */
const LogbookEntrySchema = z
  .object({
    body: z.string(),
    generatedAt: z.string(),
    generatedBy: z.enum(["agent", "operator"]),
    sector: z.number(),
    title: z.string(),
  })
  .meta({ id: "LogbookEntry" });

/** A day's finding as the sweep gathers it (admin-tier — carries the internal fuel). */
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

/** One eligible sector-day the sweep can author. */
const LogbookGapSchema = z
  .object({
    date: z.string(),
    findings: z.array(LogbookGapFindingSchema),
    sector: z.number(),
  })
  .meta({ id: "LogbookGap" });

/** The `{ entry, ok }` envelope the create/update ops return (`skipped` on a create no-op). */
const LogbookEntryEnvelope = z.object({
  entry: LogbookEntrySchema,
  ok: z.literal(true),
  skipped: z.boolean().optional(),
});

/**
 * `list_logbook_gaps` → `GET /admin/logbook/gaps` (operationId `listLogbookGaps`).
 *
 * Admin tier — agent-allowed. The sweep's SELF-HEALING WINDOW read: every past
 * sector-day (before today, at/after the epoch floor) that has ≥1 published finding
 * and NO logbook entry, oldest first, bounded by `limit`. Each gap carries the day's
 * findings with their internal authoring fuel (`contextNote`, `observationScript`)
 * plus the `posterUrl` figure targets, so the box's `fluncle-logbook` cron picks a
 * day AND gathers its material in one call. Preserves `{ gaps, ok }`.
 */
export const listLogbookGaps = oc
  .route({
    method: "GET",
    operationId: "listLogbookGaps",
    path: "/admin/logbook/gaps",
    summary: "List sector-days with findings but no logbook entry (oldest first)",
    tags: ["Admin"],
  })
  .input(z.object({ limit: z.string().optional() }))
  .output(z.object({ gaps: z.array(LogbookGapSchema), ok: z.literal(true) }));

/**
 * `create_logbook_entry` → `POST /admin/logbook/{sector}` (operationId
 * `createLogbookEntry`).
 *
 * Admin tier — the on-box sweep's agent token drives it (the `note_track`
 * precedent). AUTHOR a sector-day's entry from the agent-written `title` + `body`;
 * the handler voice-GATES the body (the shared written-note gate: banned identity
 * words / earthly geography / the Dry Rule / no "we"-as-company, scanned over the
 * prose with the `[[logId]]` figure tokens stripped) and stores it.
 *
 * SAFETY (the cardinal guarantee): it fills an EMPTY sector ONLY. A sector that
 * already has an entry — operator-edited OR previously auto-authored — is a no-op
 * (`skipped: true`); the agent NEVER clobbers an existing entry. Codes:
 * `no_title`/400, `no_body`/400, `body_too_short`/422, `voice_gate`/422. LOOSE body.
 */
export const createLogbookEntry = oc
  .route({
    method: "POST",
    operationId: "createLogbookEntry",
    path: "/admin/logbook/{sector}",
    summary: "Author a sector-day's logbook entry (fills an empty sector only)",
    tags: ["Admin"],
  })
  .input(z.looseObject({ sector: z.string() }))
  .output(LogbookEntryEnvelope);

/**
 * `update_logbook_entry` → `PATCH /admin/logbook/{sector}` (operationId
 * `updateLogbookEntry`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`) — a valid agent token 403s. The
 * operator's overwrite/edit path: create-or-replace a sector's entry (title/body),
 * stamping `generatedBy = 'operator'` so the fill-empty-only agent create thereafter
 * treats it as sacred. Same voice gate as create. LOOSE body. Preserves `{ entry, ok }`.
 */
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

/** The `admin-logbook` domain's ops, merged into the root contract by `./index.ts`. */
export const adminLogbookContract = {
  create_logbook_entry: createLogbookEntry,
  list_logbook_gaps: listLogbookGaps,
  update_logbook_entry: updateLogbookEntry,
};
