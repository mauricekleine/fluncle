import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_OPERATION_NAMES } from "@fluncle/contracts/orpc";

// Coverage scaffold for the oRPC migration. It enumerates the PUBLIC HTTP API
// routes and asserts
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
  // The devices domain is contract-only oRPC (no TanStack route file under
  // /api/v1) — the mobile app's push-device registry, authored contract-first.
  // It has no file-enumeration entry; it lives here
  // so the "every public op is converted" check covers it.
  "DELETE /devices/{token}": "deregister_device",
  // The recommendation-seed domain (docs/the-ear.md § The per-user telescopes) —
  // contract-only oRPC (no TanStack route file under /api/v1/me); documented here
  // as part of the public surface net.
  "DELETE /me/rec-seeds/{trackId}": "delete_private_rec_seed",
  "DELETE /me/saved-findings/{trackId}": "unsave_private_finding",
  // The albums domain — contract-only oRPC (the catalogue-browse API). No TanStack route
  // file under /api/v1/albums; oRPC serves these straight off the registry. Public reads,
  // catalogue-scoped + paginated, no auth.
  "GET /albums": "list_albums",
  "GET /albums/{slug}": "get_album",
  // The artists domain — contract-only oRPC (Unit 4 of the artist-relationship RFC).
  // No TanStack route file under /api/v1/artists; oRPC serves these straight off the
  // registry. Public reads (now catalogue-scoped + paginated), no auth required.
  "GET /artists": "list_artists",
  // The "sounds like these" multi-artist sonic read. A literal `/artists/similar` path — it takes
  // precedence over `/artists/{slug}` the same way `/tracks/random` does over `/tracks/{idOrLogId}`.
  "GET /artists/similar": "list_similar_artists",
  "GET /artists/{slug}": "get_artist",
  // The galaxies domain — contract-only oRPC (browse-by-feel RFC). No TanStack route
  // file under /api/v1/galaxies; oRPC serves these straight off the registry. Public
  // reads, no auth. (The game's `/galaxy` route + galaxy.fluncle.com are unrelated.)
  "GET /galaxies": "list_galaxies",
  "GET /galaxies/{slug}": "get_galaxy",
  // The graph domain — the GraphLink hover card's one read. Contract-only oRPC, public,
  // no auth. Lazy per-entity (fetched on card open, cached by `(kind, slug)`), which is
  // why one op serves every graph link in the app without an N+1.
  "GET /graph/{kind}/{slug}": "get_graph_preview",
  "GET /health": "get_health",
  // The labels domain — contract-only oRPC (the catalogue-browse API). No TanStack route
  // file under /api/v1/labels; oRPC serves these straight off the registry. Public reads,
  // catalogue-scoped + paginated, blind to seed_state (crawl scope, never storage), no auth.
  "GET /labels": "list_labels",
  "GET /labels/{slug}": "get_label",
  "GET /me": "get_current_private_user",
  "GET /me/csrf": "get_private_mutation_token",
  "GET /me/export/{exportId}": "get_private_account_export",
  // The frozen Frontier editions history — contract-only oRPC (no TanStack route file
  // under /api/v1/me), documented here as part of the public surface net. Private-session
  // at the op (the session read scopes by user); zero editions is a clean empty array.
  "GET /me/frontier-editions": "list_private_frontier_editions",
  "GET /me/frontier-editions/{number}": "get_private_frontier_edition",
  "GET /me/galaxy-progress": "get_private_galaxy_progress",
  // The cross-device preferences store — contract-only oRPC (no TanStack route file
  // under /api/v1/me), documented here as part of the public surface net.
  "GET /me/preferences": "get_private_preferences",
  "GET /me/rec-seeds": "list_private_rec_seeds",
  "GET /me/recommendations": "list_private_recommendations",
  "GET /me/saved-findings": "list_private_saved_findings",
  "GET /me/submissions": "list_private_submissions",
  "GET /mixtapes": "list_mixtapes",
  // The newsletter archive reads.
  // Contract-only oRPC — there is no TanStack route file under /api/v1/newsletter
  // (oRPC serves them off the registry), so they have no route-file basename to
  // enumerate; documented here as part of the public surface net.
  "GET /newsletter/editions": "list_editions",
  "GET /newsletter/editions/{number}": "get_edition",
  // The cycling station's reads. Contract-only — there is no TanStack alias file
  // under /api/v1/radio (oRPC serves them straight off the registry), so they have
  // no route-file basename to enumerate; documented here as part of the public
  // surface net. `now-playing` is the shared-broadcast clock (the radio-broadcast
  // RFC, Unit A); `random` is the kept fallback (RFC Unit B).
  "GET /radio/now-playing": "get_radio_now_playing",
  "GET /radio/random": "get_random_radio_track",
  "GET /search": "search_tracks",
  // Fluncle's OWN search — the archive, not Spotify (lib/server/search.ts). Contract-only
  // oRPC (no TanStack route file under /api/v1/search), so it has no route-file basename to
  // enumerate; documented here as part of the public surface net.
  "GET /search/archive": "search_archive",
  "GET /stories": "list_stories",
  "GET /tracks": "list_tracks",
  "GET /tracks/fresh": "list_fresh",
  "GET /tracks/random": "get_random_track",
  "GET /tracks/{idOrLogId}": "get_track",
  // The `/mix` set-builder rail (RFC mixability-engine). Contract-only oRPC — no
  // TanStack route file under /api/v1/tracks (oRPC serves it straight off the
  // registry), so it has no route-file basename to enumerate; documented here as part
  // of the public surface net. Public-unauth at the op; the `/mix` PAGE is admin-gated
  // at launch (Decision 1), a pure route-level flip to lift.
  "GET /tracks/{idOrLogId}/mixable": "list_mixable_tracks",
  // The "more like this" sonic-neighbour read (docs/track-lifecycle.md). Contract-only
  // oRPC — no TanStack route file under /api/v1/tracks (oRPC serves it straight off the
  // registry), so it has no route-file basename to enumerate; documented here as part of
  // the public surface net.
  "GET /tracks/{idOrLogId}/similar": "get_similar_findings",
  "PATCH /me/preferences": "update_private_preferences",
  "PATCH /me/profile": "update_private_profile",
  "POST /devices": "register_device",
  "POST /me/delete": "delete_private_account",
  "POST /me/export": "export_private_account_data",
  // The only `/me/galaxy-progress/logs` op is this POST collect-one (the game's
  // per-find write → `collectLogId`); there is no list-logs op, so it is named for
  // what it does (see ../orpc/me-galaxy.ts — oRPC owns the path directly now).
  "POST /me/galaxy-progress/logs": "collect_private_galaxy_log",
  "POST /me/rec-seeds": "save_private_rec_seed",
  "POST /me/saved-findings": "save_private_finding",
  "POST /newsletter": "subscribe_newsletter",
  "POST /submissions": "submit_track",
  "PUT /me/galaxy-progress": "merge_private_galaxy_progress",
};

