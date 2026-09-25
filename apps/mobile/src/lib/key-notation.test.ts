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

assertEqual(formatKey("F major", "camelot"), "7B", "camelot maps a parseable key");
assertEqual(formatKey("F major", "scales"), "F major", "scales reads verbatim");
assertEqual(formatKey("", "camelot"), "", "empty key stays empty");

calls = [];
responder = () => ({ user: null });
await syncKeyNotationFromAccount();
assertEqual(getKeyNotation(), "scales", "anonymous sync leaves the default device value");
assertEqual(
  calls.some((call) => call.path === "/api/v1/me/preferences"),
  false,
  "anonymous sync never reads preferences (it stops at the null session)",
);

calls = [];
setKeyNotation("camelot");
assertEqual(getKeyNotation(), "camelot", "an anonymous toggle still updates the device");
assertEqual(calls.length, 0, "an anonymous toggle makes no /me call");

setKeyNotation("scales");
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
