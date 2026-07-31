// The `replica` domain contract module. Owns the public device-replica token
// read: the Worker mints one short-lived credential, while the device syncs the
// shared read-only catalogue replica directly from Turso.

import { oc } from "@orpc/contract";
import * as z from "zod";

/**
 * `get_replica_token` → `GET /replica/token` (operationId `getReplicaToken`).
 *
 * Mint a 24-hour, read-only Turso credential for the shared device replica. The
 * device uses `url` + `token` directly with libSQL; `expiresAt` is the ISO instant
 * after which it must fetch a replacement. The Worker never proxies replica data.
 *
 * The operation ships dark: missing replica configuration or a Turso Platform
 * API failure is a typed 503 (`replica_unavailable`) rather than a 500, so the
 * mobile app can stay on its API-fed path.
 */
export const getReplicaToken = oc
  .route({
    method: "GET",
    operationId: "getReplicaToken",
    path: "/replica/token",
    summary: "Mint a read-only device-replica token",
    tags: ["Replica"],
  })
  .output(
    z.object({
      expiresAt: z.string(),
      token: z.string().min(1),
      url: z.string().url(),
    }),
  );

/** The `replica` domain's ops, merged into the root contract by `./index.ts`. */
export const replicaContract = {
  get_replica_token: getReplicaToken,
};
