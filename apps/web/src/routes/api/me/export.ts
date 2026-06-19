import { createFileRoute } from "@tanstack/react-router";
import { exportAccountData, requireAccountMutation } from "../../../lib/server/account-data";

export const Route = createFileRoute("/api/me/export")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await requireAccountMutation(request, {
          action: "account.export",
          limit: 3,
          windowMs: 24 * 60 * 60 * 1000,
        });

        if (user instanceof Response) {
          return user;
        }

        return Response.json(await exportAccountData(user));
      },
    },
  },
});
