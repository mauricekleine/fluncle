import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES, CONTRACT_OPERATION_ROUTES } from "@fluncle/contracts/orpc";

const PUBLIC_ROUTE_OPS: Record<string, string> = {
  "DELETE /devices/{token}": "deregister_device",
  "DELETE /follow-digest/follows/{id}": "delete_digest_follow",
  "DELETE /me/follows/{id}": "delete_private_follow",
  "DELETE /me/rec-seeds/{trackId}": "delete_private_rec_seed",
  "DELETE /me/saved-findings/{trackId}": "unsave_private_finding",
  "DELETE /me/saved-sets/{id}": "delete_private_saved_set",
  "GET /albums": "list_albums",
  "GET /albums/{slug}": "get_album",
  "GET /artists": "list_artists",
  "GET /artists/similar": "list_similar_artists",
  "GET /artists/{slug}": "get_artist",
  "GET /findings": "list_findings",
  "GET /follow-digest/follows": "list_digest_follows",
  "GET /galaxies": "list_galaxies",
  "GET /galaxies/{slug}": "get_galaxy",
  "GET /graph/{kind}/{slug}": "get_graph_preview",
  "GET /health": "get_health",
  "GET /labels": "list_labels",
  "GET /labels/{slug}": "get_label",
  "GET /me": "get_current_private_user",
  "GET /me/csrf": "get_private_mutation_token",
  "GET /me/export/{exportId}": "get_private_account_export",
  "GET /me/follows": "list_private_follows",
  "GET /me/frontier-editions": "list_private_frontier_editions",
  "GET /me/frontier-editions/{number}": "get_private_frontier_edition",
  "GET /me/frontier-playlist": "get_private_frontier_playlist",
  "GET /me/galaxy-collection": "list_private_galaxy_collection",
  "GET /me/galaxy-progress": "get_private_galaxy_progress",
  "GET /me/preferences": "get_private_preferences",
  "GET /me/rec-seeds": "list_private_rec_seeds",
  "GET /me/recommendations": "list_private_recommendations",
  "GET /me/saved-findings": "list_private_saved_findings",
  "GET /me/saved-sets": "list_private_saved_sets",
  "GET /me/submissions": "list_private_submissions",
  "GET /mix/artists": "list_mixable_artists",
  "GET /mix/openers": "list_mix_openers",
  "GET /mix/set-tracks": "list_set_tracks",
  "GET /mixtapes": "list_mixtapes",
  "GET /newsletter/editions": "list_editions",
  "GET /newsletter/editions/{number}": "get_edition",
  "GET /radio/now-playing": "get_radio_now_playing",
  "GET /radio/random": "get_random_radio_track",
  "GET /reach/stats": "list_platform_stats",
  "GET /replica/token": "get_replica_token",
  "GET /search": "search_tracks",
  "GET /search/archive": "search_archive",
  "GET /stories": "list_stories",
  "GET /tracks": "list_tracks",
  "GET /tracks/fresh": "list_fresh",
  "GET /tracks/random": "get_random_track",
  "GET /tracks/{idOrLogId}": "get_track",
  "GET /tracks/{idOrLogId}/mixable": "list_mixable_tracks",
  "GET /tracks/{idOrLogId}/similar": "list_similar_tracks",
  "PATCH /me/preferences": "update_private_preferences",
  "PATCH /me/profile": "update_private_profile",
  "PATCH /me/saved-sets/{id}": "update_private_saved_set",
  "POST /devices": "register_device",
  "POST /follow-digest/subscribe": "subscribe_follow_digest",
  "POST /follow-digest/unsubscribe": "unsubscribe_follow_digest",
  "POST /me/delete": "delete_private_account",
  "POST /me/export": "export_private_account_data",
  "POST /me/follows": "save_private_follow",
  "POST /me/frontier-playlist": "mint_private_frontier_playlist",
  "POST /me/galaxy-progress/logs": "collect_private_galaxy_log",
  "POST /me/rec-seeds": "save_private_rec_seed",
  "POST /me/saved-findings": "save_private_finding",
  "POST /me/saved-sets": "save_private_set",
  "POST /newsletter": "subscribe_newsletter",
  "POST /submissions": "submit_track",
  "PUT /me/galaxy-progress": "merge_private_galaxy_progress",
};

