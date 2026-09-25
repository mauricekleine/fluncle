import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/stories/$logId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      params: { logId: params.logId },
      statusCode: 301,
      to: "/log/$logId",
    });
  },
});
