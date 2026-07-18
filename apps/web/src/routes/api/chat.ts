import { createFileRoute } from "@tanstack/react-router";

import { type ApiHandlers, aliasHandlers } from "./-alias";
import { parseChatRequest, streamChat } from "../../lib/server/chat";
import { jsonError } from "../../lib/server/env";
import { requireJsonMutation, requirePublicUser } from "../../lib/server/public-auth";
import { enforceRateLimit } from "../../lib/server/rate-limit";

// POST /api/chat (ChatDnB, the crew door) — one turn of Fluncle answering over his own
// archive tools, streamed back as an AI SDK UIMessage stream, exactly as the admin
// workbench's /api/admin/chat does. The ENGINE is byte-for-byte the same call
// (lib/server/chat.ts: the grounding prompt, the archive tools, the certified-only wire
// boundary); only the GATE differs. This is a paid-inference surface serving non-paying
// users, so the rails run strictest-first and every one is server-side:
//
//   1. `requirePublicUser` — a session is required and the user is derived FROM it,
//      never from the body (401 anonymous);
//   2. the emailVerified gate — verified-email accounts are the learning cohort
//      (the gated-rollout ruling): sign-in never requires verification, FEATURES gate
//      on it (403 `email_unverified`);
//   3. `requireJsonMutation` — same-origin + the `x-fluncle-csrf` token + the
//      application/json demand, the exact `/me` mutation preamble (the transport always
//      POSTs JSON, so the content-type demand costs nothing and blocks form-encoded
//      cross-site posts outright);
//   4. `enforceRateLimit`, TWICE — an hourly conversational cap plus a daily ceiling,
//      both keyed on the user (never the IP: the session is the identity here).
//
// A STREAMING carve-out (not an oRPC op), like /api/admin/chat: the response is an open
// stream of UIMessage chunks, not a single RPC JSON body. Registered in
// orpc-coverage.test.ts's carve-out list.

// The friends-phase dials (ROADMAP §ChatDnB: rollout is gated, usage-model unknown, every
// conversation costs real inference money). 30 messages/hour is a real conversation with
// headroom; 150/day caps a runaway day at roughly one long evening of chat. Raise them
// deliberately when the usage model is understood, not because someone hit them.
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

    // The learning-cohort gate: the chat opens to verified-email accounts only. The
    // client renders this state before ever posting, so hitting it here means a caller
    // skipped the page — answer with a machine-readable code it can act on.
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

    // Thread the gated request into the tools so the WRITE verbs (submit_track /
    // subscribe_newsletter) get the submitter hash + rate-limit context they need.
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

export const Route = createFileRoute("/api/chat")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
