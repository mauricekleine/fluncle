import { adminAuth, operatorGuard } from "../orpc-auth";
import { getVectorServingStatus, setVectorServing } from "../vector-serving";
import { type Implementer, toFault } from "./_shared";

export function adminVectorHandlers(os: Implementer) {
  const getVectorServingHandler = os.get_vector_serving
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async () => {
      try {
        return { ok: true as const, status: await getVectorServingStatus() };
      } catch (error) {
        throw toFault(error);
      }
    });

  const setVectorServingHandler = os.set_vector_serving
    .use(adminAuth)
    .use(operatorGuard)
    .handler(async ({ input }) => {
      try {
        return { ok: true as const, status: await setVectorServing(input.enabled) };
      } catch (error) {
        throw toFault(error);
      }
    });

  return {
    get_vector_serving: getVectorServingHandler,
    set_vector_serving: setVectorServingHandler,
  };
}
