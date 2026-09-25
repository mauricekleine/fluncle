import { classifySubmit, faultInfo, submitOutcomeCopy, submitPausedCopy } from "@/lib/submit-fault";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function fault(status?: number, apiCode?: string): unknown {
  return {
    data: apiCode === undefined ? undefined : { body: { code: apiCode, ok: false } },
    status,
  };
}

assertEqual(classifySubmit(fault(429, "rate_limited")), "rate_limited", "429 → rate_limited");
assertEqual(
  classifySubmit(fault(undefined, "rate_limited")),
  "rate_limited",
  "rate_limited code with no status → rate_limited",
);

assertEqual(classifySubmit(fault(400, "invalid_request")), "failed", "400 → failed");
assertEqual(classifySubmit(fault(500, "error")), "failed", "500 → failed");

assertEqual(classifySubmit(fault()), "offline", "no status → offline");
assertEqual(
  classifySubmit(new Error("Network request failed")),
  "offline",
  "plain Error → offline",
);
assertEqual(classifySubmit(undefined), "offline", "undefined → offline");

assertEqual(classifySubmit(fault(409, "conflict")), "already_logged", "409 → already_logged");
assertEqual(
  classifySubmit(fault(400, "already_submitted")),
  "already_logged",
  "already_* code → already_logged",
);
assertEqual(
  classifySubmit(fault(400, "duplicate_finding")),
  "already_logged",
  "duplicate_* code → already_logged",
);

assertEqual(faultInfo(null).status, undefined, "null → no status");
assertEqual(faultInfo("nope").apiCode, undefined, "string → no apiCode");
assertEqual(faultInfo(fault(429, "rate_limited")).apiCode, "rate_limited", "reads data.body.code");
assertEqual(
  faultInfo({ data: { apiCode: "rate_limited" }, status: 429 }).apiCode,
  "rate_limited",
  "reads flat data.apiCode fallback",
);

for (const outcome of ["already_logged", "failed", "offline", "rate_limited"] as const) {
  const copy = submitOutcomeCopy[outcome];
  assertEqual(copy.length > 0, true, `${outcome} has copy`);
  assertEqual(copy.includes("!"), false, `${outcome} copy has no exclamation mark`);
}

assertEqual(
  submitOutcomeCopy.rate_limited,
  "Easy, fam. That's a fair few in a short stretch. Give it an hour, then send the next one.",
  "rate_limited copy is the ratified string",
);

assertEqual(submitPausedCopy.sendLabel, "Waiting to send", "the send control's paused label");
assertEqual(submitPausedCopy.searchLabel, "Waiting to search", "the search control's paused label");
for (const label of [submitPausedCopy.sendLabel, submitPausedCopy.searchLabel]) {
  assertEqual(label.includes("…"), false, `a paused label is a state, not an ellipsis: "${label}"`);
}

assertEqual(
  submitPausedCopy.queuedLine,
  "You're offline. I'm holding your track here, and I'll send it for review the moment you're back.",
  "the queued-submission line is the ratified string",
);
assertEqual(
  submitPausedCopy.queuedLine.includes("!"),
  false,
  "queued line has no exclamation mark",
);
assertEqual(submitPausedCopy.queuedLine.includes("—"), false, "queued line has no em-dash");
for (const word of ["transmission", "signal", "anomaly", "curated", "content", "stream", "mint"]) {
  assertEqual(
    submitPausedCopy.queuedLine.toLowerCase().includes(word),
    false,
    `queued line carries no retired identity word "${word}"`,
  );
}

assertEqual(
  submitPausedCopy.queuedLine.includes("your track"),
  true,
  "the queued line names the noun it is holding",
);
