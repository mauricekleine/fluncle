import { createFileRoute } from "@tanstack/react-router";

import { type ApiHandlers, aliasHandlers } from "./-alias";
import { parseChatRequest, streamChat } from "../../lib/server/chat";
import { jsonError } from "../../lib/server/env";
import { requireJsonMutation, requirePublicUser } from "../../lib/server/public-auth";
import { enforceRateLimit } from "../../lib/server/rate-limit";

const CHAT_HOURLY_RATE = {
  action: "chat.message",
  limit: 30,
  windowMs: 60 * 60 * 1000,
} as const;
const CHAT_DAILY_RATE = {
  action: "chat.message.daily",
  limit: 150,
  windowMs: 24 * 60 * 60 * 1000,
} as const;

export const serverHandlers: ApiHandlers = {
  POST: async ({ request }) => {
    const user = await requirePublicUser(request);

    if (user instanceof Response) {
      return user;
    }

    if (!user.emailVerified) {
      return jsonError(403, "email_unverified", "Verify your email to talk to Fluncle");
    }

    const blocked = requireJsonMutation(request, user);

    if (blocked) {
      return blocked;
    }

    const hourly = await enforceRateLimit({ ...CHAT_HOURLY_RATE, request, userId: user.id });

    if (hourly) {
      return hourly;
    }

    const daily = await enforceRateLimit({ ...CHAT_DAILY_RATE, request, userId: user.id });

    if (daily) {
      return daily;
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

export const Route = createFileRoute("/api/chat")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
