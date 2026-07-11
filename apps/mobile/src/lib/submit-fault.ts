// The honest result states for the submit flow, and the pure mapping from a thrown
// server fault to one of them. Kept out of the screen (no React Native imports) so
// it's unit-testable — the states are the whole point of the feature (a submission
// is a message in a bottle; the server owns status, the client just renders it
// truthfully).

/**
 * How a submit fault reads to the crew. The public `submit_track` op faults with a
 * 429 (`rate_limited`) or a validation/Spotify `ApiError`; it has NO dedupe today,
 * so `already_logged` is wired but dormant — gated on a real server conflict signal
 * (a 409 or an `already`/`duplicate`-flavoured code) so it can never misfire, ready
 * if the server ever grows dedupe. `offline` is a transport failure that never
 * reached the server (no HTTP status on the error).
 */
export type SubmitOutcome = "already_logged" | "failed" | "offline" | "rate_limited";

/** Read the server fault's HTTP status + `apiCode` off an unknown thrown error, defensively. */
export function faultInfo(error: unknown): { apiCode?: string; status?: number } {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const fault = error as { data?: unknown; status?: unknown };
  const status = typeof fault.status === "number" ? fault.status : undefined;
  let apiCode: string | undefined;

  // The oRPC OpenAPILink client wraps the HTTP response on the thrown ORPCError:
  // the server's legacy `{ code, message, ok }` body sits at `data.body`, so the
  // apiCode (e.g. "rate_limited") is `data.body.code` (verified against the live
  // server). A flatter `data.apiCode` is kept as a defensive fallback.
  if (typeof fault.data === "object" && fault.data !== null) {
    const data = fault.data as { apiCode?: unknown; body?: unknown };

    if (typeof data.body === "object" && data.body !== null) {
      const bodyCode = (data.body as { code?: unknown }).code;
      apiCode = typeof bodyCode === "string" ? bodyCode : undefined;
    }

    if (apiCode === undefined && typeof data.apiCode === "string") {
      apiCode = data.apiCode;
    }
  }

  return { apiCode, status };
}

/** Map a submit fault to the honest result state the screen renders. */
export function classifySubmit(error: unknown): SubmitOutcome {
  const { apiCode, status } = faultInfo(error);

  if (status === 429 || apiCode === "rate_limited") {
    return "rate_limited";
  }

  if (
    status === 409 ||
    (apiCode !== undefined && /already|duplicate|exists|logged/i.test(apiCode))
  ) {
    return "already_logged";
  }

  // No HTTP status means the request never reached the server (a dropped
  // connection), not a fault it sent back.
  if (status === undefined) {
    return "offline";
  }

  return "failed";
}

/** The in-voice line each outcome shows (crew register, VOICE.md). */
export const submitOutcomeCopy: Record<SubmitOutcome, string> = {
  already_logged: "Already in the log, good ear. Great minds and all that.",
  failed: "That one didn't make it back to me. Give it another go in a moment.",
  offline: "Couldn't reach the Galaxy just then. Check your connection and try again.",
  rate_limited:
    "Easy, cosmonaut. That's a fair few in a short stretch. Give it an hour, then send the next one.",
};
