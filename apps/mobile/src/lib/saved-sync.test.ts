import {
  type RemoteSavedFinding,
  type SyncFetch,
  deleteSavedFinding,
  fromRemote,
  localOnly,
  mergeUnion,
  parseRemoteList,
  pushSavedFinding,
  runUnionMerge,
} from "@/lib/saved-sync";
import { type SavedFinding } from "@/lib/saved-store";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const localRow = (logId: string, savedAt: number, trackId = `t-${logId}`): SavedFinding => ({
  albumImageUrl: `art-${logId}`,
  artists: ["Netsky"],
  bpm: 174,
  key: "G# minor",
  logId,
  savedAt,
  title: `Track ${logId}`,
  trackId,
});

const remoteRow = (logId: string, savedAt: string, trackId = `t-${logId}`): RemoteSavedFinding => ({
  artists: ["Sub Focus"],
  logId,
  savedAt,
  title: `Remote ${logId}`,
  trackId,
});

const adapted = fromRemote(remoteRow("B", "2026-07-12T10:00:00.000Z"));
assertEqual(adapted.logId, "B", "logId carried through");
assertEqual(adapted.trackId, "t-B", "trackId carried through");
assertEqual(adapted.title, "Remote B", "title carried through");
assertEqual(adapted.savedAt, Date.parse("2026-07-12T10:00:00.000Z"), "savedAt parsed to epoch ms");
assertEqual(adapted.albumImageUrl, undefined, "no album art on an account row");
assertEqual(adapted.bpm, undefined, "no bpm on an account row");

assertEqual(fromRemote(remoteRow("Z", "not-a-date")).savedAt, 0, "bad savedAt → 0");

const ms = (iso: string): number => Date.parse(iso);

const localList = [
  localRow("A", ms("2026-07-12T12:00:00.000Z")),
  localRow("B", ms("2026-07-12T08:00:00.000Z")),
];
const remoteList = [remoteRow("B", "2026-07-12T00:00:00.000Z")];
const toPush = localOnly(localList, remoteList);
assertEqual(toPush.length, 1, "only the account-missing save is pushed");
assertEqual(toPush[0]?.logId, "A", "A is device-only, B is already aboard");

const union = mergeUnion(localList, [
  remoteRow("B", "2026-07-12T00:00:00.000Z"),
  remoteRow("C", "2026-07-12T09:00:00.000Z"),
]);
assertEqual(union.length, 3, "A(local) + B(both, deduped) + C(remote) = 3");
assertEqual(union[0]?.logId, "A", "newest (A, 12:00) leads");

const bRow = union.find((row) => row.logId === "B");
assertEqual(bRow?.bpm, 174, "the collision kept the richer local snapshot");
assertEqual(union.filter((row) => row.logId === "B").length, 1, "B appears exactly once");

assertEqual(
  union.some((row) => row.logId === "C"),
  true,
  "the remote-only row joined the union",
);

assertEqual(parseRemoteList(null).length, 0, "null body → empty");
assertEqual(parseRemoteList({ savedFindings: "nope" }).length, 0, "non-array → empty");
assertEqual(
  parseRemoteList({ ok: true, savedFindings: [{ logId: "X" }] }).length,
  0,
  "a row missing title/artists/savedAt/trackId is dropped",
);
assertEqual(
  parseRemoteList({
    ok: true,
    savedFindings: [
      {
        artists: ["a"],
        logId: "B",
        savedAt: "2026-07-12T00:00:00.000Z",
        title: "t",
        trackId: "t-B",
      },
    ],
  }).length,
  1,
  "a complete row survives the parse",
);

type Call = { body?: string; method: string; path: string };

function mockFetch(calls: Call[], list: RemoteSavedFinding[], listOk = true): SyncFetch {
  return async (path, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ body: init?.body, method, path });
    if (path === "/api/v1/me/saved-findings" && method === "GET") {
      return { json: async () => ({ ok: true, savedFindings: list }), ok: listOk };
    }
    return { json: async () => ({ ok: true }), ok: true };
  };
}

const happyCalls: Call[] = [];
const happy = await runUnionMerge({
  fetch: mockFetch(happyCalls, [remoteRow("B", "2026-07-12T00:00:00.000Z")]),
  local: [
    localRow("A", ms("2026-07-12T12:00:00.000Z")),
    localRow("B", ms("2026-07-12T08:00:00.000Z")),
  ],
});
assertEqual(happy.pushed, 1, "exactly the device-only save (A) is pushed");
assertEqual(happy.merged.length, 2, "the union is A + B");
assertEqual(happy.merged[0]?.logId, "A", "union is newest-first");
assertEqual(happyCalls[0]?.method, "GET", "the list is pulled first");
const post = happyCalls.find((call) => call.method === "POST");
assertEqual(post?.path, "/api/v1/me/saved-findings", "the push hits the save op");
assertEqual(post?.body, JSON.stringify({ logId: "A", trackId: "t-A" }), "the push carries A's ids");

const idemCalls: Call[] = [];
const idem = await runUnionMerge({
  fetch: mockFetch(idemCalls, [remoteRow("A", "2026-07-12T00:00:00.000Z", "t-A")]),
  local: [localRow("A", 3000)],
});
assertEqual(idem.pushed, 0, "no push when the account already holds the save");
assertEqual(
  idemCalls.some((call) => call.method === "POST"),
  false,
  "no POST fired",
);

const failCalls: Call[] = [];
const localRef = [localRow("A", 3000)];
const failed = await runUnionMerge({
  fetch: mockFetch(failCalls, [], false),
  local: localRef,
});
assertEqual(failed.merged === localRef, true, "a failed pull returns the untouched local list");
assertEqual(failed.pushed, 0, "a failed pull pushes nothing");
assertEqual(
  failCalls.some((call) => call.method === "POST"),
  false,
  "no POST after a failed pull",
);

const mirrorCalls: Call[] = [];
await pushSavedFinding(mockFetch(mirrorCalls, []), { logId: "M", trackId: "t-M" });
assertEqual(mirrorCalls[0]?.method, "POST", "a mirror-save POSTs");
assertEqual(mirrorCalls[0]?.path, "/api/v1/me/saved-findings", "to the save op");
const delCalls: Call[] = [];
await deleteSavedFinding(mockFetch(delCalls, []), "t-M");
assertEqual(delCalls[0]?.method, "DELETE", "a mirror-unsave DELETEs");
assertEqual(delCalls[0]?.path, "/api/v1/me/saved-findings/t-M", "by trackId in the path");

console.log("saved-sync.test.ts: all assertions passed");
