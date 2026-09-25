import { type SearchEntity, type SearchHit } from "@fluncle/contracts/orpc";

import {
  MIN_QUERY_LENGTH,
  entityWebPath,
  normalizeQuery,
  partitionEntities,
  partitionTracks,
  searchView,
} from "@/lib/search-state";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(normalizeQuery("  netsky  "), "netsky", "trims surrounding whitespace");
assertEqual(normalizeQuery("   "), "", "all whitespace → empty");

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

assertEqual(
  searchView({ hasResults: false, isError: false, isFetching: true, query: "n" }),
  "tooShort",
  "single char → tooShort, never a fetch",
);
assertEqual(MIN_QUERY_LENGTH, 2, "the floor is two, matching the server + web");

assertEqual(
  searchView({ hasResults: false, isError: false, isFetching: true, query: "netsky" }),
  "loading",
  "in-flight, no rows yet → loading",
);

assertEqual(
  searchView({ hasResults: true, isError: false, isFetching: true, query: "netsky" }),
  "results",
  "rows present while refetching → results, not loading",
);

assertEqual(
  searchView({ hasResults: false, isError: true, isFetching: false, query: "netsky" }),
  "error",
  "settled failure, no rows → error",
);

assertEqual(
  searchView({ hasResults: false, isError: false, isFetching: false, query: "zzzzz" }),
  "empty",
  "settled, no rows, no error → empty",
);

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

const withGalaxyAndMixtape = partitionEntities([
  { kind: "mixtape", name: "Summer Voyage", slug: "005.F.03", url: "/log/005.F.03" },
  { kind: "galaxy", name: "Amber Drift", slug: "amber-drift", url: "/galaxies/amber-drift" },
  { kind: "artist", name: "Netsky", slug: "netsky" },
]);
assertEqual(withGalaxyAndMixtape.length, 3, "artist, galaxy, and mixtape groups render");
assertEqual(withGalaxyAndMixtape[1]?.heading, "Galaxies", "galaxies follow albums");
assertEqual(withGalaxyAndMixtape[2]?.heading, "Mixtapes", "mixtapes come last");

function hit(trackId: string, certified: boolean): SearchHit {
  return { artists: ["Netsky"], certified, title: trackId, trackId };
}
const mixed = partitionTracks([
  hit("uncert-1", false),
  hit("cert-1", true),
  hit("uncert-2", false),
  hit("cert-2", true),
]);
assertEqual(mixed.length, 2, "both a certified and an uncertified group render");
assertEqual(mixed[0]?.heading, "Fluncle's Findings", "certified group leads");
assertEqual(mixed[0]?.certified, true, "the leading group is the certified one");
assertEqual(mixed[0]?.hits.length, 2, "both certified hits land in the findings group");
assertEqual(mixed[0]?.hits[0]?.trackId, "cert-1", "certified order preserved (cert-1 first)");
assertEqual(mixed[1]?.heading, "Tracks", "uncertified group is headed 'Tracks'");
assertEqual(mixed[1]?.certified, false, "the second group is the uncertified one");
assertEqual(mixed[1]?.hits[0]?.trackId, "uncert-1", "uncertified order preserved");

const onlyCert = partitionTracks([hit("c", true)]);
assertEqual(onlyCert.length, 1, "no uncertified hits → only the findings group");
assertEqual(onlyCert[0]?.heading, "Fluncle's Findings", "the sole group is the findings one");

const onlyUncert = partitionTracks([hit("u", false)]);
assertEqual(onlyUncert.length, 1, "no certified hits → only the tracks group");
assertEqual(onlyUncert[0]?.heading, "Tracks", "the sole group is the tracks one");

assertEqual(partitionTracks([]).length, 0, "no results → no track groups");

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
assertEqual(
  entityWebPath({ kind: "galaxy", slug: "amber-drift", url: "/galaxies/amber-drift" }),
  "/galaxies/amber-drift",
  "galaxy → its own url (plural segment)",
);
assertEqual(
  entityWebPath({ kind: "mixtape", slug: "005.F.03", url: "/log/005.F.03" }),
  "/log/005.F.03",
  "mixtape → its own url (the log page)",
);
