export type SubmitOutcome = "already_logged" | "failed" | "offline" | "rate_limited";

export function faultInfo(error: unknown): { apiCode?: string; status?: number } {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const fault = error as { data?: unknown; status?: unknown };
  const status = typeof fault.status === "number" ? fault.status : undefined;
  let apiCode: string | undefined;

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

  if (status === undefined) {
    return "offline";
  }

  return "failed";
}

export const submitPausedCopy = {
  queuedLine:
    "You're offline. I'm holding your track here, and I'll send it for review the moment you're back.",
  searchLabel: "Waiting to search",
  sendLabel: "Waiting to send",
} as const;

export const submitOutcomeCopy: Record<SubmitOutcome, string> = {
  already_logged: "Already in the log, good ear. Great minds and all that.",
  failed: "That one didn't make it back to me. Give it another go in a moment.",
  offline: "Couldn't reach the Galaxy just then. Check your connection and try again.",
  rate_limited:
    "Easy, fam. That's a fair few in a short stretch. Give it an hour, then send the next one.",
};
