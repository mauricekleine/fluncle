// The `mixtapes` domain contract module. Owns the public mixtape-list op; a
// future wave adds an op here and one import line in `./index.ts`, touching no
// other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";
import { MixtapeDTOSchema } from "./_shared";

/**
 * `list_mixtapes` → `GET /mixtapes` (operationId `listMixtapes`).
 *
 * Every published mixtape, newest first — the `/mixtapes` surface's backing
 * read. The live route wraps the array in the `{ ok: true, mixtapes }` envelope
 * (mirrors `MixtapesResponse` in ../index.ts), unlike the bare `/tracks` page;
 * the contract output preserves that envelope byte-for-byte.
 */
export const listMixtapes = oc
  .route({
    method: "GET",
    operationId: "listMixtapes",
    path: "/mixtapes",
    summary: "List the published mixtapes",
    tags: ["Mixtapes"],
  })
  .output(z.object({ mixtapes: z.array(MixtapeDTOSchema), ok: z.literal(true) }));

/** The `mixtapes` domain's ops, merged into the root contract by `./index.ts`. */
export const mixtapesContract = {
  list_mixtapes: listMixtapes,
};
