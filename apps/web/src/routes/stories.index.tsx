import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/stories/")({
  beforeLoad: () => {
    throw redirect({ statusCode: 301, to: "/log" });
  },
});
