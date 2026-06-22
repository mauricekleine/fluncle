// The `editions` domain router module — the public newsletter-archive reads.
// Implements the contract ops off the shared implementer the root (../orpc.ts)
// hands in. A future wave adds an op here and one spread line in the root.

import { ORPCError } from "@orpc/server";
import { getEditionByNumber, listEditions } from "../editions";
import { apiFault, type Implementer } from "./_shared";

/**
 * Build the `editions` domain's handlers — the sent-only archive reads, wrapped in
 * the `{ ok: true, editions }` / `{ ok: true, edition }` envelopes. Errors flow
 * through the shared `apiFault` so the rails encoder reproduces the legacy body.
 */
export function editionsHandlers(os: Implementer) {
  // GET /newsletter/editions — every SENT edition, newest first.
  const listEditionsHandler = os.list_editions.handler(async () => {
    try {
      return { editions: await listEditions(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  // GET /newsletter/editions/{number} — one sent edition by its integer number.
  const getEditionHandler = os.get_edition.handler(async ({ input }) => {
    try {
      const number = Number.parseInt(input.number, 10);

      if (!Number.isInteger(number) || number < 1) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "edition_not_found", apiMessage: "Edition not found" },
          message: "Edition not found",
          status: 404,
        });
      }

      const edition = await getEditionByNumber(number);

      if (!edition) {
        throw new ORPCError("NOT_FOUND", {
          data: { apiCode: "edition_not_found", apiMessage: "Edition not found" },
          message: "Edition not found",
          status: 404,
        });
      }

      return { edition, ok: true } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  return { get_edition: getEditionHandler, list_editions: listEditionsHandler };
}
