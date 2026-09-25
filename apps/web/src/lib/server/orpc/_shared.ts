import { contract } from "@fluncle/contracts/orpc";
import { type implement, ORPCError } from "@orpc/server";
import * as Sentry from "@sentry/cloudflare";
import { isDueWorkMaintenancePending } from "../due-work";
import { logEvent } from "../log";
import { type OrpcContext } from "../orpc-context";
import { type TrackListItem, getTrackByIdOrLogId } from "../tracks";
import { ApiError } from "../spotify";

export type Implementer = ReturnType<typeof implement<typeof contract, OrpcContext>>;

export { parseBool, parseLimit } from "../query-params";

export function parseCataloguePage(pageArg: string | undefined): number {
  const parsed = Number(pageArg);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export async function requireTrack(idOrLogId: string): Promise<TrackListItem> {
  const track = await getTrackByIdOrLogId(idOrLogId);

  if (!track) {
    throw new ORPCError("NOT_FOUND", {
      data: { apiCode: "not_found", apiMessage: `No track with id ${idOrLogId}` },
      message: `No track with id ${idOrLogId}`,
      status: 404,
    });
  }

  return track;
}

export type ApiFaultData = { apiCode: string; apiMessage: string };

export function isApiFaultData(data: unknown): data is ApiFaultData {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as ApiFaultData).apiCode === "string" &&
    typeof (data as ApiFaultData).apiMessage === "string"
  );
}

export function dueWorkMaintenancePendingFault(): ORPCError<string, ApiFaultData> {
  return new ORPCError("SERVICE_UNAVAILABLE", {
    data: {
      apiCode: "due_work_maintenance_pending",
      apiMessage: "Due-work maintenance is still converging",
    },
    message: "Due-work maintenance is still converging",
    status: 503,
  });
}

export function apiFault(error: unknown): ORPCError<string, ApiFaultData> {
  if (isDueWorkMaintenancePending(error)) {
    return dueWorkMaintenancePendingFault();
  }

  if (error instanceof ApiError) {
    return new ORPCError("INTERNAL_SERVER_ERROR", {
      data: { apiCode: error.code, apiMessage: error.message },
      message: error.message,
      status: error.status,
    });
  }

  logEvent("error", "api.unexpected-fault", { error });

  Sentry.captureException(error, {
    tags: { source: "orpc.apiFault" },
  });

  return new ORPCError("INTERNAL_SERVER_ERROR", {
    data: { apiCode: "error", apiMessage: "Internal error" },
    message: "Internal error",
    status: 500,
  });
}

export function toFault(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    return error;
  }

  return apiFault(error);
}

export async function responseFault(response: Response): Promise<ORPCError<string, ApiFaultData>> {
  let apiCode = "error";
  let apiMessage = response.statusText || "Request failed";

  try {
    const body = (await response.clone().json()) as { code?: unknown; message?: unknown };

    if (typeof body.code === "string") {
      apiCode = body.code;
    }

    if (typeof body.message === "string") {
      apiMessage = body.message;
    }
  } catch {}

  return new ORPCError("INTERNAL_SERVER_ERROR", {
    data: { apiCode, apiMessage },
    message: apiMessage,
    status: response.status,
  });
}
