import { type InferContractRouterInputs } from "@orpc/contract";
import { type contract } from "@fluncle/contracts/orpc";
import { ORPCError } from "@orpc/server";
import { getDb, getTelemetryDb } from "../db";
import {
  coordinateDatabaseAdmissionAcross,
  type DatabaseAdmissionStores,
  isDatabaseBusy,
  recordDatabaseWriteProbeFor,
} from "../database-admission";
import { adminAuth } from "../orpc-auth";
import { type Implementer, toFault } from "./_shared";

type AdmissionInput = InferContractRouterInputs<typeof contract>["coordinate_database_admission"];

async function admissionStores(): Promise<DatabaseAdmissionStores> {
  const [primary, telemetry] = await Promise.all([getDb(), getTelemetryDb()]);
  return telemetry === undefined ? { primary } : { primary, telemetry };
}

async function coordinateDatabaseAdmissionRequestFor(
  stores: DatabaseAdmissionStores,
  input: AdmissionInput,
) {
  return coordinateDatabaseAdmissionAcross(stores, input);
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

export function adminDatabaseAdmissionHandlers(os: Implementer) {
  const coordinateHandler = os.coordinate_database_admission
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        return await coordinateDatabaseAdmissionRequestFor(await admissionStores(), input);
      } catch (error) {
        throw databaseAdmissionFault(error);
      }
    });

  const recordWriteProbeHandler = os.record_database_write_probe
    .use(adminAuth)
    .handler(async () => {
      try {
        return {
          ...(await recordDatabaseWriteProbeFor(await admissionStores())),
          ok: true,
        } as const;
      } catch (error) {
        throw databaseAdmissionFault(error);
      }
    });

  return {
    coordinate_database_admission: coordinateHandler,
    record_database_write_probe: recordWriteProbeHandler,
  };
}