// Routes that stay on TanStack by design (carve-outs): OAuth browser-redirect
// callbacks, and binary/image render
// endpoints that emit non-JSON bytes. These are NOT counted against coverage —
// they will never have a contract — but they ARE listed so the enumeration is
// total and a new carve-out is a deliberate edit here, not an omission.
const CARVE_OUT_ROUTE_PREFIXES = [
  "auth/", // Spotify/YouTube/Mixcloud/Last.fm OAuth callbacks → browser redirects.
];

// Binary/render routes: emit images/audio, not RPC JSON. Carved out like OAuth.
const CARVE_OUT_ROUTES = new Set([
  // ChatDnB's crew door (POST /api/chat) — a STREAMING carve-out (AGENTS.md): the
  // response is an open AI SDK UIMessage stream, not a single RPC JSON body, exactly
  // like the admin sibling /api/admin/chat. Never an oRPC op; the safety rails
  // (session, emailVerified, origin/CSRF, the two rate dials) live in the route.
  "chat",
  // The account portrait upload — a large-body/direct-upload carve-out (AGENTS.md):
  // it RECEIVES image bytes (a downscaled ≤512² avatar), not an RPC JSON body, and
  // PUTs them to R2. Never an oRPC op; the safety rails (session, CSRF, rate-limit,
  // type/size/dimension validation) live in the route + lib/server/avatar.ts.
  "me/avatar",
  "mixtape-cover.$logId",
  "og.$logId",
  "preview.$idOrLogId",
  // The generated-spec + tooling surfaces are documents, not API operations.
  "openapi[.]json",
  "postman[.]json",
  // The machine-readable status read — the JSON sibling of the /status HTML
  // dashboard (../../routes/api/status.ts). A public resource read like /api/health,
  // deliberately NOT an oRPC operation: it just echoes the already-public
  // `service_status` snapshot for a poller (the rave-01 watchdog reads its
  // `secondsSinceFreshestReport`), so it carries no contract and stays carved out.
  "status",
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
    // thirteen `/me` private-session ops. Every public op must be converted (a
    // SUBSET check, not equality: the registry also holds admin ops now — the admin
    // wave's pilot — which the sibling orpc-admin-coverage.test.ts is the net for).
    const publicOps = new Set(Object.values(PUBLIC_ROUTE_OPS));

    for (const op of publicOps) {
      expect(converted.has(op), `public op "${op}" is missing from the contract registry`).toBe(
        true,
      );
    }
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
      Object.keys(PUBLIC_ROUTE_OPS).map((path) => canonical(path.split(" ")[1] ?? path)),
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
