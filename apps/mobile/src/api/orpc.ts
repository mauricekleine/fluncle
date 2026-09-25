import { type ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { type JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { contract } from "@fluncle/contracts/orpc";
import { API_BASE } from "@/config";

const link = new OpenAPILink(contract, {
  url: `${API_BASE}/api/v1`,
});

export const apiClient: JsonifiedClient<ContractRouterClient<typeof contract>> =
  createORPCClient(link);

export const orpc = createTanstackQueryUtils(apiClient);
