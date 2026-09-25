import { oc } from "@orpc/contract";
import * as z from "zod";

export const ExpoPushTokenSchema = z
  .string()
  .max(256)
  .regex(/^ExponentPushToken\[[^\]]+\]$/, "Must be a valid ExponentPushToken[…]");

export const PushCategorySchema = z.enum(["findings", "mixtapes"]);

export const DevicePlatformSchema = z.enum(["android", "ios"]);

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

      mutedCategories: z.array(PushCategorySchema).max(8).optional(),
      platform: DevicePlatformSchema,
      token: ExpoPushTokenSchema,
    }),
  )
  .output(z.object({ ok: z.literal(true) }));

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

export const sweepPushReceipts = oc
  .route({
    inputStructure: "detailed",
    method: "POST",
    operationId: "sweepPushReceipts",
    path: "/admin/push/receipts/sweep",
    summary: "Prune push tokens Expo reports gone (DeviceNotRegistered via receipts)",
    tags: ["Admin"],
  })
  .input(
    z.object({
      query: z.object({
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

export const devicesContract = {
  deregister_device: deregisterDevice,
  register_device: registerDevice,
  sweep_push_receipts: sweepPushReceipts,
};
