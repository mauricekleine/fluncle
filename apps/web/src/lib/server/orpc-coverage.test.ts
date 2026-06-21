import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES } from "@fluncle/contracts/orpc";

// Coverage scaffold for the oRPC migration (docs/orpc-migration-brief.md,
// "Definition of done"). It enumerates the PUBLIC HTTP API routes and asserts
// each is either:
//   - CONVERTED — owned by an oRPC contract (named in the registry), or
//   - PENDING   — on the explicit, shrinking allow-list below, awaiting the
//                 fan-out phase, or
//   - a CARVE-OUT — intentionally staying on TanStack forever.
//
// A route that is none of these fails the build — that is the enforcement the
// migration exists for: a new public route with no contract can't slip in
// unnoticed. Going the other way is also a failure: a route may not be both
// converted AND pending (the pending list must shrink as routes convert), and a
// pending entry must correspond to a real route (no stale names).
//
// Phase 1 converted one route (`get_track`); the fan-out pilot added the three
// public-unauth reads (`get_health`, `list_tracks`, `get_random_track`); fan-out
// Wave A converted the five remaining public-unauthenticated ops (`list_mixtapes`,
// `search_tracks`, `list_stories`, `submit_track`, `subscribe_newsletter`); fan-out
// Wave B converts the thirteen `/me` PRIVATE-SESSION ops (the user-auth tier in
// ../orpc-auth). With Wave B the PENDING list is EMPTY — the public surface is
// fully contract-first. The admin tier is its own later wave (carved out below).

// Each public API route, keyed by its `/api/v1`-relative path, mapped to the
// canonical Convention-B `verb_noun` op name it should be served by. This is the
// public-surface registry the coverage net is drawn over; admin + carve-outs are
// listed separately so the net's edges are explicit, not accidental.
const PUBLIC_ROUTE_OPS: Record<string, string> = {
  "DELETE /me/saved-findings/{trackId}": "unsave_private_finding",
  "GET /health": "get_health",
  "GET /me": "get_current_private_user",
  "GET /me/csrf": "get_private_mutation_token",
  "GET /me/export/{exportId}": "get_private_account_export",
  "GET /me/galaxy-progress": "get_private_galaxy_progress",
  "GET /me/saved-findings": "list_private_saved_findings",
  "GET /me/submissions": "list_private_submissions",
  "GET /mixtapes": "list_mixtapes",
  "GET /search": "search_tracks",
  "GET /stories": "list_stories",
  "GET /tracks": "list_tracks",
  "GET /tracks/random": "get_random_track",
  "GET /tracks/{idOrLogId}": "get_track",
  "PATCH /me/profile": "update_private_profile",
  "POST /me/delete": "delete_private_account",
  "POST /me/export": "export_private_account_data",
  // The only `/me/galaxy-progress/logs` route is this POST collect-one (the game's
  // per-find write → `collectLogId`); there is no list-logs route, so the op is
  // named for what it does (see ../../routes/api/me/galaxy-progress/logs.ts).
  "POST /me/galaxy-progress/logs": "collect_private_galaxy_log",
  "POST /me/saved-findings": "save_private_finding",
  "POST /newsletter": "subscribe_newsletter",
  "POST /submissions": "submit_track",
  "PUT /me/galaxy-progress": "merge_private_galaxy_progress",
};

// Routes that stay on TanStack by design (docs/orpc-migration-brief.md
// "Carve-outs"): OAuth browser-redirect callbacks, and binary/image render
// endpoints that emit non-JSON bytes. These are NOT counted against coverage —
// they will never have a contract — but they ARE listed so the enumeration is
// total and a new carve-out is a deliberate edit here, not an omission.
const CARVE_OUT_ROUTE_PREFIXES = [
  "auth/", // Spotify/YouTube/Mixcloud/Last.fm OAuth callbacks → browser redirects.
];

// Binary/render routes: emit images/audio, not RPC JSON. Carved out like OAuth.
const CARVE_OUT_ROUTES = new Set([
  "mixtape-cover.$logId",
  "og.$logId",
  "preview.$idOrLogId",
  // The generated-spec + tooling surfaces are documents, not API operations.
  "openapi[.]json",
  "orpc-openapi[.]json",
  "postman[.]json",
]);

