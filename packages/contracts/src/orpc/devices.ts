// The `devices` domain contract module. Owns the public push-device registry
// write ops — a phone (the Expo app) registers its push token so a new finding /
// mixtape can reach the crew, and deregisters to opt out. Net-new for the mobile
// app (docs/rfcs/mobile-app.md §7); follows the `submissions` public-write
// pattern. A future wave adds an op here and one spread line in `./index.ts`,
// touching no other domain's file.

import { oc } from "@orpc/contract";
import * as z from "zod";

// An Expo push token is always `ExponentPushToken[…]` (the FCM/APNs detail is
// hidden behind it). Validate the shape at the contract edge so a malformed token
// 400s before it can bloat the registry or break a fan-out. The bracketed body is
// opaque, so accept any non-`]` run inside the brackets.
export const ExpoPushTokenSchema = z
  .string()
  .regex(/^ExponentPushToken\[[^\]]+\]$/, "Must be a valid ExponentPushToken[…]");

// The push categories a device can mute. Mirrors the two send paths in the server
// `push` module (`notifyNewFinding` → "findings", `notifyNewMixtape` →
// "mixtapes"); a muted category is dropped from that path's fan-out.
export const PushCategorySchema = z.enum(["findings", "mixtapes"]);

// The platforms a device can register from. Surfaced so the contract edge rejects
// anything that is not the Expo iOS/Android app.
export const DevicePlatformSchema = z.enum(["android", "ios"]);

/**
 * `register_device` → `POST /devices` (operationId `registerDevice`).
 *
 * Register (or refresh) a device's Expo push token — an idempotent upsert on the
 * token (raw `on conflict(token)` server-side). Anonymous-compatible: the app has
 * no account, so `userId` is bound only once accounts arrive. The success body is
 * the `{ ok: true }` envelope. A malformed token is a contract 400
 * (`invalid_request`); a flood is rate-limited (429) by the generic limiter.
 */
export const registerDevice = oc
  .route({
    method: "POST",
    operationId: "registerDevice",
    path: "/devices",
    summary: "Register a device for push notifications",
    tags: ["Devices"],
  })
  .input(
    z.object({
      appVersion: z.string().max(64).optional(),
      mutedCategories: z.array(PushCategorySchema).optional(),
      platform: DevicePlatformSchema,
      token: ExpoPushTokenSchema,
    }),
  )
  .output(z.object({ ok: z.literal(true) }));

/**
 * `deregister_device` → `DELETE /devices/{token}` (operationId
 * `deregisterDevice`).
 *
 * Opt out — remove a device's push token from the registry. Idempotent: deleting
 * an absent token still succeeds (`{ ok: true }`), so a re-tap on "turn off
 * notifications" never errors.
 */
export const deregisterDevice = oc
  .route({
    method: "DELETE",
    operationId: "deregisterDevice",
    path: "/devices/{token}",
    summary: "Deregister a device from push notifications",
    tags: ["Devices"],
  })
  .input(z.object({ token: ExpoPushTokenSchema }))
  .output(z.object({ ok: z.literal(true) }));

/**
 * `sweep_push_receipts` → `POST /admin/push/sweep-receipts` (operationId
 * `sweepPushReceipts`).
 *
 * Admin tier (live `requireAdmin` — like `sweep_enrichment`, so an external cron
 * AND the operator can hit it; the agent role is allowed). Dead-token reaping:
 * Expo surfaces `DeviceNotRegistered` via RECEIPTS (~15min+ after the send), not
 * tickets, so this drains the pending-receipt ledger and prunes the tokens Expo
 * reports gone. TanStack has no `scheduled()`, so an EXTERNAL cron must call this
 * on a cadence (same shape as `sweep_enrichment`). Returns the count pruned +
 * still-pending. Query-only POST (no body), so `inputStructure: "detailed"`.
 */
export const sweepPushReceipts = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "sweepPushReceipts",
    path: "/admin/push/sweep-receipts",
    summary: "Prune push tokens Expo reports gone (DeviceNotRegistered via receipts)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
        // Tolerant strings — parsed/clamped in-handler, never 400 on a bad value
        // (mirrors the backfill/enrich-sweep query contracts).
        dryRun: z.string().optional(),
        limit: z.string().optional(),
      }),
    }),
  )
  .output(
    z.object({
      checked: z.number(),
      dryRun: z.boolean(),
      ok: z.literal(true),
      pending: z.number(),
      pruned: z.number(),
    }),
  );

/** The `devices` domain's ops, merged into the root contract by `./index.ts`. */
export const devicesContract = {
  deregister_device: deregisterDevice,
  register_device: registerDevice,
  sweep_push_receipts: sweepPushReceipts,
};
