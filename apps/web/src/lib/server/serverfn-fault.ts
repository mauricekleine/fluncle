import * as Sentry from "@sentry/cloudflare";
import { adminRole } from "./env";
import { logEvent } from "./log";
import { isDueWorkMaintenancePending } from "./due-work";
import { ApiError } from "./spotify";

export const GENERIC_SERVERFN_FAULT_MESSAGE = "Internal error";

export async function redactServerFnFault(
  error: unknown,
  request: Request | undefined,
): Promise<unknown> {
  if (error instanceof ApiError) {
    return error;
  }

  if (isDueWorkMaintenancePending(error)) {
    return error;
  }

  logEvent("error", "serverfn.unexpected-fault", { error, path: requestPath(request) });
  Sentry.captureException(error, { tags: { source: "serverfn.redaction" } });

  if (await isAdminPrincipal(request)) {
    return error;
  }

  return new Error(GENERIC_SERVERFN_FAULT_MESSAGE);
}

async function isAdminPrincipal(request: Request | undefined): Promise<boolean> {
  if (!request) {
    return false;
  }

  try {
    return (await adminRole(request)) !== null;
  } catch {
    return false;
  }
}

function requestPath(request: Request | undefined): string | undefined {
  if (!request) {
    return undefined;
  }

  try {
    return new URL(request.url).pathname;
  } catch {
    return undefined;
  }
}
