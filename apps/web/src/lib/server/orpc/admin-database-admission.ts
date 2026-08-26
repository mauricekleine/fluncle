import { type InferContractRouterInputs } from "@orpc/contract";
import { type contract } from "@fluncle/contracts/orpc";
import { getDb } from "../db";
import { observeDatabaseAdmissionFor } from "../database-admission";
import { adminAuth } from "../orpc-auth";
import { type Implementer, toFault } from "./_shared";

type AdmissionInput = InferContractRouterInputs<typeof contract>["coordinate_database_admission"];

/** Execute the agent endpoint against an injected client for compatibility tests. */
export async function coordinateDatabaseAdmissionRequestFor(
  client: Parameters<typeof observeDatabaseAdmissionFor>[0],
  input: AdmissionInput,
) {
  return observeDatabaseAdmissionFor(client, input);
}

/** Build the agent-tier recurring-work admission handler. */
export function adminDatabaseAdmissionHandlers(os: Implementer) {
  const coordinateHandler = os.coordinate_database_admission
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return await coordinateDatabaseAdmissionRequestFor(await getDb(), input);
      } catch (error) {
        throw toFault(error);
      }
    });

  return { coordinate_database_admission: coordinateHandler };
}
