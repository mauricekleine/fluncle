import { oc } from "@orpc/contract";
import * as z from "zod";
import { MixtapeDTOSchema } from "./_shared";

export const listMixtapes = oc
  .route({
    method: "GET",
    operationId: "listMixtapes",
    path: "/mixtapes",
    summary: "List the published mixtapes",
    tags: ["Mixtapes"],
  })
  .output(z.object({ mixtapes: z.array(MixtapeDTOSchema), ok: z.literal(true) }));

export const mixtapesContract = {
  list_mixtapes: listMixtapes,
};
