import { createFileRoute } from "@tanstack/react-router";
import { listMixtapes } from "../../lib/server/mixtapes";

export const Route = createFileRoute("/api/mixtapes")({
  server: {
    handlers: {
      GET: async () => Response.json({ mixtapes: await listMixtapes(), ok: true }),
    },
  },
});
