// Self-running checks for the replica's read — no framework (see replica-identity.test.ts on
// the style). No database: the mapper is fed raw row objects of exactly the shape SQLite hands
// back, and the SQL is checked as text.
//
// Two things are pinned here that a device would otherwise have to teach: the query obeys
// libSQL mode's positional-only parameter binding, and a single unrenderable row costs that
// row rather than the whole offline list.

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

// 1. The query's load-bearing properties. libSQL mode rejects NAMED parameters (the spike
//    measured it), so exactly one positional `?` and no `:name` / `$name` / `@name` anywhere.
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

// 2. Every column the query names must be one the deriving side lets across the device
//    boundary (apps/web/scripts/lib/device-db-schema.ts). Nothing here may reach for a source
//    column the cut deliberately withholds.
for (const banned of ["embedding", "vector", "token", "secret", "email"]) {
  assertTrue(!REPLICA_FINDINGS_SQL.includes(banned), `the read never names a ${banned} column`);
}

// 3. The artist list, tolerant of everything the column can hold.
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

// 4. The happy mapping lands on exactly the fields ArchiveRow already takes.
const mapped = toReplicaFinding(row());
assertEqual(mapped?.logId, "042.A.07");
assertEqual(mapped?.trackId, "spotify-track-1");
assertEqual(mapped?.title, "Escape");
assertEqual(mapped?.artists.join("|"), "Netsky");
assertEqual(mapped?.bpm, 174);
assertEqual(mapped?.key, "G# minor");
assertEqual(mapped?.albumImageUrl, "https://i.example/cover.jpg");

// 5. A row missing anything a row must be RENDERED by is dropped, never rendered blank: there
//    would be nothing to name it by and nowhere to send a tap.
assertEqual(toReplicaFinding(row({ log_id: null })), undefined, "no coordinate");
assertEqual(toReplicaFinding(row({ log_id: "" })), undefined, "an empty coordinate");
assertEqual(toReplicaFinding(row({ track_id: undefined })), undefined, "no track id");
assertEqual(toReplicaFinding(row({ title: null })), undefined, "no title");

// 6. The optional fields simply drop out; the meta line renders what is there and says nothing
//    about what is not. A replica row carries no galaxy at all — the cut has no such column.
const sparse = toReplicaFinding(
  row({ album_image_url: null, artists_json: null, bpm: null, musical_key: null }),
);
assertEqual(sparse?.bpm, undefined, "no bpm");
assertEqual(sparse?.key, undefined, "no key");
assertEqual(sparse?.albumImageUrl, undefined, "no cover");
assertEqual(sparse?.artists.length, 0, "no artists");
assertEqual(sparse?.title, "Escape", "still renders");

// 7. A bpm stored as text still reads as a figure; a bpm that is not a number does not.
assertEqual(toReplicaFinding(row({ bpm: "174" }))?.bpm, 174, "a TEXT-declared bpm column");
assertEqual(toReplicaFinding(row({ bpm: "n/a" }))?.bpm, undefined, "junk is not a figure");
assertEqual(toReplicaFinding(row({ bpm: Number.NaN }))?.bpm, undefined, "NaN is not a figure");

// 8. Over a result set: order is preserved, and one bad row costs that row alone.
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
