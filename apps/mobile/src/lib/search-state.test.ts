// Self-running checks for the archive search's pure helpers — no framework, mirroring
// the repo's node:assert-free style (submit-fault.test.ts / archive-state.test.ts).
// Run via `bun test` (reports "0 pass" — no describe/it blocks — but throws and fails
// the process on any failed assertion) or `bun src/lib/search-state.test.ts`.
//
// These pin the two things the search pane must not get wrong: the honest state branch
// (so a cold field never flashes an empty state, and a one-char query never fires the
// server), and the entity partitioning (canonical order, empty groups dropped).

import { type SearchEntity } from "@fluncle/contracts/orpc";

import {
  MIN_QUERY_LENGTH,
  entityWebPath,
  normalizeQuery,
  partitionEntities,
  searchView,
} from "@/lib/search-state";

// A tiny strict-equality assertion (see submit-fault.test.ts): framework- and
// dependency-free, still throws (and fails the `bun test` process) on a mismatch.
function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// 1. normalizeQuery trims to what the server sees.
assertEqual(normalizeQuery("  netsky  "), "netsky", "trims surrounding whitespace");
assertEqual(normalizeQuery("   "), "", "all whitespace → empty");

// 2. The state branch. An empty field is idle, never empty.
assertEqual(
  searchView({ hasResults: false, isError: false, isFetching: false, query: "" }),
  "idle",
  "empty field → idle, never empty",
);
assertEqual(
  searchView({ hasResults: false, isError: false, isFetching: false, query: "   " }),
  "idle",
  "whitespace-only field → idle",
);

// 3. A one-character query is below the floor — the server has nothing to go on.
assertEqual(
  searchView({ hasResults: false, isError: false, isFetching: true, query: "n" }),
  "tooShort",
  "single char → tooShort, never a fetch",
);
assertEqual(MIN_QUERY_LENGTH, 2, "the floor is two, matching the server + web");

// 4. A first in-flight query with nothing yet is loading.
assertEqual(
  searchView({ hasResults: false, isError: false, isFetching: true, query: "netsky" }),
  "loading",
  "in-flight, no rows yet → loading",
);

// 5. Rows win over a background refetch (results never nuked by a refresh).
assertEqual(
  searchView({ hasResults: true, isError: false, isFetching: true, query: "netsky" }),
  "results",
  "rows present while refetching → results, not loading",
);

// 6. A settled failure with nothing to show is an honest error, not empty.
assertEqual(
  searchView({ hasResults: false, isError: true, isFetching: false, query: "netsky" }),
  "error",
  "settled failure, no rows → error",
);

// 7. A settled query that genuinely found nothing is the only empty state.
assertEqual(
  searchView({ hasResults: false, isError: false, isFetching: false, query: "zzzzz" }),
  "empty",
  "settled, no rows, no error → empty",
);

// 8. Entity partitioning: canonical order (artists, labels, albums), empty groups dropped.
const entities: SearchEntity[] = [
  { kind: "album", name: "Colours in Rhythm", slug: "colours-in-rhythm" },
  { kind: "artist", name: "Netsky", slug: "netsky" },
  { kind: "artist", name: "Camo & Krooked", slug: "camo-krooked" },
];
const groups = partitionEntities(entities);
assertEqual(groups.length, 2, "only the two non-empty kinds render (no labels here)");
assertEqual(groups[0]?.kind, "artist", "artists lead");
assertEqual(groups[0]?.heading, "Artists", "artist heading names the kind");
assertEqual(groups[0]?.entities.length, 2, "both artists land in the artist group");
assertEqual(groups[1]?.kind, "album", "albums follow (labels dropped, none present)");

assertEqual(partitionEntities([]).length, 0, "no entities → no groups");

// 9. Entity web path: kind decides the route, nothing else.
assertEqual(
  entityWebPath({ kind: "artist", slug: "netsky" }),
  "/artist/netsky",
  "artist → /artist/<slug>",
);
assertEqual(
  entityWebPath({ kind: "label", slug: "hospital-records" }),
  "/label/hospital-records",
  "label → /label/<slug>",
);
