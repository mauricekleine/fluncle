import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { canonicalCoordinate } from "@/lib/log-page-param";

export const Route = createFileRoute("/$coordinate")({
  beforeLoad: ({ params }) => {
    const logId = canonicalCoordinate(params.coordinate);

    if (!logId) {
      throw notFound();
    }

    throw redirect({ params: { logId }, statusCode: 301, to: "/log/$logId" });
  },
});
