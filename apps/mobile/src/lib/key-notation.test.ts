// Self-running checks for the key-notation account (profile-sync) layer — no framework,
// mirroring the repo's node:assert-free style (saved-store.test.ts / me-fetch.test.ts). Run
// via `bun test` or `bun src/lib/key-notation.test.ts`.
//
// These pin the three semantics slice 3 adds on top of the untouched device path: the
// anonymous NO-OP (a session-less user never adopts and never mirrors), the adopt PRECEDENCE
// (the profile's stored notation wins over the device value on sign-in), and the
// fire-and-forget MIRROR (a toggle while signed in PATCHes `/api/v1/me/preferences` with the
// closed `{ keyNotation }` payload, and a failed mirror never reverts the device value). The
// `meFetch` layer is mocked — no network, no native auth client.
//
// The store is a module singleton, so the assertions run as one ordered script: anonymous
// first (signedIn stays false), then a forced sign-in adopt, then the mirror.

import { type MeFetch } from "@/lib/me-fetch";
import {
  configureKeyNotationSync,
  formatKey,
  getKeyNotation,
  setKeyNotation,
  syncKeyNotationFromAccount,
} from "@/lib/key-notation";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// A mock `meFetch`: records every call and answers from a swappable responder. `rejectPatch`
// exercises the fire-and-forget guarantee (a failed mirror must not throw or revert).
type Call = { body?: string; method: string; path: string };
let calls: Call[] = [];
let responder: (path: string) => unknown = () => ({});
let rejectPatch = false;

const mockMeFetch: MeFetch = async (path, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  calls.push({ body: init.body, method, path });

  if (rejectPatch && method === "PATCH") {
    throw new Error("network down");
  }

  const data = responder(path);
  return { json: async () => data, ok: true } as unknown as Response;
};

configureKeyNotationSync(mockMeFetch);

// 0. Pure display helper is unchanged — a parseable key maps, the default reads verbatim.
assertEqual(formatKey("F major", "camelot"), "7B", "camelot maps a parseable key");
assertEqual(formatKey("F major", "scales"), "F major", "scales reads verbatim");
assertEqual(formatKey("", "camelot"), "", "empty key stays empty");

// 1. ANONYMOUS NO-OP. A session-less user (GET /api/v1/me → user: null) never adopts a profile
//    value and never fetches preferences.
calls = [];
responder = () => ({ user: null });
await syncKeyNotationFromAccount();
assertEqual(getKeyNotation(), "scales", "anonymous sync leaves the default device value");
assertEqual(
  calls.some((call) => call.path === "/api/v1/me/preferences"),
  false,
  "anonymous sync never reads preferences (it stops at the null session)",
);

// 2. ANONYMOUS MIRROR NO-OP. Toggling while signed-out updates the device immediately but
//    NEVER PATCHes a profile (the account only syncs, it never gates the device path).
calls = [];
setKeyNotation("camelot");
assertEqual(getKeyNotation(), "camelot", "an anonymous toggle still updates the device");
assertEqual(calls.length, 0, "an anonymous toggle makes no /me call");

// 3. ADOPT PRECEDENCE. On a live session the PROFILE value wins over the device. Device is
//    "scales" here; the profile says "camelot"; after a forced sync the store is "camelot".
setKeyNotation("scales"); // device now "scales" (still anonymous → no mirror)
calls = [];
responder = (path) =>
  path === "/api/v1/me/preferences"
    ? { preferences: { keyNotation: "camelot" } }
    : { user: { id: "u1" } };
await syncKeyNotationFromAccount({ force: true });
assertEqual(getKeyNotation(), "camelot", "the profile's notation wins over the device value");
assertEqual(calls[0]?.path, "/api/v1/me", "sign-in adopt probes the session first");
assertEqual(
  calls.some((call) => call.path === "/api/v1/me/preferences" && call.method === "GET"),
  true,
  "a live session reads the profile preferences",
);

// 4. FIRE-AND-FORGET MIRROR PAYLOAD. Signed in now, a toggle updates the device AND PATCHes
//    the profile with the closed `{ keyNotation }` object.
calls = [];
setKeyNotation("scales");
assertEqual(getKeyNotation(), "scales", "the mirror toggle updates the device immediately");
const patch = calls.find((call) => call.method === "PATCH");
assertEqual(patch?.path, "/api/v1/me/preferences", "the mirror PATCHes the preferences endpoint");
assertEqual(
  patch?.body,
  JSON.stringify({ keyNotation: "scales" }),
  "the payload is the closed keyNotation object",
);

// 5. A FAILED MIRROR NEVER REVERTS. The PATCH throws; the device value still holds and
//    nothing propagates (fire-and-forget).
rejectPatch = true;
calls = [];
setKeyNotation("camelot");
assertEqual(getKeyNotation(), "camelot", "a failing mirror never reverts the device value");
assertEqual(
  calls.some((call) => call.method === "PATCH"),
  true,
  "the mirror was still attempted",
);
rejectPatch = false;

console.log("key-notation.test.ts: all assertions passed");
