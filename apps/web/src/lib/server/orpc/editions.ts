import { ORPCError } from "@orpc/server";
import { getEditionByNumber, listEditions } from "../editions";
import { apiFault, type Implementer } from "./_shared";

export function editionsHandlers(os: Implementer) {
  const listEditionsHandler = os.list_editions.handler(async () => {
    try {
      return { editions: await listEditions(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

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
