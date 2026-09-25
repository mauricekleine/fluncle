import { oc } from "@orpc/contract";
import * as z from "zod";
import { EditionDTOSchema } from "./_shared";

const EditionEnvelope = z.object({ edition: EditionDTOSchema, ok: z.literal(true) });

export const listEditionsAdmin = oc
  .route({
    method: "GET",
    operationId: "listEditionsAdmin",
    path: "/admin/newsletter/editions",
    summary: "List every newsletter edition (including drafts)",
    tags: ["Admin"],
  })
  .output(z.object({ editions: z.array(EditionDTOSchema), ok: z.literal(true) }));

export const createEdition = oc
  .route({
    method: "POST",
    operationId: "createEdition",
    path: "/admin/newsletter/editions",
    summary: "Create a newsletter edition (draft)",
    tags: ["Admin"],
  })
  .input(
    z.looseObject({
      promptVersion: z.number().int().min(0).optional(),
    }),
  )
  .output(EditionEnvelope);

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

export const deleteEdition = oc
  .route({
    method: "DELETE",
    operationId: "deleteEdition",
    path: "/admin/newsletter/editions/{id}",
    summary: "Delete a newsletter edition (any status, including sent)",
    tags: ["Admin"],
  })
  .input(z.object({ id: z.string() }))
  .output(z.object({ id: z.string(), ok: z.literal(true) }));

export const adminEditionsContract = {
  create_edition: createEdition,
  delete_edition: deleteEdition,
  list_editions_admin: listEditionsAdmin,
  send_edition: sendEdition,
  update_edition: updateEdition,
};
