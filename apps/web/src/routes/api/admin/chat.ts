import { createFileRoute } from "@tanstack/react-router";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import { parseChatRequest, streamChat } from "../../../lib/server/chat";
import { jsonError, requireAdmin } from "../../../lib/server/env";

// POST /api/admin/chat (ChatDnB, the admin-gated SPIKE) — one turn of Fluncle answering
// over his own archive tools, streamed back as an AI SDK UIMessage stream (the protocol
// `useChat` speaks natively) so the bare /admin/chat workbench can render the grounding work
// as it happens: every tool call and its result arrive as typed tool parts, not just the
// final text.
//
// A STREAMING carve-out (not an oRPC op): the response is an open stream of UIMessage
// chunks, not a single RPC JSON body, exactly like the media-proxy carve-outs
// (source-audio / silent-clip). It is admin-gated with `requireAdmin` — the whole feature is
// operator-only until it graduates out of spike (nothing public yet), and the browser grant
// cookie the operator carries satisfies it.
export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid_body", "Expected a JSON body");
    }

    const messages = parseChatRequest(body);

    if (!messages) {
      return jsonError(400, "invalid_messages", "Expected { messages: [UIMessage, …] }");
    }

    const response = await streamChat(messages, request.signal, request);

    if (!response) {
      // No OPENROUTER_API_KEY. A chat has no cheaper degraded answer (unlike search's
      // full-text fallback), so it fails honestly rather than pretending.
      return jsonError(503, "chat_unprovisioned", "ChatDnB has no model key on this Worker yet");
    }

    // Already a complete UIMessage-stream Response (headers included) — hand it back as-is.
    return response;
  },
};

export const Route = createFileRoute("/api/admin/chat")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
