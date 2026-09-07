import { type InferContractRouterInputs } from "@orpc/contract";
import { type contract } from "@fluncle/contracts/orpc";
import { ORPCError } from "@orpc/server";
import { getDb } from "../db";
import { coordinateDatabaseAdmissionFor, isDatabaseBusy } from "../database-admission";
import { adminAuth } from "../orpc-auth";
import { type Implementer, toFault } from "./_shared";

type AdmissionInput = InferContractRouterInputs<typeof contract>["coordinate_database_admission"];

/** Execute the agent endpoint against an injected client for compatibility tests. */
export async function coordinateDatabaseAdmissionRequestFor(
  client: Parameters<typeof coordinateDatabaseAdmissionFor>[0],
  input: AdmissionInput,
) {
  return coordinateDatabaseAdmissionFor(client, input);
}

export function databaseAdmissionFault(error: unknown) {
  if (isDatabaseBusy(error)) {
    return new ORPCError("SERVICE_UNAVAILABLE", {
      data: { apiCode: "database_busy", apiMessage: "Database admission is busy" },
      message: "Database admission is busy",
      status: 503,
    });
  }
  return toFault(error);
}

/** Build the agent-tier recurring-work admission handler. */
export function adminDatabaseAdmissionHandlers(os: Implementer) {
  const coordinateHandler = os.coordinate_database_admission
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return await coordinateDatabaseAdmissionRequestFor(await getDb(), input);
      } catch (error) {
        throw databaseAdmissionFault(error);
      }
    });

  return { coordinate_database_admission: coordinateHandler };
}
