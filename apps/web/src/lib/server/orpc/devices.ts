// The `devices` domain router module. Implements the public push-device registry
// write ops (`register_device` / `deregister_device`) and the admin-tier
// receipts-sweep (`sweep_push_receipts`) off the shared implementer the root
// (../orpc.ts) hands in. A future wave adds an op here and one spread line in the
// root — no other domain's file is touched.

import { ORPCError } from "@orpc/server";
import { enforceRateLimit } from "../account-data";
import { deregisterDevice, registerDevice } from "../devices";
import { adminAuth } from "../orpc-auth";
import { sweepPushReceipts } from "../push";
import { apiFault, type Implementer, responseFault } from "./_shared";

// The registration write is anonymous and unauthenticated, so it is the prime
// target for a flood of format-valid fake tokens that would bloat the table and
// slow every fan-out — rate-limit it hard with the generic `rate_limit_events`
// limiter (the same one the `/me` mutations use). A short window, a tight cap: a
// real device registers once on launch and re-registers only on a token rotation.
const REGISTER_LIMIT = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

export function devicesHandlers(os: Implementer) {
  // `register_device` — idempotent upsert of a device's Expo push token. The
  // contract has already validated the token shape (`ExponentPushToken[…]`) and
  // the platform enum, so the body is well-formed here; the limiter guards volume.
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

  // `deregister_device` — opt out. Idempotent; no rate limit needed (it only ever
  // shrinks the table, and the token shape is contract-validated).
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

  // `sweep_push_receipts` — ADMIN tier (live `requireAdmin`, like enrich-sweep: an
  // external cron AND the operator hit it, so the agent role is allowed). Drains
  // the pending-receipt ledger and prunes the tokens Expo reports gone. The query
  // params (`limit`/`dryRun`) are tolerant strings parsed in-handler — never 400
  // on a malformed value (the backfill/enrich-sweep precedent).
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
