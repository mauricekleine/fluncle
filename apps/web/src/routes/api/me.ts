import { createFileRoute } from "@tanstack/react-router";
import { meResponse } from "../../lib/server/account-data";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: async ({ request }) => Response.json(await meResponse(request)),
    },
  },
});
