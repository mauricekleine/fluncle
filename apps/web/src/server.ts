import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { appendAgentLinkHeaders, handleAgentDiscovery } from "./lib/server/agent-discovery";

export default createServerEntry({
  async fetch(incoming) {
    // galaxy.fluncle.com is the game's front door: same Worker, the root
    // rewritten internally to /galaxy so the subdomain boots straight into
    // the cockpit. Every other path (api, assets) passes through, which
    // keeps the preview proxy same-origin for the game.
    const url = new URL(incoming.url);
    const request =
      url.hostname.startsWith("galaxy.") && url.pathname === "/"
        ? new Request(new URL("/galaxy", url), incoming)
        : incoming;

    // Agent discovery surfaces (well-known endpoints, markdown negotiation)
    // sit ahead of the router; everything else flows through unchanged.
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
