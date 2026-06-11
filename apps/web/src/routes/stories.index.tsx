import { createFileRoute, redirect } from "@tanstack/react-router";

// The stories index moved to the log index (web-overhaul RFC §8 decision 5).
export const Route = createFileRoute("/stories/")({
  beforeLoad: () => {
    throw redirect({ statusCode: 301, to: "/log" });
  },
});
