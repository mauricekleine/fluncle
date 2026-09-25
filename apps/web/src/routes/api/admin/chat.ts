import { createFileRoute } from "@tanstack/react-router";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import { parseChatRequest, streamChat } from "../../../lib/server/chat";
import { jsonError, requireAdmin, requireAdminMutationOrigin } from "../../../lib/server/env";

export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const unauthorized = await requireAdmin(request);

    if (unauthorized) {
      return unauthorized;
    }

    const crossOrigin = requireAdminMutationOrigin(request);

    if (crossOrigin) {
      return crossOrigin;
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
      return jsonError(503, "chat_unprovisioned", "ChatDnB has no model key on this Worker yet");
    }

    return response;
  },
};

export const Route = createFileRoute("/api/admin/chat")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
