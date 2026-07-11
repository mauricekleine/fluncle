// Self-running checks for classifySubmit — no framework, mirroring media.test.ts's
// node:assert-free style (the Expo tsconfig has no @types/node). Run via `bun test`
// (reports "0 pass" — no describe/it blocks — but throws and fails the process on any
// failed assertion) or `bun src/lib/submit-fault.test.ts`.
//
// This pins the submit flow's honest result states to the server faults the public
// `submit_track` op actually emits: a 429 rate limit, a validation/Spotify fault, a
// dropped connection (no HTTP status), and the wired-but-dormant already-logged case
// (gated on a real conflict signal so it can never misfire before the server grows
// dedupe).

import { classifySubmit, faultInfo, submitOutcomeCopy } from "@/lib/submit-fault";

// A tiny strict-equality assertion (see media.test.ts): framework- and dependency-free,
// still throws (and fails the `bun test` process) on a mismatch.
function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// A stand-in for the oRPC OpenAPILink client's thrown ORPCError, in the shape
// verified against the live server: an HTTP `status` plus `data.body.code` carrying
// the server's legacy apiCode (e.g. "rate_limited").
function fault(status?: number, apiCode?: string): unknown {
  return {
    data: apiCode === undefined ? undefined : { body: { code: apiCode, ok: false } },
    status,
  };
}

// 1. The 429 rate limit — by status or by apiCode.
assertEqual(classifySubmit(fault(429, "rate_limited")), "rate_limited", "429 → rate_limited");
assertEqual(
  classifySubmit(fault(undefined, "rate_limited")),
  "rate_limited",
  "rate_limited code with no status → rate_limited",
);

// 2. A validation / Spotify fault the server responded with → a generic failed state.
assertEqual(classifySubmit(fault(400, "invalid_request")), "failed", "400 → failed");
assertEqual(classifySubmit(fault(500, "error")), "failed", "500 → failed");

// 3. No HTTP status means the request never reached the server → offline.
assertEqual(classifySubmit(fault()), "offline", "no status → offline");
assertEqual(
  classifySubmit(new Error("Network request failed")),
  "offline",
  "plain Error → offline",
);
assertEqual(classifySubmit(undefined), "offline", "undefined → offline");

// 4. The wired-but-dormant already-logged case: only a real conflict signal (a 409 or an
//    already/duplicate-flavoured code) triggers it, so it can never misfire today.
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

// 5. faultInfo reads defensively off unknown shapes.
assertEqual(faultInfo(null).status, undefined, "null → no status");
assertEqual(faultInfo("nope").apiCode, undefined, "string → no apiCode");
assertEqual(faultInfo(fault(429, "rate_limited")).apiCode, "rate_limited", "reads data.body.code");
assertEqual(
  faultInfo({ data: { apiCode: "rate_limited" }, status: 429 }).apiCode,
  "rate_limited",
  "reads flat data.apiCode fallback",
);

// 6. Every outcome has a non-empty in-voice line (no exclamation marks — the Dry Rule).
for (const outcome of ["already_logged", "failed", "offline", "rate_limited"] as const) {
  const copy = submitOutcomeCopy[outcome];
  assertEqual(copy.length > 0, true, `${outcome} has copy`);
  assertEqual(copy.includes("!"), false, `${outcome} copy has no exclamation mark`);
}
