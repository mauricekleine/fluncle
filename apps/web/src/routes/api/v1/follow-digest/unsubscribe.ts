import { createFileRoute } from "@tanstack/react-router";

export const serverHandlers = {
  GET: async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const target = new URL("/follows", url.origin);
    const token = url.searchParams.get("token");

    if (token) {
      target.searchParams.set("unsubscribe", token);
    }

    return new Response(null, {
      headers: {
        "Cache-Control": "no-store",
        Location: `${target.pathname}${target.search}`,
        "Referrer-Policy": "no-referrer",
      },
      status: 303,
    });
  },
};

export const Route = createFileRoute("/api/v1/follow-digest/unsubscribe")({
  server: { handlers: serverHandlers },
});
