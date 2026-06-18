import { createFileRoute } from "@tanstack/react-router";
import { listUserSubmissions } from "../../../lib/server/account-data";
import { requirePublicUser } from "../../../lib/server/public-auth";

export const Route = createFileRoute("/api/me/submissions")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await requirePublicUser(request);

        return user instanceof Response ? user : Response.json(await listUserSubmissions(user));
      },
    },
  },
});
