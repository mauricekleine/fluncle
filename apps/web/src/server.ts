import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { appendAgentLinkHeaders, handleAgentDiscovery } from "./lib/server/agent-discovery";
import { handleMcp } from "./lib/server/mcp";

export default createServerEntry({
  async fetch(request) {
    // The MCP endpoint and its server card (the agent tool surface) sit ahead
    // of the router, as do the agent discovery surfaces (well-known endpoints,
    // markdown negotiation); everything else flows through unchanged.
    // (galaxy.fluncle.com routing lives in the router's rewrite config, not
    // here — it must run isomorphically or hydration undoes it.)
    const mcp = await handleMcp(request);

    if (mcp) {
      return mcp;
    }

    const discovery = await handleAgentDiscovery(request);

    if (discovery) {
      return discovery;
    }

    const response = await handler.fetch(request);

    // The homepage advertises machine-readable surfaces via RFC 8288 Link
    // headers so agents can discover them without guessing paths.
    return new URL(request.url).pathname === "/" ? appendAgentLinkHeaders(response) : response;
  },
});