const CARVE_OUT_ROUTE_PREFIXES = ["auth/"];

const CARVE_OUT_ROUTES = new Set([
  "chat",
  "follow-digest/unsubscribe",

  "me/avatar",
  "mixtape-cover.$logId",
  "og.$logId",

  "og.hub",
  "preview.$idOrLogId",

  "openapi[.]json",
  "postman[.]json",

  "og.set",

  "status",
]);

const PENDING_PUBLIC_OPS = new Set<string>([]);

const API_DIR = fileURLToPath(new URL("../../routes/api", import.meta.url));
const V1_DIR = `${API_DIR}/v1`;

const PUBLIC_ROUTE_DIRS = [V1_DIR, API_DIR];

const SKIPPED_DIRS = new Set(["admin", "v1"]);

function listRouteBasenames(dir: string, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) {
        continue;
      }

      out.push(...listRouteBasenames(`${dir}/${entry.name}`, rel));
      continue;
    }

    if (
      !entry.name.endsWith(".ts") ||
      entry.name.startsWith("-") ||
      entry.name.includes(".test.")
    ) {
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

function isAdminPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/");
}

describe("oRPC public-route contract coverage", () => {
  const converted = new Set<string>(CONTRACT_OPERATION_NAMES);

  it("converts the entire public surface (proof + pilot + Wave A + Wave B /me)", () => {
    const publicOps = new Set(Object.values(PUBLIC_ROUTE_OPS));

    for (const op of publicOps) {
      expect(converted.has(op), `public op "${op}" is missing from the contract registry`).toBe(
        true,
      );
    }
  });

  it("holds EXACTLY the public ops (no non-admin op outside the map)", () => {
    const publicOps = new Set(Object.values(PUBLIC_ROUTE_OPS));

    for (const op of CONTRACT_OPERATION_NAMES) {
      const route = CONTRACT_OPERATION_ROUTES[op];

      if (!route) {
        expect.fail(`contract op "${op}" declares no route — it is outside both coverage nets`);
      }

      if (isAdminPath(route.path) || publicOps.has(op)) {
        continue;
      }

      expect.fail(
        `contract op "${op}" (${route.method} ${route.path}) is in the registry but absent from PUBLIC_ROUTE_OPS — document it here (or move it to an /admin path)`,
      );
    }
  });

  it("accounts for every public op: converted XOR pending", () => {
    for (const op of Object.values(PUBLIC_ROUTE_OPS)) {
      const isConverted = converted.has(op);
      const isPending = PENDING_PUBLIC_OPS.has(op);

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
    const canonical = (value: string): string =>
      value.replace(/[./]/g, " ").replace(/[${}]/g, "").trim().split(/\s+/).join("/");

    const documented = new Set(
      Object.keys(PUBLIC_ROUTE_OPS).map((path) => canonical(path.split(" ")[1] ?? path)),
    );

    for (const basename of PUBLIC_ROUTE_DIRS.flatMap((dir) => listRouteBasenames(dir))) {
      if (isCarvedOut(basename)) {
        continue;
      }

      expect(
        documented.has(canonical(basename)),
        `route file "${basename}" has no entry in PUBLIC_ROUTE_OPS — document it (with its canonical verb_noun) or add it as a carve-out`,
      ).toBe(true);
    }
  });

  it("every carve-out still maps to a real route (no stale carve-out)", () => {
    const present = new Set(PUBLIC_ROUTE_DIRS.flatMap((dir) => listRouteBasenames(dir)));

    for (const carved of CARVE_OUT_ROUTES) {
      expect(present.has(carved), `carve-out "${carved}" no longer maps to a real route`).toBe(
        true,
      );
    }

    for (const prefix of CARVE_OUT_ROUTE_PREFIXES) {
      expect(
        [...present].some((basename) => basename.startsWith(prefix)),
        `carve-out prefix "${prefix}" no longer matches any route`,
      ).toBe(true);
    }
  });

  it("walks the BARE /api top level, not just /api/v1", () => {
    const bare = listRouteBasenames(API_DIR);

    expect(bare).toContain("og.set");
    expect(bare).toContain("og.hub");

    expect(bare.some((basename) => basename.startsWith("v1/"))).toBe(false);

    expect(bare.some((basename) => basename.startsWith("admin/"))).toBe(false);
  });
});
