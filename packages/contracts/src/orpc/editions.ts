import { oc } from "@orpc/contract";
import * as z from "zod";
import { EditionDTOSchema } from "./_shared";

export const listEditions = oc
  .route({
    method: "GET",
    operationId: "listEditions",
    path: "/newsletter/editions",
    summary: "List the sent newsletter editions",
    tags: ["Newsletter"],
  })
  .output(z.object({ editions: z.array(EditionDTOSchema), ok: z.literal(true) }));

export const getEdition = oc
  .route({
    method: "GET",
    operationId: "getEdition",
    path: "/newsletter/editions/{number}",
    summary: "Get one sent newsletter edition by its number",
    tags: ["Newsletter"],
  })
  .input(z.object({ number: z.string() }))
  .output(z.object({ edition: EditionDTOSchema, ok: z.literal(true) }));

export const editionsContract = {
  get_edition: getEdition,
  list_editions: listEditions,
};
