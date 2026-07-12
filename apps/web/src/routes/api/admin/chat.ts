import { createFileRoute } from "@tanstack/react-router";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import { parseChatRequest, streamChat } from "../../../lib/server/chat";
import { jsonError, requireAdmin } from "../../../lib/server/env";

// POST /api/admin/chat (ChatDnB, the admin-gated SPIKE) — one turn of Fluncle answering
// over his own archive tools, streamed back as NDJSON (one transcript event per line) so the
// bare /admin/chat workbench can render the grounding work as it happens: every tool call and
// its result, not just the final text.
//
// A STREAMING carve-out (not an oRPC op): the response is an open ReadableStream of
// newline-delimited JSON, not a single RPC JSON body, exactly like the media-proxy carve-outs
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
      return jsonError(400, "invalid_messages", "Expected { messages: [{ role, content }, …] }");
    }

    const stream = await streamChat(messages, request.signal);

    if (!stream) {
      // No OPENROUTER_API_KEY. A chat has no cheaper degraded answer (unlike search's
      // full-text fallback), so it fails honestly rather than pretending.
      return jsonError(503, "chat_unprovisioned", "ChatDnB has no model key on this Worker yet");
    }

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        // NDJSON: one JSON transcript event per line (text | tool-call | tool-result | done).
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};

export const Route = createFileRoute("/api/admin/chat")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
