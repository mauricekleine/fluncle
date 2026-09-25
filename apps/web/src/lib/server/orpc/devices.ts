import { ORPCError } from "@orpc/server";
import { enforceRateLimit } from "../account-data";
import { deregisterDevice, registerDevice } from "../devices";
import { adminAuth } from "../orpc-auth";
import { sweepPushReceipts } from "../push";
import { apiFault, type Implementer, responseFault } from "./_shared";

const REGISTER_LIMIT = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

export function devicesHandlers(os: Implementer) {
  const registerDeviceHandler = os.register_device.handler(async ({ context, input }) => {
    try {
      const limited = await enforceRateLimit({
        action: "register_device",
        limit: REGISTER_LIMIT,
        request: context.request,
        windowMs: REGISTER_WINDOW_MS,
      });

      if (limited) {
        throw await responseFault(limited);
      }

      await registerDevice(input);

      return { ok: true } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  const deregisterDeviceHandler = os.deregister_device.handler(async ({ input }) => {
    try {
      await deregisterDevice(input.token);

      return { ok: true } as const;
    } catch (error) {
      if (error instanceof ORPCError) {
        throw error;
      }

      throw apiFault(error);
    }
  });

  const sweepPushReceiptsHandler = os.sweep_push_receipts
    .use(adminAuth)
    .handler(async ({ input }) => {
      try {
        const dryRun = input.query.dryRun === "true" || input.query.dryRun === "1";
        const parsedLimit = Number(input.query.limit);
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;
        const result = await sweepPushReceipts({ dryRun, limit });

        return { ...result, dryRun, ok: true } as const;
      } catch (error) {
        if (error instanceof ORPCError) {
          throw error;
        }

        throw apiFault(error);
      }
    });

  return {
    deregister_device: deregisterDeviceHandler,
    register_device: registerDeviceHandler,
    sweep_push_receipts: sweepPushReceiptsHandler,
  };
}
