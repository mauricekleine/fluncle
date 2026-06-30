import { createFileRoute, redirect } from "@tanstack/react-router";

// /stories/<id> moved to /log/<id>. A DUMB param passthrough on purpose:
// normalization (trackId → Log ID) happens once, at /log, so a legacy link
// never chains 301→301 for the canonical coordinate form.
// Permanent because the shared links out there
// (TikTok bio, Telegram) should re-teach the new URL.
export const Route = createFileRoute("/stories/$logId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      params: { logId: params.logId },
      statusCode: 301,
      to: "/log/$logId",
    });
  },
});
