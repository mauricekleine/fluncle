// The `admin-notes` domain contract module — the echo gate's ledger, made visible.
//
// The auto-note's echo gate refuses to STORE a note that lifts a phrase from a sonic
// neighbour or reuses its words wholesale. Shipping that gate silent was the mistake this
// domain corrects: the model's line went straight to /dev/null, so the operator could not
// read what was binned, could not judge whether the gate was right, and could not tell a
// well-set threshold from a wrong one — because the evidence was the thing being destroyed.
// A pipeline that throws work away without telling anyone cannot be supervised.
//
// Three ops:
//
//   - `list_note_rejections` — admin tier (agent-allowed read): the held notes, each with
//     the neighbour it echoed, that neighbour's note, the lifted phrase, the score, and the
//     thresholds that were in force. Also returns the gate's CURRENT dials, so any surface
//     showing a rejection can show what it was judged against. `open: false` reads the
//     settled ones — the evidence behind a retune.
//   - `resolve_note_rejection` — OPERATOR tier: the ruling. `accepted` writes the held line
//     onto the finding (through the SAME atomic fill-empty-only predicate the agent uses,
//     so an operator note that landed since is never clobbered); `discarded` agrees with the
//     gate. Overruling the gate is publish-class — it puts a line on the public /log page —
//     so an agent token 403s.
//   - `update_note_gate` — OPERATOR tier: retune the dials. They live in the `settings` KV,
//     so this is a flip, not a deploy: #502 calibrated them against a 61-note archive, that
//     was a measurement rather than a law, and the corpus is growing. When the held notes
//     say the gate is too tight, the operator must be able to act on that in one move.
//
// The gate itself is NOT weakened by any of this. It still rejects exactly what it rejected
// before; it simply no longer does it in the dark.

import { oc } from "@orpc/contract";
import * as z from "zod";

/** The echo gate's two dials, as they currently stand (the KV values, or the defaults). */
export const NoteGateSchema = z
  .object({
    // Content-word Jaccard at or above this reads as the same note wearing a new hat.
    maxOverlap: z.number(),
    // A run of consecutive shared words this long (carrying a content word) is a lift.
    minPhraseWords: z.number(),
  })
  .meta({ id: "NoteGate" });

/**
 * One held note — a line the echo gate refused to store, kept whole with the reason.
 *
 * `minPhraseWords`/`maxOverlap` are the thresholds that were in force AT REJECTION TIME,
 * snapshotted onto the row: the dials are tunable, so without the snapshot a retune would
 * silently rewrite the meaning of every past rejection.
 */
export const NoteRejectionSchema = z
  .object({
    artUrl: z.string().optional(),
    artists: z.array(z.string()),
    // How many times this finding's note has bounced while this rejection stayed open.
    // The sweep re-authors once per tick, so 2 is a normal tick; a high count is the
    // signal that the region is exhausted, or that the gate is too tight.
    attempts: z.number(),
    createdAt: z.string(),
    id: z.string(),
    logId: z.string().optional(),
    maxOverlap: z.number(),
    minPhraseWords: z.number(),
    // The neighbour it echoed hardest, and that neighbour's note as it read at the time
    // (snapshotted — the neighbour's own note can change later, and the operator has to be
    // able to read the exact PAIR the gate compared).
    neighborLogId: z.string().optional(),
    neighborNote: z.string().optional(),
    // THE EVIDENCE — the note the model actually wrote.
    note: z.string(),
    overlap: z.number(),
    // The run of words lifted from the neighbour; "" when the rejection was overlap-only.
    phrase: z.string(),
    resolution: z.enum(["accepted", "discarded"]).optional(),
    resolvedAt: z.string().optional(),
    title: z.string(),
    trackId: z.string(),
  })
  .meta({ id: "NoteRejection" });

/**
 * `list_note_rejections` → `GET /admin/note-rejections` (operationId `listNoteRejections`).
 *
 * Admin tier (agent-allowed read — a pure read that publishes nothing). Every held note
 * still waiting on the operator's eye, oldest first, plus the gate's current dials.
 * `open: "false"` reads the SETTLED rejections instead (what he kept, what he binned) —
 * the corpus-level evidence behind any retune. `trackId` narrows to one finding (the note
 * dialog's read). `{ ok, gate, rejections }`.
 */
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
      // Tolerant string tri-state, parsed in-handler (the `hasNote` query-param precedent).
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

/**
 * `resolve_note_rejection` → `POST /admin/note-rejections/{id}/resolve` (operationId
 * `resolveNoteRejection`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`). The operator's ruling on a held note.
 *
 * `accepted` — he read it and it is good. The line is written onto the finding through
 * `fillEmptyNote`, the SAME atomic `and (note is null or trim(note) = '')` predicate the
 * agent's own write takes, so a note that landed since the rejection can never be
 * clobbered — if one did, `skipped: true` comes back and the standing note is untouched.
 * The accepted line is deliberately NOT re-run through the echo gate: its verdict is
 * precisely what is being overruled, and a human reading both notes side by side is the
 * higher authority. Accepting puts a line on the public `/log` page, which is why this is
 * operator tier and an agent token 403s.
 *
 * `discarded` — the gate was right. The finding stays note-less and stays queued; the next
 * sweep tick is free to author a better line. Binning a held note blocks nothing.
 *
 * Codes: `not_found`/404, `already_resolved`/409.
 */
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
      // The finding's note after the ruling (the accepted line, or whatever already stood).
      note: z.string().optional(),
      ok: z.literal(true),
      rejection: NoteRejectionSchema,
      // `true` when `accepted` did NOT write because the finding already carried a note —
      // the fill-empty-only rail, observable. The rejection resolves either way.
      skipped: z.boolean(),
    }),
  );

/**
 * `update_note_gate` → `PATCH /admin/note-gate` (operationId `updateNoteGate`).
 *
 * OPERATOR tier (`adminAuth` + `operatorGuard`). Retune the echo gate's dials. They live in
 * the `settings` KV — the house's one flag store, whose entire reason for existing is that
 * an automation's behaviour must be changeable without a build and a Cloudflare rebuild.
 *
 * Each dial is independently settable (an absent field leaves it alone) and BOUNDED: a
 * `maxOverlap` of 0 would reject every note and a `minPhraseWords` of 1 would reject every
 * sentence sharing a word, so the gate is held between values where it can still be wrong
 * but cannot be absurd. Tuning the gate changes what the archive will and won't say about
 * itself, so an agent token 403s. Codes: `invalid_request`/400.
 */
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

/** The `admin-notes` domain's ops, merged into the root contract by `./index.ts`. */
export const adminNotesContract = {
  list_note_rejections: listNoteRejections,
  resolve_note_rejection: resolveNoteRejection,
  update_note_gate: updateNoteGate,
};
