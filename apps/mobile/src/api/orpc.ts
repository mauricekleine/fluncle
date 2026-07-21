// The live oRPC client (RFC Unit 2 — Data, Phase 1). The contract-first client
// derived from `@fluncle/contracts/orpc`: the same contract the web serves via
// its OpenAPI handler. The app is one more SURFACE over the public API — this is
// the only place the transport lives, and `./hooks.ts` is the only thing the UI
// imports.
//
// OpenAPI transport (not RPC): the public API is REST-routed (GET /tracks, …), so
// we use `OpenAPILink` over the contract. Responses cross JSON, so the typed
// client is wrapped in `JsonifiedClient` (Date → string, etc.) to keep the inputs
// the contract sees in lock-step with the wire.
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

const client: JsonifiedClient<ContractRouterClient<typeof contract>> = createORPCClient(link);

/** Typed TanStack Query utilities (the contract is flat: `orpc.list_findings.infiniteOptions(...)`, …). */
export const orpc = createTanstackQueryUtils(client);
