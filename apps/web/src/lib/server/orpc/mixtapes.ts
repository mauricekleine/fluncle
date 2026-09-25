import { listMixtapes } from "../mixtapes";
import { apiFault, type Implementer } from "./_shared";

export function mixtapesHandlers(os: Implementer) {
  const listMixtapesHandler = os.list_mixtapes.handler(async () => {
    try {
      return { mixtapes: await listMixtapes(), ok: true } as const;
    } catch (error) {
      throw apiFault(error);
    }
  });

  return { list_mixtapes: listMixtapesHandler };
}
