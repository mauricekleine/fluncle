// The `admin-editions` domain contract module — the newsletter edition authoring +
// send control plane (docs/rfcs/newsletter-own-the-stack.md §3.3). Built on the
// `admin-mixtapes` pattern. Everything nests under `/admin/newsletter/editions`.
//
// VERIFIED auth tiers (enforced in the handlers, not the contract):
//   - `create_edition` / `update_edition` — admin tier (`adminAuth`): drafting is
//     AGENT-ALLOWED. The Friday agent authors + persists the draft.
//   - `send_edition` — operator tier (`adminAuth` + `operatorGuard`): the send is
//     the human gate (the old Loops dashboard tap). A valid agent token gets a 403.
//
// Mutating bodies stay LOOSE/passthrough — the server `editions` module validates
// and throws its own codes, so the contract must not pre-reject.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { EditionDTOSchema } from "./_shared";

/** The `{ edition, ok }` envelope every admin edition op returns. */
const EditionEnvelope = z.object({ edition: EditionDTOSchema, ok: z.literal(true) });

/**
 * `list_editions_admin` → `GET /admin/newsletter/editions` (operationId
 * `listEditionsAdmin`).
 *
 * Admin tier — agent-allowed. The full edition list INCLUDING drafts (distinct from
 * the public `list_editions`, which is sent-only). The Friday cron reads this from a
 * fresh session to find an unsent draft to re-offer before authoring a new one, and
 * to read the last sent edition's `windowUntil` cutoff. Preserves `{ editions, ok }`.
 */
export const listEditionsAdmin = oc
  .route({
    method: "GET",
    operationId: "listEditionsAdmin",
    path: "/admin/newsletter/editions",
    summary: "List every newsletter edition (including drafts)",
    tags: ["Admin"],
  })
  .output(z.object({ editions: z.array(EditionDTOSchema), ok: z.literal(true) }));

/**
 * `create_edition` → `POST /admin/newsletter/editions` (operationId `createEdition`).
 *
 * Admin tier — drafting is agent-allowed. LOOSE body — `createEdition` validates.
 * Creates a DRAFT (no number yet). Preserves `{ edition, ok }`.
 */
export const createEdition = oc
  .route({
    method: "POST",
    operationId: "createEdition",
    path: "/admin/newsletter/editions",
    summary: "Create a newsletter edition (draft)",
    tags: ["Admin"],
  })
  .input(z.looseObject({}))
  .output(EditionEnvelope);

/**
 * `update_edition` → `PATCH /admin/newsletter/editions/{id}` (operationId
 * `updateEdition`).
 *
 * Admin tier — editing a draft is agent-allowed. LOOSE body — `updateEdition`
 * validates (and 409s on a sent edition). Preserves `{ edition, ok }`.
 */
export const updateEdition = oc
  .route({
    method: "PATCH",
    operationId: "updateEdition",
    path: "/admin/newsletter/editions/{id}",
    summary: "Update a draft edition's payload/subject/window",
    tags: ["Admin"],
  })
  .input(z.looseObject({ id: z.string() }))
  .output(EditionEnvelope);

/**
 * `send_edition` → `POST /admin/newsletter/editions/{id}/send` (operationId
 * `sendEdition`).
 *
 * OPERATOR tier — the explicit human gate. Renders the email HTML from the stored
 * payload, creates + sends the Resend broadcast, and mints the sequential number.
 * Optional `scheduledAt` defers the send. LOOSE body. Preserves `{ edition, ok }`.
 */
export const sendEdition = oc
  .route({
    method: "POST",
    operationId: "sendEdition",
    path: "/admin/newsletter/editions/{id}/send",
    summary: "Send an edition (Resend broadcast) and mint its number",
    tags: ["Admin"],
  })
  .input(z.looseObject({ id: z.string(), scheduledAt: z.unknown().optional() }))
  .output(EditionEnvelope);

/** The `admin-editions` domain's ops, merged into the root contract by `./index.ts`. */
export const adminEditionsContract = {
  create_edition: createEdition,
  list_editions_admin: listEditionsAdmin,
  send_edition: sendEdition,
  update_edition: updateEdition,
};