// The public routes still awaiting conversion. Phase 1 left everything but
// `get_track` here; the fan-out phase removed entries as it converted them. With
// Wave B this list is EMPTY — the public surface is fully contract-first (the
// admin tier is its own later wave, carved out above, not counted here).
const PENDING_PUBLIC_OPS = new Set<string>([]);

const V1_DIR = fileURLToPath(new URL("../../routes/api/v1", import.meta.url));

// The file-route basenames actually present under /api/v1 (one level + nested),
// excluding admin (its own wave) and the `-`-prefixed non-route helpers. Used to
// keep PUBLIC_ROUTE_OPS honest: if a public route file exists with no entry, the
// enumeration is stale and the test flags it.
function listRouteBasenames(dir: string, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (entry.name === "admin") {
        continue; // The admin wave has its own coverage; not in this public net.
      }

      out.push(...listRouteBasenames(`${dir}/${entry.name}`, rel));
      continue;
    }

    if (!entry.name.endsWith(".ts") || entry.name.startsWith("-")) {
      continue;
    }

    out.push(rel.replace(/\.ts$/, ""));
  }

  return out;
}

function isCarvedOut(basename: string): boolean {
  return (
    CARVE_OUT_ROUTES.has(basename) || CARVE_OUT_ROUTE_PREFIXES.some((p) => basename.startsWith(p))
  );
}

describe("oRPC public-route contract coverage", () => {
  const converted = new Set<string>(CONTRACT_OPERATION_NAMES);

  it("converts the entire public surface (proof + pilot + Wave A + Wave B /me)", () => {
    // With Wave B the registry serves every public op — the unauth surface plus the
    // thirteen `/me` private-session ops. The converted set is exactly the public
    // route map's values (nothing pending, nothing extra). Sorted for a stable diff.
    expect([...converted].sort()).toEqual([...new Set(Object.values(PUBLIC_ROUTE_OPS))].sort());
  });

  it("accounts for every public op: converted XOR pending", () => {
    for (const op of Object.values(PUBLIC_ROUTE_OPS)) {
      const isConverted = converted.has(op);
      const isPending = PENDING_PUBLIC_OPS.has(op);

      // Exactly one must hold. Neither ⇒ a route slipped in with no contract and
      // no deliberate deferral. Both ⇒ the pending list didn't shrink on convert.
      expect(
        isConverted !== isPending,
        `${op}: must be either converted (in the contract registry) or pending, not ${
          isConverted && isPending ? "both" : "neither"
        }`,
      ).toBe(true);
    }
  });

  it("has no stale pending entries (every pending op maps to a real route)", () => {
    const knownOps = new Set(Object.values(PUBLIC_ROUTE_OPS));

    for (const op of PENDING_PUBLIC_OPS) {
      expect(knownOps.has(op), `pending op "${op}" is not a known public route`).toBe(true);
    }
  });

  it("enumerates every public route file (no undocumented routes)", () => {
    // Reduce both a documented URL path and a TanStack file basename to the same
    // canonical key — the path segments with all separators and param markers
    // stripped — so `tracks.$idOrLogId` (file) and `/tracks/{idOrLogId}` (path)
    // and `me/csrf` (nested dir) all compare equal regardless of spelling.
    const canonical = (value: string): string =>
      value.replace(/[./]/g, " ").replace(/[${}]/g, "").trim().split(/\s+/).join("/");

    const documented = new Set(
      Object.keys(PUBLIC_ROUTE_OPS).map((path) => canonical(path.split(" ")[1])),
    );

    for (const basename of listRouteBasenames(V1_DIR)) {
      if (isCarvedOut(basename)) {
        continue;
      }

      expect(
        documented.has(canonical(basename)),
        `route file "${basename}" has no entry in PUBLIC_ROUTE_OPS — document it (with its canonical verb_noun) or add it as a carve-out`,
      ).toBe(true);
    }
  });
});
