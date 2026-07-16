import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { type ApiHandlers, aliasHandlers } from "../-alias";
import {
  clearAvatar,
  storeAvatar,
  validateAvatarUpload,
  verifyAvatarMutation,
} from "../../../lib/server/avatar";
import { jsonError } from "../../../lib/server/env";
import { apiErrorResponse } from "../../../lib/server/http-errors";
import { requirePublicUser } from "../../../lib/server/public-auth";
import { enforceRateLimit } from "../../../lib/server/rate-limit";

// POST/DELETE /api/me/avatar (the account portrait upload). A large-body/direct-
// upload carve-out (AGENTS.md): the browser downscales the picked image to a ≤512²
// square and PUTs the bytes here as `image/jpeg` (or png/webp); the DELETE clears
// the photo. NOT an oRPC op — it carries image bytes, not RPC JSON. Every safety
// rail lives server-side:
//   * `requirePublicUser` — a session is required and the user is derived FROM it,
//     never from the body (no userId in the request);
//   * `verifyAvatarMutation` — same-origin + a valid CSRF token (the `/me` mutation
//     protection, minus its application/json demand);
//   * `enforceRateLimit` — `account.avatar`, 10/hour, keyed on the user;
//   * `validateAvatarUpload` — content-type allow-list + ≤2 MB + ≤512² dimensions.
// R2 credentials stay Worker-side (the `VIDEOS` binding, found.fluncle.com); the
// object lands at `avatars/<userId>.<ext>` and the served Cloudflare Images URL is
// stamped onto `user.image`.

const AVATAR_RATE = { action: "account.avatar", limit: 10, windowMs: 60 * 60 * 1000 } as const;

export const serverHandlers: ApiHandlers = {
  DELETE: async ({ request }) => {
    const user = await requirePublicUser(request);

    if (user instanceof Response) {
      return user;
    }

    const blocked = verifyAvatarMutation(request, user);

    if (blocked) {
      return blocked;
    }

    const limited = await enforceRateLimit({ ...AVATAR_RATE, request, userId: user.id });

    if (limited) {
      return limited;
    }

    try {
      const result = await clearAvatar(user);

      return Response.json({ ...result, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
  POST: async ({ request }) => {
    const user = await requirePublicUser(request);

    if (user instanceof Response) {
      return user;
    }

    const blocked = verifyAvatarMutation(request, user);

    if (blocked) {
      return blocked;
    }

    const limited = await enforceRateLimit({ ...AVATAR_RATE, request, userId: user.id });

    if (limited) {
      return limited;
    }

    try {
      const contentType = request.headers.get("content-type") ?? "";
      const bytes = await request.arrayBuffer();
      const validation = validateAvatarUpload(contentType, bytes);

      if (!validation.ok) {
        return jsonError(validation.status, validation.code, validation.message);
      }

      const result = await storeAvatar(env.VIDEOS, user, bytes, contentType, validation.ext);

      return Response.json({ ...result, ok: true });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};

export const Route = createFileRoute("/api/me/avatar")({
  server: { handlers: aliasHandlers(serverHandlers) },
});
