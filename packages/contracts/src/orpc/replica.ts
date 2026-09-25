import { oc } from "@orpc/contract";
import * as z from "zod";

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

export const replicaContract = {
  get_replica_token: getReplicaToken,
};
