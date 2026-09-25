import { oc } from "@orpc/contract";
import * as z from "zod";

import { TrackListItemSchema } from "./_shared.js";

export const GalaxyListItemSchema = z
  .object({
    memberCount: z.number(),
    name: z.string(),
    slug: z.string(),
  })
  .meta({ id: "GalaxyListItem" });

export const listGalaxies = oc
  .route({
    method: "GET",
    operationId: "listGalaxies",
    path: "/galaxies",
    summary: "List the named sonic galaxies (the browse-by-feel map)",
    tags: ["Galaxies"],
  })
  .output(z.object({ galaxies: z.array(GalaxyListItemSchema), ok: z.literal(true) }));

export const getGalaxy = oc
  .route({
    method: "GET",
    operationId: "getGalaxy",
    path: "/galaxies/{slug}",
    summary: "Get a named galaxy by slug, with its findings (core-first, paginated)",
    tags: ["Galaxies"],
  })
  .input(
    z.object({ limit: z.string().optional(), offset: z.string().optional(), slug: z.string() }),
  )
  .output(
    z.object({
      findings: z.array(TrackListItemSchema),
      galaxy: GalaxyListItemSchema,
      ok: z.literal(true),
    }),
  );

export const galaxiesContract = {
  get_galaxy: getGalaxy,
  list_galaxies: listGalaxies,
};
