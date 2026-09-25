import {
  type ReplicaFindingRow,
  REPLICA_FINDINGS_LIMIT,
  REPLICA_FINDINGS_SQL,
  parseArtists,
  toReplicaFinding,
  toReplicaFindings,
} from "@/lib/replica-rows";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(value: boolean, message: string): void {
  if (!value) {
    throw new Error(message);
  }
}

assertEqual((REPLICA_FINDINGS_SQL.match(/\?/g) ?? []).length, 1, "one bound parameter: the limit");
assertTrue(
  !/[:$@][a-z_]/i.test(REPLICA_FINDINGS_SQL),
  "no named parameter binding — unsupported in libSQL mode",
);
assertTrue(
  REPLICA_FINDINGS_SQL.includes('f."log_id" is not null'),
  "the certification test: a findings row without a coordinate is never rendered",
);
assertTrue(
  REPLICA_FINDINGS_SQL.includes('order by f."added_at" desc'),
  "newest first, served by the cut's own added_at index",
);
assertEqual(REPLICA_FINDINGS_LIMIT, 200, "deep enough to browse, small enough to be instant");

for (const banned of ["embedding", "vector", "token", "secret", "email"]) {
  assertTrue(!REPLICA_FINDINGS_SQL.includes(banned), `the read never names a ${banned} column`);
}

assertEqual(parseArtists('["Netsky","Metrik"]').join("|"), "Netsky|Metrik", "the happy shape");
assertEqual(parseArtists("[]").length, 0, "an empty list");
assertEqual(parseArtists("not json").length, 0, "malformed JSON");
assertEqual(parseArtists('{"a":1}').length, 0, "an object is not a list");
assertEqual(parseArtists(null).length, 0, "a null column");
assertEqual(parseArtists(undefined).length, 0, "an absent column");
assertEqual(parseArtists('["Netsky",null,42,""]').join("|"), "Netsky", "drops non-strings");

const row = (overrides: Partial<ReplicaFindingRow> = {}): ReplicaFindingRow => ({
  added_at: "2026-07-01T10:00:00.000Z",
  album_image_url: "https://i.example/cover.jpg",
  artists_json: '["Netsky"]',
  bpm: 174,
  log_id: "042.A.07",
  musical_key: "G# minor",
  title: "Escape",
  track_id: "spotify-track-1",
  ...overrides,
});

const mapped = toReplicaFinding(row());
assertEqual(mapped?.logId, "042.A.07");
assertEqual(mapped?.trackId, "spotify-track-1");
assertEqual(mapped?.title, "Escape");
assertEqual(mapped?.artists.join("|"), "Netsky");
assertEqual(mapped?.bpm, 174);
assertEqual(mapped?.key, "G# minor");
assertEqual(mapped?.albumImageUrl, "https://i.example/cover.jpg");

assertEqual(toReplicaFinding(row({ log_id: null })), undefined, "no coordinate");
assertEqual(toReplicaFinding(row({ log_id: "" })), undefined, "an empty coordinate");
assertEqual(toReplicaFinding(row({ track_id: undefined })), undefined, "no track id");
assertEqual(toReplicaFinding(row({ title: null })), undefined, "no title");

const sparse = toReplicaFinding(
  row({ album_image_url: null, artists_json: null, bpm: null, musical_key: null }),
);
assertEqual(sparse?.bpm, undefined, "no bpm");
assertEqual(sparse?.key, undefined, "no key");
assertEqual(sparse?.albumImageUrl, undefined, "no cover");
assertEqual(sparse?.artists.length, 0, "no artists");
assertEqual(sparse?.title, "Escape", "still renders");

assertEqual(toReplicaFinding(row({ bpm: "174" }))?.bpm, 174, "a TEXT-declared bpm column");
assertEqual(toReplicaFinding(row({ bpm: "n/a" }))?.bpm, undefined, "junk is not a figure");
assertEqual(toReplicaFinding(row({ bpm: Number.NaN }))?.bpm, undefined, "NaN is not a figure");

const list = toReplicaFindings([
  row({ log_id: "042.A.07" }),
  row({ log_id: null }),
  row({ log_id: "042.A.08" }),
]);
assertEqual(list.length, 2, "the unrenderable row is dropped");
assertEqual(list[0]?.logId, "042.A.07", "order preserved");
assertEqual(list[1]?.logId, "042.A.08", "order preserved");
assertEqual(toReplicaFindings([]).length, 0, "an empty result set");

console.log("replica-rows.test.ts: all assertions passed");
