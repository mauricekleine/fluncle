// The `editions` domain contract module — the public newsletter-archive reads.
// Everything the newsletter owns nests
// under the `/newsletter` singleton: the editions collection is a plural
// sub-resource at `/newsletter/editions`. Convention B (verb_noun → camelCase
// operationId; plural collection under the singleton; singular op noun).

import { oc } from "@orpc/contract";
import * as z from "zod";
import { EditionDTOSchema } from "./_shared";

/**
 * `list_editions` → `GET /newsletter/editions` (operationId `listEditions`).
 *
 * Every SENT edition, newest first — the `/newsletter` archive's backing read.
 * Wrapped in the `{ ok: true, editions }` envelope (mirrors `EditionsResponse`).
 */
export const listEditions = oc
  .route({
    method: "GET",
    operationId: "listEditions",
    path: "/newsletter/editions",
    summary: "List the sent newsletter editions",
    tags: ["Newsletter"],
  })
  .output(z.object({ editions: z.array(EditionDTOSchema), ok: z.literal(true) }));

/**
 * `get_edition` → `GET /newsletter/editions/{number}` (operationId `getEdition`).
 *
 * One sent edition by its sequential number. `number` is a path string (the rails
 * keep params raw, as elsewhere); the handler parses it. 404 if no sent edition.
 */
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

/** The `editions` domain's public ops, merged into the root contract by `./index.ts`. */
export const editionsContract = {
  get_edition: getEdition,
  list_editions: listEditions,
};
